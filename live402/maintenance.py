"""Writer-only housekeeping. Every job no-ops without the leadership lease."""

from __future__ import annotations

import sys
import threading
import time

from live402 import leadership

TICK_S = 30.0
JOBS = (
    ("session_prune", 600.0),
    ("metrics_flush", 300.0),
    ("replay_capacity", 300.0),
    ("replay_expire", 60.0),
    ("leaf_outbox_drain", 15.0),
    ("leaf_outbox_prune", 3600.0),
    ("alerts_scan", 120.0),
    ("north_star", 3600.0),
    ("history_replica_drain", 15.0),
    ("history_replica_backfill", 30.0),
    ("history_replica_parity", 3600.0),
    ("catalog_replica_drain", 15.0),
    ("catalog_replica_backfill", 30.0),
    ("catalog_replica_parity", 3600.0),
)

_thread: threading.Thread | None = None
_stop = threading.Event()
_lock = threading.Lock()
_last: dict[str, float] = {}


def _session_prune() -> None:
    from live402 import session

    removed = session.prune()
    if any(removed.values()):
        sys.stderr.write(
            "session_prune %s\n" % " ".join("%s=%d" % kv for kv in sorted(removed.items()))
        )


def _metrics_flush() -> None:
    from live402 import metrics

    counts = metrics.flush()
    if counts:
        metrics.log_line(counts)


def _replay_capacity() -> None:
    from live402 import replay

    snap = replay.capacity_snapshot()
    if snap:
        sys.stderr.write(
            "replay_capacity %s\n" % " ".join("%s=%s" % kv for kv in sorted(snap.items()))
        )


def _replay_expire() -> None:
    from live402 import replay

    removed = replay.expire_identities(1000)
    if removed:
        sys.stderr.write("replay_expired count=%d\n" % removed)


def _leaf_outbox_drain() -> None:
    from live402.pq import outbox

    appended = outbox.drain()
    if appended:
        sys.stderr.write("leaf_outbox_drained count=%d\n" % appended)


def _leaf_outbox_prune() -> None:
    from live402.pq import outbox

    removed = outbox.prune()
    if removed:
        sys.stderr.write("leaf_outbox_pruned count=%d\n" % removed)


def _alerts_scan() -> None:
    from live402 import alerts

    attempted = alerts.scan()
    if attempted:
        sys.stderr.write("alerts_scan deliveries=%d\n" % attempted)


def _north_star() -> None:
    from live402 import session

    snap = session.north_star(7)
    sys.stderr.write(
        "north_star days=7 receipts_organic=%d receipts_all=%d distinct_payers_organic=%d distinct_payers_all=%d\n"
        % (snap["receipts_organic"], snap["receipts_all"], snap["distinct_payers_organic"], snap["distinct_payers_all"])
    )


def _history_replica_drain() -> None:
    from live402 import history_replica

    if not history_replica.dual():
        return
    try:
        shipped = history_replica.drain()
    except history_replica.ReplicaUnavailable as exc:
        sys.stderr.write("history_replica_unavailable pending=%d detail=%r\n" % (history_replica.outbox_depth(), exc.detail))
        return
    if shipped:
        sys.stderr.write("history_replica_drained count=%d\n" % shipped)


def _history_replica_backfill() -> None:
    from live402 import history_replica

    if not history_replica.dual():
        return
    try:
        step = history_replica.backfill_step()
    except history_replica.ReplicaUnavailable as exc:
        sys.stderr.write("history_replica_backfill_unavailable detail=%r\n" % exc.detail)
        return
    if step:
        sys.stderr.write(
            "history_replica_backfill cursor=%d max_id=%d done=%s probes=%d observations=%d\n"
            % (step["cursor"], step["max_id"], "yes" if step["done"] else "no",
               step.get("probes", 0), step.get("observations", 0))
        )


def _history_replica_parity() -> None:
    from live402 import history_replica

    if not history_replica.dual():
        return
    try:
        result = history_replica.parity()
    except history_replica.ReplicaUnavailable as exc:
        sys.stderr.write("history_replica_parity_unavailable detail=%r\n" % exc.detail)
        return
    sys.stderr.write(
        "history_replica_parity ok=%s backfill_done=%s outbox_pending=%d %s\n"
        % ("yes" if result["ok"] else "no", "yes" if result["backfill_done"] else "no",
           result["outbox_pending"],
           " ".join("%s=%d/%d" % (k, v[0], v[1]) for k, v in sorted(result["diffs"].items())) or "counts_match")
    )


def _catalog_replica_drain() -> None:
    from live402 import catalog_replica

    if not catalog_replica.dual():
        return
    try:
        shipped = catalog_replica.drain()
    except catalog_replica.ReplicaUnavailable as exc:
        sys.stderr.write("catalog_replica_unavailable pending=%d detail=%r\n" % (catalog_replica.outbox_depth(), exc.detail))
        return
    if shipped:
        sys.stderr.write("catalog_replica_drained count=%d\n" % shipped)


def _catalog_replica_backfill() -> None:
    from live402 import catalog_replica

    if not catalog_replica.dual():
        return
    try:
        step = catalog_replica.backfill_step()
    except catalog_replica.ReplicaUnavailable as exc:
        sys.stderr.write("catalog_replica_backfill_unavailable detail=%r\n" % exc.detail)
        return
    if step:
        sys.stderr.write(
            "catalog_replica_backfill phase=%s cursor=%d max_id=%d done=%s resources=%d claim_events=%d\n"
            % (step.get("phase", "resources"), step["cursor"], step["max_id"], "yes" if step["done"] else "no",
               step.get("resources", 0), step.get("claim_events", 0))
        )


def _catalog_replica_parity() -> None:
    from live402 import catalog_replica

    if not catalog_replica.dual():
        return
    try:
        result = catalog_replica.parity()
    except catalog_replica.ReplicaUnavailable as exc:
        sys.stderr.write("catalog_replica_parity_unavailable detail=%r\n" % exc.detail)
        return
    sys.stderr.write(
        "catalog_replica_parity ok=%s backfill_done=%s outbox_pending=%d %s\n"
        % ("yes" if result["ok"] else "no", "yes" if result["backfill_done"] else "no",
           result["outbox_pending"],
           " ".join("%s=%d/%d" % (k, v[0], v[1]) for k, v in sorted(result["diffs"].items())) or "counts_match")
    )


_JOB_FUNCS = {
    "session_prune": _session_prune,
    "metrics_flush": _metrics_flush,
    "replay_capacity": _replay_capacity,
    "replay_expire": _replay_expire,
    "leaf_outbox_drain": _leaf_outbox_drain,
    "leaf_outbox_prune": _leaf_outbox_prune,
    "alerts_scan": _alerts_scan,
    "north_star": _north_star,
    "history_replica_drain": _history_replica_drain,
    "history_replica_backfill": _history_replica_backfill,
    "history_replica_parity": _history_replica_parity,
    "catalog_replica_drain": _catalog_replica_drain,
    "catalog_replica_backfill": _catalog_replica_backfill,
    "catalog_replica_parity": _catalog_replica_parity,
}


def run_due(now: float | None = None) -> list[str]:
    if not leadership.holds():
        return []
    current = time.monotonic() if now is None else float(now)
    ran: list[str] = []
    for name, every in JOBS:
        last = _last.get(name)
        if last is not None and current - last < every:
            continue
        _last[name] = current
        try:
            _JOB_FUNCS[name]()
            ran.append(name)
        except Exception as exc:
            sys.stderr.write("maintenance_error job=%s kind=%s\n" % (name, type(exc).__name__))
    return ran


def _loop() -> None:
    while not _stop.wait(TICK_S):
        try:
            run_due()
        except Exception:
            continue


def start() -> None:
    from live402 import fixtures

    if fixtures.fixture_mode() or not leadership.holds():
        return
    global _thread
    with _lock:
        if _thread is not None and _thread.is_alive():
            return
        _stop.clear()
        _thread = threading.Thread(target=_loop, name="maintenance", daemon=True)
        _thread.start()


def stop() -> None:
    _stop.set()
