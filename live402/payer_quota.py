"""Per-payer budget for verified attempts that do not settle.

Success-only billing means a normal miss costs the buyer nothing, yet every
verified attempt admits a permanent replay identity and runs seller probes.
A single funded wallet could otherwise sign unlimited distinct authorizations
that all miss. The payer comes from the facilitator's successful verify
response, so it is authenticated before any budget is charged.

Settled attempts are refunded: qualifying paid traffic is never throttled by
this budget. Process-local, like the rest of single-writer admission.
LIVE402_PAYER_UNSETTLED_PER_WINDOW=0 disables it.
"""

from __future__ import annotations

import contextvars
import hashlib
import os
import threading
import time
from collections import OrderedDict

DEFAULT_ATTEMPTS = 600
DEFAULT_WINDOW_S = 600.0
MAX_KEYS = 50_000


class Exhausted(Exception):
    """This payer has used its unsettled attempt budget for the window."""


def capacity() -> int:
    raw = (os.environ.get("LIVE402_PAYER_UNSETTLED_PER_WINDOW") or "").strip()
    try:
        value = int(raw) if raw else DEFAULT_ATTEMPTS
    except ValueError:
        value = DEFAULT_ATTEMPTS
    return max(0, min(1_000_000, value))


def window_seconds() -> float:
    raw = (os.environ.get("LIVE402_PAYER_WINDOW_S") or "").strip()
    try:
        value = float(raw) if raw else DEFAULT_WINDOW_S
    except ValueError:
        value = DEFAULT_WINDOW_S
    return max(60.0, min(86400.0, value))


_lock = threading.Lock()
_hits: OrderedDict[str, list[float]] = OrderedDict()
_current: contextvars.ContextVar = contextvars.ContextVar("live402_payer_lease", default=None)


def _key(rail: str, payer: str) -> str:
    identity = payer.lower() if rail == "base" else payer
    return hashlib.sha256(("payer-quota-v1:%s:%s" % (rail, identity)).encode("utf-8")).hexdigest()


class Lease:
    __slots__ = ("key", "stamp", "done")

    def __init__(self, key: str, stamp: float):
        self.key = key
        self.stamp = stamp
        self.done = False

    def finish(self, settled: bool) -> None:
        if self.done:
            return
        self.done = True
        if not settled:
            return
        with _lock:
            hits = _hits.get(self.key)
            if hits and self.stamp in hits:
                hits.remove(self.stamp)


def reserve(rail: str, payer, *, now: float | None = None) -> Lease | None:
    """Charge one unsettled attempt. None when disabled or the payer is unknown."""
    cap = capacity()
    if cap <= 0 or not isinstance(payer, str) or not payer.strip():
        return None
    key = _key(str(rail or "unknown"), payer.strip())
    stamp = time.monotonic() if now is None else float(now)
    window = window_seconds()
    with _lock:
        hits = [hit for hit in _hits.get(key, ()) if stamp - hit < window]
        _hits[key] = hits
        _hits.move_to_end(key)
        if len(hits) >= cap:
            raise Exhausted()
        hits.append(stamp)
        while len(_hits) > MAX_KEYS:
            _hits.popitem(last=False)
    return Lease(key, stamp)


def hold(lease: Lease | None) -> None:
    """Attach the lease to the current request so the route can finish it."""
    _current.set(lease)


def finish_current(settled: bool) -> None:
    lease = _current.get()
    _current.set(None)
    if lease is not None:
        lease.finish(bool(settled))


def reset() -> None:
    with _lock:
        _hits.clear()
    _current.set(None)
