"""Readiness checks. No secrets, no filesystem paths in the response."""

from __future__ import annotations

import os
import threading
import time


def _check_sqlite(connect_fn) -> bool:
    try:
        conn = connect_fn()
        row = conn.execute("SELECT 1").fetchone()
        return bool(row and int(row[0]) == 1)
    except Exception:
        return False


def _catalog_ok() -> bool:
    try:
        from live402 import shadow

        shadow._connect()
        return _check_sqlite(shadow._connect)
    except Exception:
        return False


def _history_ok() -> bool:
    try:
        from live402 import history

        return _check_sqlite(history._connect)
    except Exception:
        return False


def _pq_log_sqlite_ok() -> bool:
    try:
        from live402.pq import store

        return _check_sqlite(store._connect)
    except Exception:
        return False


def _pq_log_ok() -> bool:
    """Sqlite reachable and not LOCAL LOG INCONSISTENT (size < last_confirmed).

    Uses monitor.ready_flags(), the boolean subset of the operator snapshot.
    GET /ready never returns the snapshot itself.
    """
    if not _pq_log_sqlite_ok():
        return False
    try:
        from live402.pq import monitor

        flags = monitor.ready_flags()
        return bool(flags.get("pq_log_sqlite")) and bool(flags.get("pq_log_integrity"))
    except Exception:
        return False


def _replay_ok() -> bool:
    """Paid requests require a durable, writable exactly-once ledger."""
    try:
        from live402 import replay

        return replay.durable_ready()
    except Exception:
        return False


def _storage_ok() -> bool:
    """Writable sqlite journals for the three process-local databases."""
    return _catalog_ok() and _history_ok() and _pq_log_sqlite_ok()


def _writer() -> bool:
    """Whether this process currently holds the writer lease. Never part of `ok`."""
    try:
        from live402 import leadership

        return bool(leadership.holds())
    except Exception:
        return False


def readiness() -> dict:
    """Public /ready body. Booleans only. Never paths, never env, never keys.

    `writer` is reported beside `ok`, not inside `checks`: a standby machine
    without the lease is healthy and must not fail its readiness check.
    """
    from live402 import admission

    checks = {
        "admission": admission.ready(),
        "storage": _storage_ok(),
        "catalog": _catalog_ok(),
        "history": _history_ok(),
        "pq_log": _pq_log_ok(),
        "replay_ledger": _replay_ok(),
    }
    return {"ok": all(checks.values()), "checks": checks, "writer": _writer()}


_cache_lock = threading.Lock()
_cached: dict | None = None
_cached_at = 0.0


def cache_seconds() -> float:
    raw = (os.environ.get("LIVE402_READY_CACHE_S") or "").strip()
    if raw:
        try:
            return max(0.0, min(30.0, float(raw)))
        except ValueError:
            pass
    from live402 import fixtures

    return 0.0 if fixtures.fixture_mode() else 5.0


def cached_readiness() -> dict:
    """Readiness computed at most once per cache window, single-flight.

    readiness() writes a probe transaction under the replay lock. Public /ready
    floods and the in-process paid gate must not multiply that work.
    """
    global _cached, _cached_at
    ttl = cache_seconds()
    if ttl <= 0:
        return readiness()
    with _cache_lock:
        if _cached is not None and time.monotonic() - _cached_at < ttl:
            return {"ok": _cached["ok"], "checks": dict(_cached["checks"]), "writer": _writer()}
        payload = readiness()
        _cached, _cached_at = payload, time.monotonic()
        return {"ok": payload["ok"], "checks": dict(payload["checks"]), "writer": payload["writer"]}


def reset_cache() -> None:
    global _cached, _cached_at
    with _cache_lock:
        _cached, _cached_at = None, 0.0
