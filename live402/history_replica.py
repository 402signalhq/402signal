"""Probe history replica on the shared replay PostgreSQL (second-machine plan, step 3).

The SQLite history file on the writer's volume stays the source of truth and
the reader. When LIVE402_HISTORY_BACKEND=dual, every committed change to it
is captured inside the same SQLite transaction as an outbox row (the rows a
write touched, read back before commit) and shipped in order to
`signal_history` on the replay database through the owner function
`api_apply` (`ops/history-postgres-managed.sql`). A backfill walks the file
from the oldest probe once, in chunks, and a parity log compares counts so
the endpoint pages can move to the copy when it has held for a week.

Nothing here runs in the request path beyond the outbox insert, which is a
local SQLite write. Shipping, backfill and parity run from the maintenance
loop on the writer only. A failed ship leaves the outbox row in place; the
next drain retries in order. Rows keep their SQLite ids (one writer).

Backends (LIVE402_HISTORY_BACKEND):
  sqlite  the volume file only. Default.
  dual    the volume file plus the replica.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time

BACKENDS = frozenset({"sqlite", "dual"})
MAX_CONNECTION_AGE = 600
SETTINGS = (
    "SET LOCAL statement_timeout = '5000ms'",
    "SET LOCAL lock_timeout = '1000ms'",
    "SET LOCAL idle_in_transaction_session_timeout = '6000ms'",
)
PROBE_COLS = (
    "id", "url", "ts", "live", "payable", "invocable", "latency_ms", "payTo", "amount", "miss_reason",
    "rail", "schema_present", "settled_route_observation", "trust_class", "traffic_class",
)
OBS_COLS = ("id", "probe_id", "batch_id", "source_type", "source", "rail", "url", "field", "value", "status", "ts", "trust_class")
STATE_COLS = (
    "url", "last_payTo", "last_amount", "schema_present", "payTo_changed_at", "price_changed_at",
    "schema_changed_at", "last_checked", "last_success_402", "pending_payTo", "last_trusted_ts",
)
MODEL_COLS = ("model_id", "model_hash", "effective_ts", "spec_json", "recorded_at")
DRAIN_LIMIT = 200
BACKFILL_CHUNK = 400
OUTBOX_KEEP_S = 7 * 86400

_lock = threading.Lock()
_replica = None


class ReplicaUnavailable(Exception):
    """The replica cannot be reached or refused the operation. The outbox keeps the row."""


def backend_name() -> str:
    """Configured backend. Raises ValueError for an unknown value (fail closed to sqlite-only)."""
    raw = (os.environ.get("LIVE402_HISTORY_BACKEND") or "").strip().lower()
    if not raw:
        return "sqlite"
    if raw not in BACKENDS:
        raise ValueError("invalid history backend")
    return raw


def dual() -> bool:
    try:
        return backend_name() == "dual"
    except ValueError:
        return False


class Effects:
    """What one locked history write touched. Filled by history.py's helpers."""

    __slots__ = ("probe_ids", "obs_ids", "urls", "deleted_probes", "deleted_observations", "sealed", "models")

    def __init__(self):
        self.probe_ids: set[int] = set()
        self.obs_ids: set[int] = set()
        self.urls: set[str] = set()
        self.deleted_probes: set[int] = set()
        self.deleted_observations: set[int] = set()
        self.sealed: list[str] = []
        self.models: list[tuple[str, str]] = []

    def empty(self) -> bool:
        return not (self.probe_ids or self.obs_ids or self.urls or self.deleted_probes
                    or self.deleted_observations or self.sealed or self.models)


def _lower(row: tuple, cols: tuple) -> dict:
    return {col.lower(): row[i] for i, col in enumerate(cols)}


def _chunks(values, size=500):
    items = list(values)
    for i in range(0, len(items), size):
        yield items[i:i + size]


def capture(cur, effects: Effects) -> dict | None:
    """Read the touched rows back through the writing cursor (before commit) as one payload."""
    if effects is None or effects.empty():
        return None
    payload: dict = {}
    live_probes = effects.probe_ids - effects.deleted_probes
    probes: list[dict] = []
    for chunk in _chunks(live_probes):
        marks = ",".join("?" * len(chunk))
        cur.execute("SELECT %s FROM probes WHERE id IN (%s)" % (", ".join(PROBE_COLS), marks), tuple(chunk))
        probes.extend(_lower(r, PROBE_COLS) for r in cur.fetchall())
    obs: dict[int, dict] = {}
    for chunk in _chunks(live_probes):
        marks = ",".join("?" * len(chunk))
        cur.execute("SELECT %s FROM observations WHERE probe_id IN (%s)" % (", ".join(OBS_COLS), marks), tuple(chunk))
        for r in cur.fetchall():
            obs[int(r[0])] = _lower(r, OBS_COLS)
    for chunk in _chunks(effects.obs_ids - effects.deleted_observations):
        marks = ",".join("?" * len(chunk))
        cur.execute("SELECT %s FROM observations WHERE id IN (%s)" % (", ".join(OBS_COLS), marks), tuple(chunk))
        for r in cur.fetchall():
            obs[int(r[0])] = _lower(r, OBS_COLS)
    states: list[dict] = []
    for chunk in _chunks(effects.urls):
        marks = ",".join("?" * len(chunk))
        cur.execute("SELECT %s FROM url_state WHERE url IN (%s)" % (", ".join(STATE_COLS), marks), tuple(chunk))
        states.extend(_lower(r, STATE_COLS) for r in cur.fetchall())
    sealed: list[dict] = []
    for bid in effects.sealed:
        cur.execute("SELECT batch_id, sealed_at FROM sealed_batches WHERE batch_id = ?", (bid,))
        row = cur.fetchone()
        if row:
            sealed.append({"batch_id": row[0], "sealed_at": row[1]})
    models: list[dict] = []
    for model_id, digest in effects.models:
        cur.execute(
            "SELECT %s FROM scoring_models WHERE model_id = ? AND model_hash = ?" % ", ".join(MODEL_COLS),
            (model_id, digest),
        )
        row = cur.fetchone()
        if row:
            models.append(_lower(row, MODEL_COLS))
    if probes:
        payload["probes"] = probes
    if obs:
        payload["observations"] = [obs[k] for k in sorted(obs)]
    if states:
        payload["url_state"] = states
    if effects.deleted_probes:
        payload["deleted_probes"] = sorted(effects.deleted_probes)
    if effects.deleted_observations:
        payload["deleted_observations"] = sorted(effects.deleted_observations)
    if sealed:
        payload["sealed"] = sealed
    if models:
        payload["scoring_models"] = models
    return payload or None


def enqueue(cur, effects: Effects) -> bool:
    """Append the captured change set to the outbox in the caller's transaction. Never raises."""
    try:
        if not dual():
            return False
        payload = capture(cur, effects)
        if not payload:
            return False
        cur.execute(
            "INSERT INTO replica_outbox (payload, created_at) VALUES (?, ?)",
            (json.dumps(payload, separators=(",", ":"), default=str), int(time.time())),
        )
        return True
    except Exception:
        return False


class PostgresReplica:
    """The replica on the replay database: api_apply for writes, plain reads for parity."""

    def __init__(self, environ=None):
        env = os.environ if environ is None else environ
        try:
            import psycopg
            from psycopg.conninfo import conninfo_to_dict

            from live402.replay_postgres import validate_settings

            self.config, _authority = validate_settings(env, conninfo_to_dict)
        except Exception:
            raise ReplicaUnavailable("history replica unavailable") from None
        self._psycopg = psycopg
        self._lock = threading.Lock()
        self._conn = None
        self._connected_at = 0.0

    def close(self) -> None:
        with self._lock:
            self._discard()

    def _discard(self) -> None:
        conn, self._conn = self._conn, None
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass

    def _connection(self):
        conn = self._conn
        if conn is not None and (conn.closed or time.monotonic() - self._connected_at >= MAX_CONNECTION_AGE):
            self._discard()
            conn = None
        if conn is None:
            conn = self._psycopg.connect(
                **self.config, autocommit=True, connect_timeout=2,
                application_name="402signal-history", prepare_threshold=None,
            )
            self._conn, self._connected_at = conn, time.monotonic()
        return conn

    def _run(self, fn):
        with self._lock:
            try:
                conn = self._connection()
                with conn.transaction():
                    for statement in SETTINGS:
                        conn.execute(statement)
                    return fn(conn)
            except Exception:
                self._discard()
                raise ReplicaUnavailable("history replica unavailable") from None

    def apply(self, payload: dict) -> dict:
        body = json.dumps(payload, separators=(",", ":"), default=str)
        row = self._run(lambda conn: conn.execute(
            "SELECT probes, observations, url_state, deleted_probes, deleted_observations, sealed, scoring_models "
            "FROM signal_history.api_apply(%s::jsonb)", (body,)).fetchone())
        keys = ("probes", "observations", "url_state", "deleted_probes", "deleted_observations", "sealed", "scoring_models")
        return {key: int(value or 0) for key, value in zip(keys, row or (0,) * 7)}

    def meta_set(self, key: str, value: str) -> None:
        self._run(lambda conn: conn.execute("SELECT signal_history.api_meta_set(%s,%s)", (key, value)).fetchone())

    def meta_get(self, key: str):
        row = self._run(lambda conn: conn.execute(
            "SELECT value FROM signal_history.replica_meta WHERE key = %s", (key,)).fetchone())
        return row[0] if row else None

    def counts(self) -> dict:
        row = self._run(lambda conn: conn.execute(
            "SELECT (SELECT count(*) FROM signal_history.probes), (SELECT coalesce(max(id), 0) FROM signal_history.probes), "
            "(SELECT count(*) FROM signal_history.observations), (SELECT count(*) FROM signal_history.url_state), "
            "(SELECT count(*) FROM signal_history.sealed_batches), (SELECT count(*) FROM signal_history.scoring_models)"
        ).fetchone())
        keys = ("probes", "max_probe_id", "observations", "url_state", "sealed", "scoring_models")
        return {key: int(value or 0) for key, value in zip(keys, row or (0,) * 6)}


def replica() -> PostgresReplica:
    global _replica
    with _lock:
        if _replica is None:
            _replica = PostgresReplica()
        return _replica


def forget_replica() -> None:
    global _replica
    with _lock:
        obj, _replica = _replica, None
    if obj is not None:
        obj.close()


# --- writer jobs (maintenance loop) -----------------------------------------

def drain(limit: int = DRAIN_LIMIT) -> int:
    """Ship outbox rows in order. Stops at the first failure; the row stays for the next drain."""
    if not dual():
        return 0
    from live402 import history

    shipped = 0
    target = replica()
    while shipped < limit:
        with history._lock:
            conn = history._connect()
            row = conn.execute("SELECT id, payload FROM replica_outbox ORDER BY id ASC LIMIT 1").fetchone()
        if not row:
            break
        payload = json.loads(row[1])
        target.apply(payload)
        with history._lock:
            conn = history._connect()
            conn.execute("DELETE FROM replica_outbox WHERE id = ?", (int(row[0]),))
            conn.commit()
        shipped += 1
    return shipped


def outbox_depth() -> int:
    from live402 import history

    with history._lock:
        conn = history._connect()
        row = conn.execute("SELECT count(*) FROM replica_outbox").fetchone()
    return int(row[0] or 0) if row else 0


def _meta_get(conn, key: str):
    row = conn.execute("SELECT value FROM replica_meta WHERE key = ?", (key,)).fetchone()
    return row[0] if row else None


def _meta_set(conn, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO replica_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def backfill_step(chunk: int = BACKFILL_CHUNK) -> dict | None:
    """Copy the file into the replica once, oldest probe first, one chunk per call.

    The cursor (last probe id shipped) lives in the SQLite file, so a restart
    resumes where it stopped. url_state, sealed batches and scoring models go
    with the first chunk; probes deleted by the caps before their chunk are
    simply never copied. Rows the outbox ships meanwhile are upserts of the
    same ids, so live traffic and the backfill never disagree.
    """
    if not dual():
        return None
    from live402 import history

    with history._lock:
        conn = history._connect()
        if _meta_get(conn, "backfill_done_at"):
            return None
        cursor = int(_meta_get(conn, "backfill_cursor") or 0)
        cur = conn.cursor()
        payload: dict = {}
        if cursor == 0:
            cur.execute("SELECT %s FROM url_state" % ", ".join(STATE_COLS))
            payload["url_state"] = [_lower(r, STATE_COLS) for r in cur.fetchall()]
            cur.execute("SELECT batch_id, sealed_at FROM sealed_batches")
            payload["sealed"] = [{"batch_id": r[0], "sealed_at": r[1]} for r in cur.fetchall()]
            cur.execute("SELECT %s FROM scoring_models" % ", ".join(MODEL_COLS))
            payload["scoring_models"] = [_lower(r, MODEL_COLS) for r in cur.fetchall()]
            cur.execute("SELECT %s FROM observations WHERE probe_id IS NULL" % ", ".join(OBS_COLS))
            payload["observations"] = [_lower(r, OBS_COLS) for r in cur.fetchall()]
        cur.execute(
            "SELECT %s FROM probes WHERE id > ? ORDER BY id ASC LIMIT ?" % ", ".join(PROBE_COLS),
            (cursor, int(chunk)),
        )
        probes = [_lower(r, PROBE_COLS) for r in cur.fetchall()]
        if probes:
            ids = [int(p["id"]) for p in probes]
            marks = ",".join("?" * len(ids))
            cur.execute("SELECT %s FROM observations WHERE probe_id IN (%s)" % (", ".join(OBS_COLS), marks), tuple(ids))
            payload["probes"] = probes
            payload.setdefault("observations", []).extend(_lower(r, OBS_COLS) for r in cur.fetchall())
            next_cursor = ids[-1]
        else:
            next_cursor = cursor
        cur.execute("SELECT coalesce(max(id), 0) FROM probes")
        max_id = int(cur.fetchone()[0] or 0)
    payload = {k: v for k, v in payload.items() if v}
    target = replica()
    counts = target.apply(payload) if payload else {}
    done = next_cursor >= max_id
    with history._lock:
        conn = history._connect()
        _meta_set(conn, "backfill_cursor", str(next_cursor))
        if done:
            _meta_set(conn, "backfill_done_at", str(int(time.time())))
        conn.commit()
    if done:
        try:
            target.meta_set("backfill_done_at", str(int(time.time())))
        except ReplicaUnavailable:
            pass
    return {"cursor": next_cursor, "max_id": max_id, "done": done, **counts}


def parity() -> dict:
    """Compare row counts on both sides. Logged by the writer; the switch-over gate."""
    from live402 import history

    with history._lock:
        conn = history._connect()
        local = {}
        for key, sql in (
            ("probes", "SELECT count(*) FROM probes"),
            ("max_probe_id", "SELECT coalesce(max(id), 0) FROM probes"),
            ("observations", "SELECT count(*) FROM observations"),
            ("url_state", "SELECT count(*) FROM url_state"),
            ("sealed", "SELECT count(*) FROM sealed_batches"),
            ("scoring_models", "SELECT count(*) FROM scoring_models"),
        ):
            local[key] = int(conn.execute(sql).fetchone()[0] or 0)
        pending = int(conn.execute("SELECT count(*) FROM replica_outbox").fetchone()[0] or 0)
        done = bool(_meta_get(conn, "backfill_done_at"))
    remote = replica().counts()
    diffs = {key: (local[key], remote.get(key, 0)) for key in local if local[key] != remote.get(key, 0)}
    ok = done and pending == 0 and not diffs
    result = {"ok": ok, "backfill_done": done, "outbox_pending": pending, "local": local, "remote": remote, "diffs": diffs}
    try:
        replica().meta_set("parity", json.dumps({"ok": ok, "at": int(time.time()), "diffs": diffs}, default=str))
    except ReplicaUnavailable:
        pass
    return result


def prune_outbox(now: int | None = None) -> int:
    """Shipped rows are deleted at once; this only guards against a stuck outbox growing without bound."""
    from live402 import history

    cutoff = int(now if now is not None else time.time()) - OUTBOX_KEEP_S
    with history._lock:
        conn = history._connect()
        row = conn.execute("SELECT count(*) FROM replica_outbox WHERE created_at < ?", (cutoff,)).fetchone()
        n = int(row[0] or 0) if row else 0
        if n:
            sys.stderr.write("history_replica_outbox_stale count=%d\n" % n)
    return n
