"""Transparency-leaf outbox: paid checks complete without the writer lease.

A router process that does not hold the writer lease cannot append to the
append-only log (one tree, one writer). With LIVE402_PQ_OUTBOX=1 and the owner
migration ops/replay-postgres-leaf-outbox.sql installed on the shared replay
authority, such a process queues the public leaf bytes there instead, durably,
and the writer drains the queue in order into the log. Only public leaf bytes
are queued, the same bytes the log holds; never the reveal or any private
evidence.

A queued leaf is not a signed receipt. Its transparency block reports
status "queued" / state "outbox_queued" with the leaf hash, and
require_transparency or require_route_binding requests still need the writer
(the paid gate refuses them without the lease). Hosted sessions and hops keep
per-machine state and are refused without the lease too.
"""
from __future__ import annotations

import os
import sys

from live402.pq import events, merkle, store

ENV = "LIVE402_PQ_OUTBOX"
STATUS = "queued"
STATE = "outbox_queued"
DRAIN_BATCH = 500
PRUNE_DAYS = 14


def enabled() -> bool:
    """Operator opt-in and a shared (PostgreSQL) replay authority."""
    if (os.environ.get(ENV) or "").strip() != "1":
        return False
    try:
        from live402 import replay_store

        return replay_store.backend_name() == "postgres"
    except Exception:
        return False


def available() -> bool:
    """True when queued leaves can be written: opted in and the owner migration exists."""
    if not enabled():
        return False
    try:
        from live402 import replay

        return bool(replay.outbox_supported())
    except Exception:
        return False


def needs_writer(body) -> bool:
    """True when the request needs a signed leaf or per-machine state at response time."""
    if not isinstance(body, dict):
        return True
    if body.get("require_route_binding") is True:
        return True
    raw = body.get("require_transparency")
    if raw is True or (isinstance(raw, str) and raw.strip().lower() in {"1", "true", "yes"}):
        return True
    try:
        from live402 import batch_binding

        if batch_binding.requested(body):
            return True
    except Exception:
        return True
    try:
        from live402 import session as session_mod

        if session_mod.mode(body) is not None:
            return True
    except Exception:
        return True
    return False


def queue(event: dict) -> dict:
    """Queue one public leaf for the writer. Raises when the outbox refuses."""
    from live402 import leadership, replay

    body = events.leaf_bytes(event)
    digest = merkle.leaf_hash(body)
    rec = replay.outbox_put(body, digest, leadership.holder_id())
    return {
        "id": int(rec["id"]),
        "leaf_hash": digest,
        "duplicate": bool(rec.get("duplicate")),
        "appended_idx": rec.get("appended_idx"),
    }


def drain(limit: int = DRAIN_BATCH) -> int:
    """Writer only. Append queued leaves in queue order; acknowledge each once durable.

    store.append is idempotent by leaf hash, so a crash between append and
    acknowledgement repeats no leaf. A row whose bytes no longer hash to its
    recorded leaf hash is left pending and reported; it never enters the log.
    """
    from live402 import leadership, replay

    if not leadership.holds() or not available():
        return 0
    rows = replay.outbox_pending(max(1, min(1000, int(limit))))
    appended = 0
    for row_id, leaf_hash, body in rows:
        if not leadership.holds():
            break
        raw = bytes(body)
        if merkle.leaf_hash(raw) != bytes(leaf_hash):
            sys.stderr.write("leaf_outbox corrupt id=%d\n" % int(row_id))
            continue
        rec = store.append(raw)
        idx = int(rec["idx"])
        if store.leaf_at(idx) is None:
            break
        if not store.ready_to_checkpoint(int(rec["size"])):
            store.publish_up_to(int(rec["size"]))
        replay.outbox_ack(int(row_id), idx)
        appended += 1
    return appended


def prune(days: int = PRUNE_DAYS) -> int:
    from live402 import leadership, replay

    if not leadership.holds() or not available():
        return 0
    return int(replay.outbox_prune(int(days)))


def depth() -> dict | None:
    """Pending count and age of the oldest queued leaf, for operators. None when off."""
    if not available():
        return None
    from live402 import replay

    try:
        pending, oldest = replay.outbox_depth()
    except Exception:
        return None
    return {"pending": int(pending), "oldest_age_s": round(float(oldest), 1)}
