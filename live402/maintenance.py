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


_JOB_FUNCS = {
    "session_prune": _session_prune,
    "metrics_flush": _metrics_flush,
    "replay_capacity": _replay_capacity,
    "replay_expire": _replay_expire,
    "leaf_outbox_drain": _leaf_outbox_drain,
    "leaf_outbox_prune": _leaf_outbox_prune,
    "alerts_scan": _alerts_scan,
    "north_star": _north_star,
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
