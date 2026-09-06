"""Opt-in PostgreSQL replay authority. No DDL, fallback, takeover, or automatic retry.

All writes commit synchronously. An ambiguous commit is an unavailable authority,
not permission to repeat admission. Deployment still has ONE router/log writer.
The driver is optional; the existing SQLite image remains unchanged.
"""
from __future__ import annotations

from contextlib import contextmanager
import math
import os
import re
import threading
import time

from live402.replay_store import StoreError

STATES = frozenset({"settlement_pending", "unknown", "settled", "not_settled", "rejected"})
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
MAX_OUTCOME = 256 * 1024


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
        return cfg, authority
    except Exception:
        raise StoreError("invalid PostgreSQL replay configuration") from None


class PostgresStore:
    """One bounded connection per process, protected by a lock.

    The adapter deliberately does not claim high-throughput pooling yet. A lost
    connection is discarded, and only a subsequent separate operation reconnects.
    No failed operation is automatically replayed.
    """
    def __init__(self, environ=None, driver=None):
        try:
            if driver is None:
                import psycopg as driver
            from psycopg.conninfo import conninfo_to_dict
            self.config, self.authority = validate_settings(
                os.environ if environ is None else environ, conninfo_to_dict)
        except StoreError:
            raise
        except Exception:
            raise StoreError("PostgreSQL replay driver unavailable") from None
        self.driver = driver
        self.conn = None
        self.lock = threading.Lock()
        self.last_prune = 0.0

    def close(self):
        with self.lock:
            self._discard()

    def _discard(self):
        conn, self.conn = self.conn, None
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass

    @contextmanager
    def _transaction(self, *, capacity=False, write_meta=False):
        with self.lock:
            try:
                if self.conn is None or self.conn.closed:
                    self.conn = self.driver.connect(**self.config, autocommit=True,
                                                    connect_timeout=2, application_name="402signal-replay")
                with self.conn.transaction():
                    self.conn.execute("SET LOCAL statement_timeout = '2000ms'")
                    self.conn.execute("SET LOCAL lock_timeout = '1000ms'")
                    self.conn.execute("SET LOCAL idle_in_transaction_session_timeout = '3000ms'")
                    self.conn.execute("SET LOCAL synchronous_commit = 'on'")
                    safe = self.conn.execute("SELECT NOT pg_is_in_recovery(), "
                                             "current_setting('fsync'), current_setting('full_page_writes')").fetchone()
                    if safe != (True, 'on', 'on'):
                        raise StoreError("replay authority is not durable primary")
                    row = self.conn.execute(
                        "SELECT authority_id,schema_version,active,legacy_ready,admitted,max_rows,max_bytes "
                        "FROM signal_replay.authority WHERE singleton = TRUE"
                        + (" FOR UPDATE" if capacity or write_meta else " FOR SHARE")
                    ).fetchone()
                    if not row or row[:4] != (self.authority, 1, True, True):
                        raise StoreError("replay authority not activated")
                    if capacity and (row[4] >= row[5] or self.conn.execute(
                            "SELECT pg_total_relation_size('signal_replay.entries')").fetchone()[0]
                                     >= row[6] - MAX_OUTCOME):
                        raise StoreError("replay authority capacity exhausted")
                    yield self.conn
                # Returning from the context means COMMIT was acknowledged.
            except Exception:
                self._discard()
                raise StoreError("replay authority unavailable") from None

    def lookup(self, key):
        self._key(key)
        with self._transaction() as conn:
            return conn.execute(
                "SELECT state,outcome_json,fingerprint_version,scope_hash,expires_at "
                "FROM signal_replay.entries WHERE fp_hash = %s", (key,)).fetchone()

    def reserve(self, key, scope, expires):
        self._key(key)
        if scope is not None:
            self._key(scope)
        if isinstance(expires, bool) or not isinstance(expires, (int, float)) or not math.isfinite(expires):
            raise StoreError("invalid replay expiry")
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
        with self._transaction(write_meta=not keep) as conn:
            if keep:
                conn.execute(
                    "UPDATE signal_replay.entries SET state=%s, outcome_json="
                    "CASE WHEN scope_hash IS NULL OR expires_at IS NULL OR expires_at <= %s THEN NULL ELSE %s END "
                    "WHERE fp_hash=%s AND state IN ('settlement_pending','unknown')",
                    (state, time.time(), outcome, key))
            else:
                # Only the existing pre-economic-action 400 path may release
                # a pending reservation. Capacity GC never deletes identities.
                removed = conn.execute("DELETE FROM signal_replay.entries WHERE fp_hash=%s "
                                       "AND state='settlement_pending' RETURNING fp_hash", (key,)).fetchone()
                if removed:
                    conn.execute("UPDATE signal_replay.authority SET admitted=admitted-1 WHERE singleton=TRUE")

    def abandon(self, key):
        self._key(key)
        with self._transaction() as conn:
            conn.execute("UPDATE signal_replay.entries SET state='unknown' WHERE fp_hash=%s "
                         "AND state IN ('settlement_pending','unknown')", (key,))

    def ready(self):
        try:
            with self._transaction(capacity=True) as conn:
                # Test write permissions without publishing another economic row.
                with conn.transaction(force_rollback=True):
                    conn.execute("UPDATE signal_replay.authority SET admitted=admitted WHERE singleton=TRUE")
            self.prune_outcomes()
            return True
        except StoreError:
            return False

    def prune_outcomes(self):
        # Bounded deletion of PRIVATE RESPONSE BODIES only; never identities.
        now = time.monotonic()
        if now - self.last_prune < 30:
            return
        with self._transaction() as conn:
            conn.execute(
                "WITH expired AS (SELECT fp_hash FROM signal_replay.entries "
                "WHERE outcome_json IS NOT NULL AND (expires_at IS NULL OR expires_at<=%s) "
                "ORDER BY expires_at NULLS FIRST LIMIT 1000 FOR UPDATE SKIP LOCKED) "
                "UPDATE signal_replay.entries e SET outcome_json=NULL FROM expired x WHERE e.fp_hash=x.fp_hash",
                (time.time(),))
        self.last_prune = now

    @staticmethod
    def _key(key):
        if not isinstance(key, str) or not HEX64.fullmatch(key):
            raise StoreError("invalid replay identity")
