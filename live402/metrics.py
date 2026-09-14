"""Private operator counters. Not a public scoreboard.

Counters are coarse labels only: never buyer wallets, payer addresses,
authorizations, request bodies, or client IPs. They are process-local and
flushed by the writer maintenance loop into the session database table
metric_counters(day, name, n). scripts/organic_rollup.py reads that table
together with durable session windows and history probes.

Names in use:
  session.open.<traffic>        hosted session windows opened
  session.hop.<traffic>         hops served from a window
  obs_cache.<hit|miss>.<traffic> 20 s observation cache on /route probes
  discovery_cache.<hit|miss>    shared upstream discovery search cache
  route.settled.<traffic>       settled checking fees, with or without a receipt
  route.qualified.<traffic>     settled checks that returned a durable signed receipt
  route.miss.<traffic>          completed normal misses (not settled)
  route.unqualified.<traffic>   other unbilled outcomes
  route.probe_capacity.<traffic> shed for probe capacity
  http429.<endpoint>.<reason>   429 reason mix
  payment.long_window.<rail>    authorizations valid > 900 s (observe before enforcing)
  payer_quota.exhausted.<traffic> verified payers over the unsettled attempt budget
"""

from __future__ import annotations

import json
import re
import sys
import threading
import time

MAX_NAMES = 512
_NAME_RE = re.compile(r"[a-z0-9_.:-]{1,120}\Z")
_lock = threading.Lock()
_counts: dict[str, int] = {}


def slug(text) -> str:
    raw = re.sub(r"[^a-z0-9]+", "_", str(text or "").lower()).strip("_")
    return raw[:48] or "unknown"


def traffic_label(value: str | None = None) -> str:
    """The counter label for the current request: its server-assigned traffic
    class, or "self" when the verified payer is one of the operator's own
    wallets (the observations stay organic; only the demand accounting moves)."""
    if value is None:
        try:
            from live402 import reqctx

            if reqctx.self_payer.get():
                return "self"
            value = reqctx.traffic_class.get()
        except Exception:
            value = ""
    return slug(value or "unclassified")


def inc(name: str, n: int = 1) -> None:
    if not isinstance(name, str) or not _NAME_RE.fullmatch(name):
        return
    try:
        amount = int(n)
    except (TypeError, ValueError):
        return
    if amount <= 0:
        return
    with _lock:
        if name not in _counts and len(_counts) >= MAX_NAMES:
            return
        _counts[name] = _counts.get(name, 0) + amount


def snapshot(reset: bool = False) -> dict[str, int]:
    with _lock:
        out = dict(_counts)
        if reset:
            _counts.clear()
    return out


def flush() -> dict[str, int]:
    """Persist and reset. Counts are restored if persistence fails."""
    counts = snapshot(reset=True)
    if not counts:
        return counts
    day = time.strftime("%Y-%m-%d", time.gmtime())
    try:
        from live402 import session

        session.add_counters(day, counts)
    except Exception:
        with _lock:
            for key, value in counts.items():
                _counts[key] = _counts.get(key, 0) + value
        raise
    return counts


def log_line(counts: dict[str, int]) -> None:
    sys.stderr.write(
        "organic_metrics %s\n" % json.dumps(counts, sort_keys=True, separators=(",", ":"))
    )
