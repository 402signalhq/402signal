"""Opt-in PostgreSQL replay authority. No DDL, fallback, takeover, or automatic retry.

All writes commit synchronously. An ambiguous commit is an unavailable authority,
not permission to repeat admission. Deployment still has ONE router/log writer.
The driver is optional; the existing SQLite image remains unchanged.
"""
from __future__ import annotations

from contextlib import contextmanager, nullcontext
import math
import os
import re
import threading
import time

from live402.replay_store import StoreError

STATES = frozenset({"settlement_pending", "unknown", "settled", "not_settled", "rejected"})
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
MAX_OUTCOME = 256 * 1024
# Recycle only before a separate operation, never inside a transaction.
MAX_CONNECTION_AGE = 600
MAX_CONNECTION_IDLE = 300
# Bounded per-process pool. Concurrent paid requests no longer queue behind one
# connection; a request that cannot get a connection within POOL_WAIT seconds
# fails closed as an unavailable authority instead of piling up.
DEFAULT_POOL_SIZE = 8
MAX_POOL_SIZE = 32
POOL_WAIT = 5.0
# Applied inside every transaction. Unnamed statements work with transaction
# poolers; nothing here survives the transaction.
SESSION_SETTINGS = (
    "SET LOCAL statement_timeout = '2000ms'",
    "SET LOCAL lock_timeout = '1000ms'",
    "SET LOCAL idle_in_transaction_session_timeout = '3000ms'",
    "SET LOCAL synchronous_commit = 'on'",
)
# Owner migrations installed after the router started are detected by name
# and re-checked every ten minutes.
FEATURE_PROBES = {
    "expiry": ("SELECT to_regprocedure('signal_replay.api_expire_identities(text,integer)') IS NOT NULL "
               "AND to_regprocedure('signal_replay.api_reserve_v2(text,text,text,double precision,double precision)') "
               "IS NOT NULL"),
    "capacity": "SELECT to_regprocedure('signal_replay.api_capacity(text)') IS NOT NULL",
    "outbox": ("SELECT to_regprocedure('signal_replay.api_outbox_put(text,bytea,bytea,text)') IS NOT NULL "
               "AND to_regprocedure('signal_replay.api_outbox_ack(text,bigint,bigint)') IS NOT NULL"),
}


def validate_settings(environ, parse_dsn) -> tuple[dict, str]:
    """Parse operator configuration; never print its contents on errors."""
    try:
        authority = environ.get("LIVE402_REPLAY_AUTHORITY_ID", "")
        if not re.fullmatch(r"[0-9a-f]{32}", authority):
            raise ValueError()
        raw = environ.get("LIVE402_REPLAY_POSTGRES_DSN", "")
        if not raw or len(raw) > 4096:
            raise ValueError()
        cfg = parse_dsn(raw)
        allowed = {"host", "port", "dbname", "user", "password", "sslmode", "sslrootcert", "channel_binding"}
        if set(cfg) - allowed:
            raise ValueError()
        host = cfg.get("host", "")
        if not re.fullmatch(r"[a-zA-Z0-9.-]+", host) or not cfg.get("dbname") or not cfg.get("user"):
            raise ValueError()
        if not 1 <= int(cfg.get("port", "5432")) <= 65535:
            raise ValueError()
        on_fly = any(environ.get(k) for k in ("FLY_APP_NAME", "FLY_ALLOC_ID", "FLY_MACHINE_ID"))
        local_test = (environ.get("LIVE402_PG_TEST_SUPPORT") == "1" and not on_fly
                      and host in {"localhost", "127.0.0.1"})
        if not local_test and cfg.get("sslmode") != "verify-full":
            raise ValueError()
        if local_test and cfg.get("sslmode") not in {"disable", "verify-full"}:
            raise ValueError()
        # Do not silently turn on multiple routers: catalog/history/PQ ordering
        # are still process-local in this release.
        if environ.get("LIVE402_ROUTER_WRITERS", "1") != "1":
            raise ValueError()
        if environ.get("LIVE402_REPLAY_POSTGRES_API", "direct") not in {"direct", "functions-v1"}:
            raise ValueError()
        pool = (environ.get("LIVE402_REPLAY_POOL_SIZE") or "").strip()
        if pool and (not re.fullmatch(r"[0-9]{1,2}", pool) or not 1 <= int(pool) <= MAX_POOL_SIZE):
            raise ValueError()
        return cfg, authority
    except Exception:
        raise StoreError("invalid PostgreSQL replay configuration") from None


class _Slot:
    """One pooled connection with its lifetime bookkeeping."""
    __slots__ = ("conn", "connected_at", "last_used")

    def __init__(self):
        self.conn = None
        self.connected_at = 0.0
        self.last_used = 0.0


class PostgresStore:
    """A bounded pool of connections per process.

    A checked-out connection runs exactly one replay operation. A lost or
    failed connection is discarded, and only a subsequent separate operation
    reconnects. No failed operation is automatically replayed. Age and idle
    limits are checked when a connection is checked out, never inside a
    transaction.
    """
    def __init__(self, environ=None, driver=None):
        env = os.environ if environ is None else environ
        try:
            if driver is None:
                import psycopg as driver
            from psycopg.conninfo import conninfo_to_dict
            self.config, self.authority = validate_settings(env, conninfo_to_dict)
        except StoreError:
            raise
        except Exception:
            raise StoreError("PostgreSQL replay driver unavailable") from None
        self.pool_size = int((env.get("LIVE402_REPLAY_POOL_SIZE") or "").strip() or DEFAULT_POOL_SIZE)
        self.functions_api = env.get("LIVE402_REPLAY_POSTGRES_API", "direct") == "functions-v1"
        self.driver = driver
        self.lock = threading.Lock()
        self.available = threading.Condition(self.lock)
        self.idle: list[_Slot] = []
        self.open_count = 0
        self.last: _Slot | None = None
        self.last_prune = 0.0
        self.features: dict[str, tuple[bool, float]] = {}

    @property
    def conn(self):
        """The most recently used connection, or None once it was discarded."""
        slot = self.last
        return None if slot is None else slot.conn

    def close(self):
        with self.available:
            idle, self.idle = self.idle, []
            self.open_count -= len(idle)
            self.available.notify_all()
        for slot in idle:
            self._close_slot(slot)

    @staticmethod
    def _close_slot(slot):
        conn, slot.conn = slot.conn, None
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass

    def _discard(self, slot):
        """Drop a connection after any failure; the release decrements the pool."""
        self._close_slot(slot)

    def _acquire(self) -> _Slot:
        deadline = time.monotonic() + POOL_WAIT
        with self.available:
            while True:
                now = time.monotonic()
                while self.idle:
                    slot = self.idle.pop()
                    if (slot.conn is None or slot.conn.closed
                            or now - slot.connected_at >= MAX_CONNECTION_AGE
                            or now - slot.last_used >= MAX_CONNECTION_IDLE):
                        self.open_count -= 1
                        self._close_slot(slot)
                        continue
                    return slot
                if self.open_count < self.pool_size:
                    self.open_count += 1
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not self.available.wait(remaining):
                    raise StoreError("replay authority unavailable")
        slot = _Slot()
        try:
            slot.conn = self.driver.connect(
                **self.config, autocommit=True, connect_timeout=2,
                application_name="402signal-replay", prepare_threshold=None)
        except Exception:
            with self.available:
                self.open_count -= 1
                self.last = slot
                self.available.notify()
            raise StoreError("replay authority unavailable") from None
        slot.connected_at = slot.last_used = time.monotonic()
        return slot

    def _release(self, slot):
        with self.available:
            self.last = slot
            if slot.conn is None:
                self.open_count -= 1
            else:
                slot.last_used = time.monotonic()
                self.idle.append(slot)
            self.available.notify()

    @contextmanager
    def _checkout(self):
        slot = self._acquire()
        try:
            yield slot
        finally:
            self._release(slot)

    @contextmanager
    def _transaction(self, *, capacity=False, write_meta=False, guarded_api=False):
        """A multi-statement transaction for reads, readiness and maintenance."""
        with self._checkout() as slot:
            try:
                conn = slot.conn
                # Pipeline only this one replay operation. Its COMMIT still
                # synchronizes and must be acknowledged before returning.
                # No payment, reservation or other request shares this commit.
                pipeline = conn.pipeline() if self.functions_api else nullcontext()
                with pipeline, conn.transaction():
                    for statement in SESSION_SETTINGS:
                        conn.execute(statement)
                    # Owner write functions check the same durable primary,
                    # activation, instance fence, role and capacity inside the
                    # mutation. Repeating those queries here adds round trips.
                    # Reads and the direct API retain their explicit checks.
                    if not (self.functions_api and guarded_api):
                        safe = conn.execute("SELECT NOT pg_is_in_recovery(), "
                                            "current_setting('fsync'), current_setting('full_page_writes')").fetchone()
                        if safe != (True, 'on', 'on'):
                            raise StoreError("replay authority is not durable primary")
                        if self.functions_api:
                            row = conn.execute(
                                "SELECT authority_id,schema_version,active,legacy_ready,admitted,max_rows,max_bytes,outcome_bytes "
                                "FROM signal_replay.api_authority(%s,%s,%s)",
                                (self.authority,capacity,write_meta)).fetchone()
                        else:
                            row = conn.execute(
                                "SELECT authority_id,schema_version,active,legacy_ready,admitted,max_rows,max_bytes,outcome_bytes "
                                "FROM signal_replay.authority WHERE singleton = TRUE"
                                + (" FOR UPDATE" if capacity or write_meta else " FOR SHARE")
                            ).fetchone()
                        if not row or row[:4] != (self.authority, 1, True, True):
                            raise StoreError("replay authority not activated")
                        if capacity and (row[4] >= row[5] or (row[4]+1)*512+row[7] > row[6]):
                            raise StoreError("replay authority capacity exhausted")
                    yield conn
                # Returning from the context means COMMIT was acknowledged.
            except Exception:
                self._discard(slot)
                raise StoreError("replay authority unavailable") from None

    def _call(self, statement, params):
        """One owner-function call as one pipelined round trip.

        BEGIN, the session settings, the call and COMMIT are queued together and
        synchronized once; the result is read only after the commit was
        acknowledged. The function performs the fence, activation, role and
        capacity checks itself. Any failure discards the connection and is
        never retried.
        """
        with self._checkout() as slot:
            try:
                conn = slot.conn
                with conn.pipeline(), conn.transaction():
                    for setting in SESSION_SETTINGS:
                        conn.execute(setting)
                    cursor = conn.execute(statement, params)
                return cursor.fetchone()
            except Exception:
                self._discard(slot)
                raise StoreError("replay authority unavailable") from None

    def lookup(self, key):
        self._key(key)
        with self._transaction() as conn:
            return conn.execute(
                "SELECT state,outcome_json,fingerprint_version,scope_hash,expires_at "
                "FROM signal_replay.entries WHERE fp_hash = %s", (key,)).fetchone()

    def _feature(self, name, conn=None):
        """True once the owner installed the migration that defines the named API."""
        now = time.monotonic()
        cached = self.features.get(name)
        if cached is not None and now - cached[1] <= 600:
            return cached[0]
        if conn is None:
            with self._transaction() as own:
                present = bool(own.execute(FEATURE_PROBES[name]).fetchone()[0])
        else:
            present = bool(conn.execute(FEATURE_PROBES[name]).fetchone()[0])
        self.features[name] = (present, now)
        return present

    def _expiry_api(self, conn=None):
        """True once the owner installed ops/replay-postgres-identity-expiry.sql."""
        return self._feature("expiry", conn)

    def reserve(self, key, scope, expires, authorization_expires=None):
        self._key(key)
        if scope is not None:
            self._key(scope)
        if isinstance(expires, bool) or not isinstance(expires, (int, float)) or not math.isfinite(expires):
            raise StoreError("invalid replay expiry")
        if (isinstance(authorization_expires, bool) or not isinstance(authorization_expires, (int, float))
                or not math.isfinite(authorization_expires) or authorization_expires < 0):
            authorization_expires = None
        if self.functions_api:
            if authorization_expires is not None and self._expiry_api():
                row = self._call("SELECT signal_replay.api_reserve_v2(%s,%s,%s,%s,%s)",
                                 (self.authority,key,scope,expires,authorization_expires))
            else:
                row = self._call("SELECT signal_replay.api_reserve(%s,%s,%s,%s)",
                                 (self.authority,key,scope,expires))
            return bool(row[0])
        admitted = False
        with self._transaction(capacity=True) as conn:
            # Unique identity is authoritative even if an earlier read saw none.
            inserted = conn.execute(
                "INSERT INTO signal_replay.entries "
                "(fp_hash,state,outcome_json,created_at,fingerprint_version,scope_hash,expires_at) "
                "VALUES (%s,'settlement_pending',NULL,%s,2,%s,%s) "
                "ON CONFLICT (fp_hash) DO NOTHING RETURNING fp_hash",
                (key, time.time(), scope, expires)).fetchone()
            if inserted:
                quota = conn.execute(
                    "UPDATE signal_replay.authority SET admitted = admitted + 1 "
                    "WHERE singleton = TRUE AND admitted < max_rows RETURNING admitted").fetchone()
                if not quota:
                    raise StoreError("replay authority capacity exhausted")
                admitted = True
        return admitted

    def finish(self, key, state, outcome, keep):
        self._key(key)
        if state not in STATES:
            raise StoreError("invalid replay state")
        if outcome is not None and (not isinstance(outcome, str) or len(outcome.encode()) > MAX_OUTCOME):
            raise StoreError("invalid replay outcome")
        if self.functions_api:
            self._call("SELECT signal_replay.api_finish(%s,%s,%s,%s,%s)",
                       (self.authority,key,state,outcome,keep))
            return
        with self._transaction(write_meta=True) as conn:
            row = conn.execute(
                "SELECT e.outcome_json,e.scope_hash,e.expires_at,a.admitted,a.outcome_bytes,a.max_bytes "
                "FROM signal_replay.entries e CROSS JOIN signal_replay.authority a "
                "WHERE e.fp_hash=%s AND e.state IN ('settlement_pending','unknown') AND a.singleton",
                (key,)).fetchone()
            if row is None:
                raise StoreError("replay completion identity unavailable")
            prior = len(row[0].encode()) if row[0] is not None else 0
            wanted = outcome if keep and row[1] and row[2] and row[2] > time.time() else None
            size = len(wanted.encode()) if wanted is not None else 0
            if row[3]*512+row[4]-prior+size > row[5]:
                wanted, size = None, 0
            conn.execute("UPDATE signal_replay.entries SET state=%s,outcome_json=%s WHERE fp_hash=%s",
                         (state,wanted,key))
            conn.execute("UPDATE signal_replay.authority SET outcome_bytes=outcome_bytes-%s+%s WHERE singleton",
                         (prior,size))

    def abandon(self, key):
        self._key(key)
        if self.functions_api:
            self._call("SELECT signal_replay.api_abandon(%s,%s)", (self.authority,key))
            return
        with self._transaction() as conn:
            conn.execute("UPDATE signal_replay.entries SET state='unknown' WHERE fp_hash=%s "
                         "AND state IN ('settlement_pending','unknown')", (key,))

    def ready(self):
        try:
            # Expired private bodies must still be pruned when admission is
            # full. Capacity exhaustion is not a reason to retain responses.
            self.prune_outcomes()
            with self._transaction(capacity=True, guarded_api=True) as conn:
                # Test write permissions without publishing another economic row.
                with conn.transaction(force_rollback=True):
                    if self.functions_api:
                        conn.execute("SELECT signal_replay.api_ready(%s)",(self.authority,))
                    else:
                        conn.execute("UPDATE signal_replay.authority SET admitted=admitted WHERE singleton=TRUE")
            return True
        except StoreError:
            return False

    def capacity(self):
        """(admitted, max_rows, max_bytes, outcome_bytes) for operator alerts only."""
        with self._transaction() as conn:
            if self.functions_api and self._feature("capacity", conn):
                row = conn.execute(
                    "SELECT admitted,max_rows,max_bytes,outcome_bytes "
                    "FROM signal_replay.api_capacity(%s)", (self.authority,)).fetchone()
            elif self.functions_api:
                row = conn.execute(
                    "SELECT admitted,max_rows,max_bytes,outcome_bytes "
                    "FROM signal_replay.api_authority(%s,false,false)", (self.authority,)).fetchone()
            else:
                row = conn.execute(
                    "SELECT admitted,max_rows,max_bytes,outcome_bytes "
                    "FROM signal_replay.authority WHERE singleton = TRUE").fetchone()
        if not row:
            raise StoreError("replay authority capacity unavailable")
        return tuple(int(value) for value in row)

    def expire_identities(self, batch=1000):
        """Drop long-expired terminal identities. 0 before the owner migration or in direct mode."""
        if not self.functions_api:
            return 0
        with self._transaction(write_meta=True, guarded_api=True) as conn:
            if not self._expiry_api(conn):
                return 0
            return int(conn.execute("SELECT signal_replay.api_expire_identities(%s,%s)",
                                    (self.authority, max(1, min(10000, int(batch))))).fetchone()[0])

    def prune_outcomes(self):
        # Expiry removes private bodies, never economic identities.
        now = time.monotonic()
        if now - self.last_prune < 30:
            return
        with self._transaction(write_meta=True, guarded_api=True) as conn:
            if self.functions_api:
                conn.execute("SELECT signal_replay.api_prune(%s)",(self.authority,))
            else:
                removed = conn.execute(
                    "WITH expired AS (SELECT fp_hash,octet_length(outcome_json) AS bytes FROM signal_replay.entries "
                    "WHERE outcome_json IS NOT NULL AND (expires_at IS NULL OR expires_at<=%s) "
                    "ORDER BY expires_at NULLS FIRST LIMIT 1000 FOR UPDATE SKIP LOCKED), "
                    "cleared AS (UPDATE signal_replay.entries e SET outcome_json=NULL FROM expired x "
                    "WHERE e.fp_hash=x.fp_hash RETURNING e.fp_hash) "
                    "SELECT coalesce(sum(x.bytes),0) FROM expired x JOIN cleared c USING(fp_hash)",
                    (time.time(),)).fetchone()[0]
                conn.execute("UPDATE signal_replay.authority SET outcome_bytes=outcome_bytes-%s WHERE singleton",(removed,))
        self.last_prune = now

    # Transparency-leaf outbox (ops/replay-postgres-leaf-outbox.sql). Public
    # leaf bytes only; the functions re-check the leaf hash and every guard.

    def outbox_supported(self):
        return bool(self.functions_api and self._feature("outbox"))

    def outbox_put(self, body, leaf_hash, queued_by):
        if not isinstance(body, (bytes, bytearray)) or not 1 <= len(body) <= 65536:
            raise StoreError("invalid replay operation")
        if not isinstance(leaf_hash, (bytes, bytearray)) or len(leaf_hash) != 32:
            raise StoreError("invalid replay operation")
        if not isinstance(queued_by, str) or not 1 <= len(queued_by) <= 128:
            raise StoreError("invalid replay operation")
        if not self.outbox_supported():
            raise StoreError("leaf outbox unsupported")
        row = self._call("SELECT id, duplicate, appended_idx FROM signal_replay.api_outbox_put(%s,%s,%s,%s)",
                         (self.authority, bytes(leaf_hash), bytes(body), queued_by))
        if not row:
            raise StoreError("replay authority unavailable")
        return {"id": int(row[0]), "duplicate": bool(row[1]),
                "appended_idx": None if row[2] is None else int(row[2])}

    def outbox_pending(self, batch=200):
        if not self.outbox_supported():
            return []
        with self._transaction(guarded_api=True) as conn:
            rows = conn.execute("SELECT id, leaf_hash, body FROM signal_replay.api_outbox_pending(%s,%s)",
                                (self.authority, max(1, min(1000, int(batch))))).fetchall()
        return [(int(row[0]), bytes(row[1]), bytes(row[2])) for row in rows]

    def outbox_ack(self, row_id, idx):
        if not self.outbox_supported():
            raise StoreError("leaf outbox unsupported")
        row = self._call("SELECT signal_replay.api_outbox_ack(%s,%s,%s)", (self.authority, int(row_id), int(idx)))
        return bool(row and row[0])

    def outbox_depth(self):
        if not self.outbox_supported():
            return (0, 0.0)
        with self._transaction(guarded_api=True) as conn:
            row = conn.execute("SELECT pending, oldest_age_s FROM signal_replay.api_outbox_depth(%s)",
                               (self.authority,)).fetchone()
        return (int(row[0]), float(row[1])) if row else (0, 0.0)

    def outbox_prune(self, older_than_days=14):
        if not self.outbox_supported():
            return 0
        row = self._call("SELECT signal_replay.api_outbox_prune(%s,%s)",
                         (self.authority, max(1, min(365, int(older_than_days)))))
        return int(row[0]) if row else 0

    @staticmethod
    def _key(key):
        if not isinstance(key, str) or not HEX64.fullmatch(key):
            raise StoreError("invalid replay identity")
