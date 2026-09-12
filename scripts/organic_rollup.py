#!/usr/bin/env python3
"""Private weekly organic rollup for the operator. Not a public scoreboard.

Reads the session and history SQLite files read-only. Output holds coarse
counters and seller URLs whose observed terms flipped. It never holds buyer
wallets, payer addresses, authorizations, observed payTo values, or requests.

    PYTHONPATH=. python3 scripts/organic_rollup.py --days 7
    PYTHONPATH=. python3 scripts/organic_rollup.py --days 7 --json
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import time
from contextlib import closing
from pathlib import Path

ORGANIC = "organic"
SESSION_OPEN_PRICE = "$0.005"
KEEP_HOPS_PER_OPEN = 3.0
KEEP_CACHE_HIT_RATE = 0.5
TOP_FLIPS = 10
DAY = 86400


def _ro(path) -> sqlite3.Connection:
    return sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True, timeout=5)


def _has_table(conn, name: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)
    ).fetchone() is not None


def _days(since: int, until: int) -> list[str]:
    out = []
    cursor = since - (since % DAY)
    while cursor < until:
        out.append(time.strftime("%Y-%m-%d", time.gmtime(cursor)))
        cursor += DAY
    return out or [time.strftime("%Y-%m-%d", time.gmtime(since))]


def _ratio(num: int, den: int):
    return round(num / den, 4) if den else None


def session_stats(path, since: int, until: int) -> dict:
    stats = {"opens": 0, "hops": 0, "hops_per_open": None, "counters": {}}
    if not path or not Path(path).exists():
        return stats
    with closing(_ro(path)) as conn:
        if _has_table(conn, "windows"):
            row = conn.execute(
                "SELECT count(*), coalesce(sum(hop_count), 0) FROM windows "
                "WHERE traffic_class = ? AND sku = 'session' AND created_at >= ? AND created_at < ?",
                (ORGANIC, since, until),
            ).fetchone()
            stats["opens"], stats["hops"] = int(row[0]), int(row[1])
            stats["hops_per_open"] = _ratio(stats["hops"], stats["opens"])
        if _has_table(conn, "metric_counters"):
            days = _days(since, until)
            marks = ",".join("?" * len(days))
            for name, total in conn.execute(
                "SELECT name, sum(n) FROM metric_counters WHERE day IN (%s) GROUP BY name" % marks,
                days,
            ):
                stats["counters"][str(name)] = int(total)
    return stats


def _norm_pay(value):
    text = (value or "").strip()
    if not text:
        return None
    return text.lower() if text.lower().startswith("0x") else text


def flip_stats(path, since: int, until: int, top: int = TOP_FLIPS) -> list[dict]:
    """Organic observations only. Counts payTo and price changes, never values."""
    if not path or not Path(path).exists():
        return []
    with closing(_ro(path)) as conn:
        if not _has_table(conn, "probes"):
            return []
        cols = {row[1] for row in conn.execute("PRAGMA table_info(probes)")}
        if not {"traffic_class", "payTo", "amount", "url", "ts"} <= cols:
            return []
        rows = conn.execute(
            "SELECT url, payTo, amount FROM probes WHERE traffic_class = ? AND ts >= ? AND ts < ? "
            "AND (payTo IS NOT NULL OR amount IS NOT NULL) ORDER BY url, ts, id",
            (ORGANIC, since, until),
        )
        flips: dict[str, dict] = {}
        prev_url = None
        prev_pay = prev_amount = None
        for url, pay_to, amount in rows:
            pay = _norm_pay(pay_to)
            amt = (str(amount).strip() or None) if amount is not None else None
            if url != prev_url:
                prev_url, prev_pay, prev_amount = url, pay, amt
                continue
            entry = flips.setdefault(url, {"payTo_flips": 0, "price_flips": 0, "total": 0})
            if pay and prev_pay and pay != prev_pay:
                entry["payTo_flips"] += 1
                entry["total"] += 1
            if amt and prev_amount and amt != prev_amount:
                entry["price_flips"] += 1
                entry["total"] += 1
            prev_pay = pay or prev_pay
            prev_amount = amt or prev_amount
    ranked = sorted(
        ((url, v) for url, v in flips.items() if v["total"] > 0),
        key=lambda kv: (-kv[1]["total"], kv[0]),
    )[:top]
    return [{"url": url, **values} for url, values in ranked]


def price_recommendation(hops_per_open, cache_hit_rate) -> dict:
    """Week 4 rule. Never changes price; it tells the operator what the data supports."""
    if hops_per_open is None or cache_hit_rate is None:
        return {"session_open": SESSION_OPEN_PRICE, "decision": "keep",
                "reason": "insufficient organic data"}
    if hops_per_open >= KEEP_HOPS_PER_OPEN and cache_hit_rate >= KEEP_CACHE_HIT_RATE:
        return {"session_open": SESSION_OPEN_PRICE, "decision": "keep",
                "reason": "hops/open >= 3 and cache hit >= 50%"}
    if hops_per_open < KEEP_HOPS_PER_OPEN:
        return {"session_open": SESSION_OPEN_PRICE, "decision": "keep",
                "reason": "hops/open < 3; consider a $0.003 open only if a named partner refuses $0.005"}
    return {"session_open": SESSION_OPEN_PRICE, "decision": "keep",
            "reason": "cache hit < 50%; investigate observation reuse before any price change"}


def build(session_db, history_db, *, days: int = 7, now: int | None = None) -> dict:
    until = int(time.time() if now is None else now)
    since = until - int(days) * DAY
    stats = session_stats(session_db, since, until)
    counters = stats["counters"]

    def n(name: str) -> int:
        return int(counters.get(name, 0))

    cache_hits, cache_misses = n("obs_cache.hit.organic"), n("obs_cache.miss.organic")
    qualified, misses = n("route.qualified.organic"), n("route.miss.organic")
    cache_hit_rate = _ratio(cache_hits, cache_hits + cache_misses)
    return {
        "window": {"since": since, "until": until, "days": int(days)},
        "session_opens_organic": stats["opens"],
        "session_hops_organic": stats["hops"],
        "hops_per_open": stats["hops_per_open"],
        "cache_hit_rate": cache_hit_rate,
        "qualify_rate": _ratio(qualified, qualified + misses),
        "qualified_routes_organic": qualified,
        "normal_misses_organic": misses,
        "discovery_cache_hit_rate": _ratio(
            n("discovery_cache.hit"), n("discovery_cache.hit") + n("discovery_cache.miss")
        ),
        "rate_limited_429_mix": {
            key[len("http429."):]: value for key, value in sorted(counters.items())
            if key.startswith("http429.")
        },
        "top_flip_urls": flip_stats(history_db, since, until),
        "price": price_recommendation(stats["hops_per_open"], cache_hit_rate),
    }


def _pct(value) -> str:
    return "n/a" if value is None else "%.1f%%" % (100.0 * value)


def render_markdown(report: dict) -> str:
    window = report["window"]
    lines = [
        "# 402Signal organic rollup",
        "",
        "Window: %s to %s UTC (%d days). Organic traffic only. Private."
        % (time.strftime("%Y-%m-%d", time.gmtime(window["since"])),
           time.strftime("%Y-%m-%d", time.gmtime(window["until"])), window["days"]),
        "",
        "| Metric | Value |",
        "|---|---|",
        "| Session opens (organic) | %d |" % report["session_opens_organic"],
        "| Hops (organic) | %d |" % report["session_hops_organic"],
        "| Hops per open | %s |" % ("n/a" if report["hops_per_open"] is None else report["hops_per_open"]),
        "| Observation cache hit rate | %s |" % _pct(report["cache_hit_rate"]),
        "| Qualify rate | %s |" % _pct(report["qualify_rate"]),
        "| Discovery cache hit rate | %s |" % _pct(report["discovery_cache_hit_rate"]),
        "",
        "## 429 reason mix",
        "",
    ]
    mix = report["rate_limited_429_mix"]
    lines += ["| Endpoint.reason | Count |", "|---|---|"] + [
        "| %s | %d |" % (k, v) for k, v in mix.items()
    ] if mix else ["None recorded."]
    lines += ["", "## Top flip URLs", ""]
    flips = report["top_flip_urls"]
    lines += ["| URL | payTo flips | Price flips |", "|---|---|---|"] + [
        "| %s | %d | %d |" % (f["url"], f["payTo_flips"], f["price_flips"]) for f in flips
    ] if flips else ["None recorded."]
    price = report["price"]
    lines += ["", "## Session price", "",
              "Decision: **%s %s**. %s." % (price["decision"], price["session_open"], price["reason"]), ""]
    return "\n".join(lines)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--session-db", default=os.environ.get("LIVE402_SESSION_DB") or "/data/live402-session.sqlite")
    parser.add_argument("--history-db", default=os.environ.get("LIVE402_HISTORY_DB") or "/data/live402-history.sqlite")
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    report = build(args.session_db, args.history_db, days=max(1, min(92, args.days)))
    print(json.dumps(report, indent=2, sort_keys=True) if args.json else render_markdown(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
