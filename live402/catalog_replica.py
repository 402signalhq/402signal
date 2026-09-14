"""Shadow catalog replica on the shared replay PostgreSQL (second-machine plan, step 4).

Same shape as live402.history_replica: the SQLite catalog file on the
writer's volume stays the source of truth and the reader. When
LIVE402_CATALOG_BACKEND=dual, every committed change to it (listings, their
sources and payment claims, source sweeps, claim events and the event cap)
is captured inside the same SQLite transaction as an outbox row and shipped
in order to `signal_catalog` through `api_apply`
(`ops/catalog-postgres-managed.sql`). A backfill copies the file once in
chunks and an hourly parity line compares counts. The full-text index and
the short-lived finalist schema cache are derived data and are not copied.

Backends (LIVE402_CATALOG_BACKEND):
  sqlite  the volume file only. Default.
  dual    the volume file plus the replica.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time

from live402.history_replica import PostgresReplica, ReplicaUnavailable, clean_payload, clean_text

BACKENDS = frozenset({"sqlite", "dual"})
RESOURCE_COLS = (
    "id", "canonical_url", "service_name", "description", "capability", "capability_version", "tool_name",
    "method", "tags", "input_schema_present", "output_schema_present", "first_seen", "last_seen", "last_fetched",
    "last_verified", "last_searched", "last_routed", "last_probe_ok", "row_hash", "status", "retired_at",
    "reappeared_at",
)
SOURCE_COLS = ("id", "resource_id", "source", "source_resource_id", "source_generation", "source_last_seen")
CLAIM_COLS = ("id", "resource_id", "source", "rail", "network", "asset", "amount_atomic", "payTo", "facilitator")
STATE_COLS = ("source", "generation", "cursor", "upstream_total", "sweep_started_at", "last_complete_sweep_at")
EVENT_COLS = ("id", "resource_id", "canonical_url", "event", "source", "detail", "ts")
APPLY_COLUMNS = ("resources", "resource_sources", "accept_claims", "source_state", "claim_events", "deleted_events")
COUNT_SQL = (
    "SELECT (SELECT count(*) FROM {s}.resources), (SELECT coalesce(max(id), 0) FROM {s}.resources), "
    "(SELECT count(*) FROM {s}.resource_sources), (SELECT count(*) FROM {s}.accept_claims), "
    "(SELECT count(*) FROM {s}.source_state), (SELECT count(*) FROM {s}.claim_events)"
)
COUNT_KEYS = ("resources", "max_resource_id", "resource_sources", "accept_claims", "source_state", "claim_events")
DRAIN_LIMIT = 200
BACKFILL_CHUNK = 300
EVENTS_CHUNK = 1000
# Bound on queued change sets during a replica outage; past it the outbox stops
# growing and the backfill restarts once the replica is back (see enqueue()).
MAX_OUTBOX_ROWS = 20_000
OVERFLOW_KEY = "outbox_overflow_at"

_lock = threading.Lock()
_replica = None


def backend_name() -> str:
    raw = (os.environ.get("LIVE402_CATALOG_BACKEND") or "").strip().lower()
    if not raw:
        return "sqlite"
    if raw not in BACKENDS:
        raise ValueError("invalid catalog backend")
    return raw


def dual() -> bool:
    try:
        return backend_name() == "dual"
    except ValueError:
        return False


class Effects:
    """What one locked catalog write touched. Filled by shadow.py's helpers."""

    __slots__ = ("resource_ids", "event_ids", "deleted_events", "sources")

    def __init__(self):
        self.resource_ids: set[int] = set()
        self.event_ids: set[int] = set()
        self.deleted_events: set[int] = set()
        self.sources: set[str] = set()

    def empty(self) -> bool:
        return not (self.resource_ids or self.event_ids or self.deleted_events or self.sources)


def _lower(row, cols: tuple) -> dict:
    # NUL cannot be stored in PostgreSQL text; a seller-written description carried one.
    return {col.lower(): clean_text(row[i]) for i, col in enumerate(cols)}


def _chunks(values, size=500):
    items = list(values)
    for i in range(0, len(items), size):
        yield items[i:i + size]


def _rows_for_resources(cur, ids) -> dict:
    out: dict = {"resources": [], "resource_sources": [], "accept_claims": []}
    for chunk in _chunks(ids):
        marks = ",".join("?" * len(chunk))
        cur.execute("SELECT %s FROM resources WHERE id IN (%s)" % (", ".join(RESOURCE_COLS), marks), tuple(chunk))
        out["resources"].extend(_lower(r, RESOURCE_COLS) for r in cur.fetchall())
        cur.execute("SELECT %s FROM resource_sources WHERE resource_id IN (%s)" % (", ".join(SOURCE_COLS), marks), tuple(chunk))
        out["resource_sources"].extend(_lower(r, SOURCE_COLS) for r in cur.fetchall())
        cur.execute("SELECT %s FROM accept_claims WHERE resource_id IN (%s)" % (", ".join(CLAIM_COLS), marks), tuple(chunk))
        out["accept_claims"].extend(_lower(r, CLAIM_COLS) for r in cur.fetchall())
    return out


def capture(cur, effects: Effects) -> dict | None:
    """Read the touched rows back through the writing cursor (before commit) as one payload."""
    if effects is None or effects.empty():
        return None
    payload: dict = {}
    if effects.resource_ids:
        ids = sorted(effects.resource_ids)
        rows = _rows_for_resources(cur, ids)
        payload.update({k: v for k, v in rows.items() if v})
        payload["claims_for"] = ids
    if effects.sources:
        for chunk in _chunks(effects.sources):
            marks = ",".join("?" * len(chunk))
            cur.execute("SELECT %s FROM source_state WHERE source IN (%s)" % (", ".join(STATE_COLS), marks), tuple(chunk))
            payload.setdefault("source_state", []).extend(_lower(r, STATE_COLS) for r in cur.fetchall())
    live_events = effects.event_ids - effects.deleted_events
    for chunk in _chunks(live_events):
        marks = ",".join("?" * len(chunk))
        cur.execute("SELECT %s FROM claim_events WHERE id IN (%s)" % (", ".join(EVENT_COLS), marks), tuple(chunk))
        payload.setdefault("claim_events", []).extend(_lower(r, EVENT_COLS) for r in cur.fetchall())
    if effects.deleted_events:
        payload["deleted_events"] = sorted(effects.deleted_events)
    payload = {k: v for k, v in payload.items() if v}
    return payload or None


def enqueue(cur, effects: Effects) -> bool:
    """Append the captured change set to the outbox in the caller's transaction. Never raises."""
    try:
        if not dual():
            return False
        payload = capture(cur, effects)
        if not payload:
            return False
        depth = cur.execute("SELECT count(*) FROM replica_outbox").fetchone()
        if int((depth[0] if depth else 0) or 0) >= MAX_OUTBOX_ROWS:
            cur.execute(
                "INSERT INTO replica_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (OVERFLOW_KEY, str(int(time.time()))),
            )
            return False
        cur.execute(
            "INSERT INTO replica_outbox (payload, created_at) VALUES (?, ?)",
            (json.dumps(payload, separators=(",", ":"), default=str), int(time.time())),
        )
        return True
    except Exception:
        return False


def replica() -> PostgresReplica:
    global _replica
    with _lock:
        if _replica is None:
            try:
                _replica = PostgresReplica(
                    schema="signal_catalog", app="402signal-catalog",
                    apply_columns=APPLY_COLUMNS, count_sql=COUNT_SQL, count_keys=COUNT_KEYS,
                )
            except ReplicaUnavailable:
                raise ReplicaUnavailable("catalog replica unavailable") from None
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
    from live402 import shadow

    shipped = 0
    target = replica()
    empty = False
    while shipped < limit:
        with shadow._lock:
            conn = shadow._connect()
            row = conn.execute("SELECT id, payload FROM replica_outbox ORDER BY id ASC LIMIT 1").fetchone()
        if not row:
            empty = True
            break
        payload = clean_payload(json.loads(row["payload"]))
        target.apply(payload)
        with shadow._lock:
            conn = shadow._connect()
            conn.execute("DELETE FROM replica_outbox WHERE id = ?", (int(row["id"]),))
            conn.commit()
        shipped += 1
    if empty:
        _recover_overflow(shadow)
    return shipped


def _recover_overflow(shadow_mod) -> bool:
    """After an overflow, once the outbox is empty again: restart the backfill so the
    change sets dropped during the outage reach the replica (upserts of the same ids)."""
    with shadow_mod._lock:
        conn = shadow_mod._connect()
        if _meta_get(conn, OVERFLOW_KEY) is None:
            return False
        conn.execute("DELETE FROM replica_meta WHERE key IN (?, 'backfill_done_at', 'backfill_events_cursor')", (OVERFLOW_KEY,))
        _meta_set(conn, "backfill_cursor", "0")
        conn.commit()
    sys.stderr.write("catalog_replica_outbox_overflow_recovered backfill=restarted\n")
    return True


def outbox_depth() -> int:
    from live402 import shadow

    with shadow._lock:
        conn = shadow._connect()
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


def backfill_step(chunk: int = BACKFILL_CHUNK, events_chunk: int = EVENTS_CHUNK) -> dict | None:
    """Copy the file into the replica once, one chunk per call.

    Two phases, each with its own cursor in the SQLite file: first the source
    sweep state and the claim events (oldest first, `events_chunk` a call),
    then the listings with their sources and claims (`chunk` a call). Rows
    the outbox ships meanwhile are upserts of the same ids, so live refreshes
    and the backfill never disagree.
    """
    if not dual():
        return None
    from live402 import shadow

    with shadow._lock:
        conn = shadow._connect()
        if _meta_get(conn, "backfill_done_at"):
            return None
        events_cursor = _meta_get(conn, "backfill_events_cursor")
        cursor = int(_meta_get(conn, "backfill_cursor") or 0)
        cur = conn.cursor()
        payload: dict = {}
        phase = "events"
        next_cursor = cursor
        next_events_cursor = events_cursor
        if events_cursor != "done":
            start = int(events_cursor or 0)
            if start == 0:
                cur.execute("SELECT %s FROM source_state" % ", ".join(STATE_COLS))
                payload["source_state"] = [_lower(r, STATE_COLS) for r in cur.fetchall()]
            cur.execute(
                "SELECT %s FROM claim_events WHERE id > ? ORDER BY id ASC LIMIT ?" % ", ".join(EVENT_COLS),
                (start, int(events_chunk)),
            )
            events = [_lower(r, EVENT_COLS) for r in cur.fetchall()]
            if events:
                payload["claim_events"] = events
            cur.execute("SELECT coalesce(max(id), 0) FROM claim_events")
            max_event = int(cur.fetchone()[0] or 0)
            last = int(events[-1]["id"]) if events else start
            next_events_cursor = "done" if last >= max_event else str(last)
        else:
            phase = "resources"
            cur.execute("SELECT id FROM resources WHERE id > ? ORDER BY id ASC LIMIT ?", (cursor, int(chunk)))
            ids = [int(r[0]) for r in cur.fetchall()]
            if ids:
                payload.update({k: v for k, v in _rows_for_resources(cur, ids).items() if v})
                payload["claims_for"] = ids
                next_cursor = ids[-1]
        cur.execute("SELECT coalesce(max(id), 0) FROM resources")
        max_id = int(cur.fetchone()[0] or 0)
    payload = {k: v for k, v in payload.items() if v}
    target = replica()
    counts = target.apply(payload) if payload else {}
    done = phase == "resources" and next_cursor >= max_id
    with shadow._lock:
        conn = shadow._connect()
        if next_events_cursor is not None:
            _meta_set(conn, "backfill_events_cursor", str(next_events_cursor))
        _meta_set(conn, "backfill_cursor", str(next_cursor))
        if done:
            _meta_set(conn, "backfill_done_at", str(int(time.time())))
        conn.commit()
    if done:
        try:
            target.meta_set("backfill_done_at", str(int(time.time())))
        except ReplicaUnavailable:
            pass
    return {"phase": phase, "cursor": next_cursor, "max_id": max_id, "done": done, **counts}


def parity() -> dict:
    """Compare row counts on both sides. Logged by the writer; the switch-over gate."""
    from live402 import shadow

    with shadow._lock:
        conn = shadow._connect()
        local = {}
        for key, sql in (
            ("resources", "SELECT count(*) FROM resources"),
            ("max_resource_id", "SELECT coalesce(max(id), 0) FROM resources"),
            ("resource_sources", "SELECT count(*) FROM resource_sources"),
            ("accept_claims", "SELECT count(*) FROM accept_claims"),
            ("source_state", "SELECT count(*) FROM source_state"),
            ("claim_events", "SELECT count(*) FROM claim_events"),
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
