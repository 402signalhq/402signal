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


_JOB_FUNCS = {
    "session_prune": _session_prune,
    "metrics_flush": _metrics_flush,
    "replay_capacity": _replay_capacity,
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
