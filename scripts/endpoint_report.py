#!/usr/bin/env python3
"""State of x402 endpoints: a read-only report from the shadow catalog and probe history.

Reads catalog.sqlite and history.sqlite (a copy from the backup bundle, or the
live paths with --live on the writer) in read-only mode and prints Markdown
plus an optional JSON summary. Aggregates only: no payer identities, no
authorizations, no request bodies. Seller URLs appear as public hosts only.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import statistics
import time
from collections import Counter
from urllib.parse import urlsplit

NETWORK_NAMES = {
    "eip155:8453": "Base",
    "eip155:1": "Ethereum",
    "eip155:10": "OP Mainnet",
    "eip155:56": "BNB Smart Chain",
    "eip155:137": "Polygon",
    "eip155:143": "Monad",
    "eip155:196": "X Layer",
    "eip155:480": "World Chain",
    "eip155:999": "HyperEVM",
    "eip155:1329": "Sei",
    "eip155:4663": "eip155:4663",
    "eip155:42161": "Arbitrum One",
    "eip155:43114": "Avalanche C-Chain",
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "Solana",
    "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=": "Algorand MainNet",
    "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k": "Algorand MainNet (short id)",
    "xrpl:0": "XRP Ledger",
    "stellar:pubnet": "Stellar",
}


def ro(path: str) -> sqlite3.Connection:
    return sqlite3.connect("file:%s?mode=ro" % path, uri=True)


def host_of(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").lower()
    except Exception:
        return ""


def pct(part, whole) -> str:
    return "%.1f%%" % (100.0 * part / whole) if whole else "n/a"


def percentile(values, q):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(q * len(ordered)))]


def catalog_section(conn, since: int) -> dict:
    out: dict = {}
    out["resources_total"] = conn.execute("SELECT count(*) FROM resources").fetchone()[0]
    out["resources_new_in_period"] = conn.execute(
        "SELECT count(*) FROM resources WHERE first_seen >= ?", (since,)).fetchone()[0]
    out["resources_by_source"] = dict(conn.execute(
        "SELECT source, count(*) FROM resource_sources GROUP BY source ORDER BY 2 DESC").fetchall())
    out["listings_with_schema"] = conn.execute(
        "SELECT count(*) FROM resources WHERE input_schema_present = 1").fetchone()[0]
    rows = conn.execute(
        "SELECT network, count(DISTINCT resource_id) FROM accept_claims GROUP BY network ORDER BY 2 DESC").fetchall()
    # Each resource contributes once per distinct network identifier, including aliases.
    total_claims = sum(n for _, n in rows)
    out["network_memberships_total"] = total_claims
    out["network_share_basis"] = "distinct_resource_network_memberships"
    out["networks"] = [
        {"network": net, "name": NETWORK_NAMES.get(net or "", net or "unknown"), "listings": n,
         "share": round(100.0 * n / total_claims, 1) if total_claims else None}
        for net, n in rows[:20]
    ]
    out["network_count"] = len(rows)
    out["facilitators_declared"] = [
        {"facilitator": f or "(none declared)", "claims": n}
        for f, n in conn.execute(
            "SELECT facilitator, count(*) FROM accept_claims GROUP BY facilitator ORDER BY 2 DESC LIMIT 8").fetchall()
    ]
    out["capabilities"] = [
        {"capability": c or "unknown", "listings": n}
        for c, n in conn.execute(
            "SELECT capability, count(*) FROM resources GROUP BY capability ORDER BY 2 DESC LIMIT 12").fetchall()
    ]
    hosts = Counter()
    for (url,) in conn.execute("SELECT canonical_url FROM resources"):
        hosts[host_of(url)] += 1
    out["hosts_total"] = len(hosts)
    out["hosts_top"] = [{"host": h, "listings": n} for h, n in hosts.most_common(12)]
    events = dict(conn.execute(
        "SELECT event, count(*) FROM claim_events WHERE ts >= ? GROUP BY event", (since,)).fetchall())
    out["claim_events_in_period"] = events
    # Listing changes to price or recipient, named. These are catalog claims, not observations.
    out["claim_changes"] = []
    for ts, url, event, source, detail in conn.execute(
        "SELECT ts, canonical_url, event, source, detail FROM claim_events "
        "WHERE ts >= ? AND event IN ('payTo_changed', 'price_changed') ORDER BY ts", (since,)).fetchall():
        parsed = None
        try:
            parsed = json.loads(detail) if detail else None
        except (TypeError, ValueError):
            parsed = None
        out["claim_changes"].append({
            "host": host_of(url), "url": url, "event": event, "source": source,
            "at": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(int(ts))),
            "detail": parsed if isinstance(parsed, dict) else (str(detail)[:200] if detail else None),
        })
    return out


def own_host(host: str) -> bool:
    """402Signal's own listings never appear in the report: exact host or a subdomain, never a substring."""
    return host == "402signal.com" or host.endswith(".402signal.com")


def usd(atomic) -> str | None:
    """Atomic USDC (6 decimals) as dollars; None when it is not a plain integer string."""
    try:
        return "$%.3f" % (int(str(atomic)) / 1_000_000)
    except (TypeError, ValueError):
        return None


def named_changes(conn, since: int) -> list[dict]:
    """Observed price and recipient changes in the period, one row per change, hosts named.

    Reads url_state for the change clocks and the observation rows for the value
    before and after each clock. Only 402signal_observed rows count; catalog claims
    never appear here. 402Signal's own endpoint is excluded.
    """
    out: list[dict] = []
    rows = conn.execute(
        "SELECT url, payTo_changed_at, price_changed_at FROM url_state "
        "WHERE (price_changed_at >= ?) OR (payTo_changed_at >= ?)", (since, since)).fetchall()
    for url, pay_at, price_at in rows:
        host = host_of(url)
        if not host or own_host(host):
            continue
        for kind, field, at in (("price", "amount", price_at), ("recipient", "payTo", pay_at)):
            if at is None or int(at) < since:
                continue
            history = conn.execute(
                "SELECT ts, value FROM observations WHERE url = ? AND field = ? AND source_type = '402signal_observed' "
                "AND value IS NOT NULL ORDER BY ts", (url, field)).fetchall()
            before = after = None
            for ts, value in history:
                if int(ts) < int(at):
                    before = value
                elif after is None:
                    after = value
            rail = conn.execute(
                "SELECT rail FROM probes WHERE url = ? AND ts >= ? ORDER BY ts LIMIT 1", (url, int(at))).fetchone()
            out.append({
                "kind": kind, "host": host, "url": url, "before": before, "after": after,
                "before_usd": usd(before) if kind == "price" else None,
                "after_usd": usd(after) if kind == "price" else None,
                "at": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(int(at))),
                "rail": (rail[0] if rail else None) or "unknown",
            })
    out.sort(key=lambda c: (c["kind"] != "recipient", c["at"]))
    return out


def host_table(rows: list, limit: int = 15) -> list[dict]:
    """Per-host summary: organic and unclassified rows, excluding labeled tests and owned hosts."""
    by_host: dict = {}
    for r in rows:
        if (r[8] or "unclassified") not in ("organic", "unclassified"):
            continue
        h = host_of(r[0])
        if not h or own_host(h):
            continue
        entry = by_host.setdefault(h, {"host": h, "probes": 0, "live": 0, "latencies": [], "urls": set()})
        entry["probes"] += 1
        entry["urls"].add(r[0])
        if r[2]:
            entry["live"] += 1
            if r[5] is not None:
                entry["latencies"].append(r[5])
    table = []
    for entry in sorted(by_host.values(), key=lambda e: (-e["probes"], e["host"]))[:limit]:
        lat = entry["latencies"]
        table.append({
            "host": entry["host"], "probes": entry["probes"], "urls": len(entry["urls"]),
            "live_rate": pct(entry["live"], entry["probes"]),
            "latency_p50_ms": int(statistics.median(lat)) if lat else None,
            "latency_p95_ms": percentile(lat, 0.95),
        })
    return table


def history_section(conn, since: int) -> dict:
    out: dict = {}
    rows = conn.execute(
        "SELECT url, ts, live, payable, invocable, latency_ms, miss_reason, rail, traffic_class "
        "FROM probes WHERE ts >= ?", (since,)).fetchall()
    out["probes"] = len(rows)
    out["distinct_urls"] = len({r[0] for r in rows})
    out["distinct_hosts"] = len({host_of(r[0]) for r in rows})
    by_class = Counter(r[8] or "unclassified" for r in rows)
    out["probes_by_traffic_class"] = dict(by_class)
    live = [r for r in rows if r[2]]
    out["live_rate"] = pct(len(live), len(rows))
    out["payable_rate"] = pct(sum(1 for r in rows if r[3]), len(rows))
    out["invocable_rate"] = pct(sum(1 for r in rows if r[4]), len(rows))
    by_rail: dict = {}
    for rail in sorted({r[7] or "unknown" for r in rows}):
        sub = [r for r in rows if (r[7] or "unknown") == rail]
        lat = [r[5] for r in sub if r[2] and r[5] is not None]
        by_rail[rail] = {
            "probes": len(sub),
            "live_rate": pct(sum(1 for r in sub if r[2]), len(sub)),
            "latency_p50_ms": int(statistics.median(lat)) if lat else None,
            "latency_p95_ms": percentile(lat, 0.95),
        }
    out["by_rail"] = by_rail
    lat_all = [r[5] for r in live if r[5] is not None]
    out["latency_p50_ms"] = int(statistics.median(lat_all)) if lat_all else None
    out["latency_p95_ms"] = percentile(lat_all, 0.95)
    out["miss_reasons"] = dict(Counter(r[6] or "unknown" for r in rows if not r[2]).most_common())
    # Per-URL stability inside the window: a URL is "flapping" when it was seen both live and not live.
    seen: dict = {}
    for r in rows:
        seen.setdefault(r[0], set()).add(bool(r[2]))
    out["urls_always_live"] = sum(1 for v in seen.values() if v == {True})
    out["urls_never_live"] = sum(1 for v in seen.values() if v == {False})
    out["urls_flapping"] = sum(1 for v in seen.values() if len(v) == 2)
    changes = conn.execute(
        "SELECT sum(payTo_changed_at >= ?), sum(price_changed_at >= ?), sum(schema_changed_at >= ?), count(*) "
        "FROM url_state", (since, since, since)).fetchone()
    out["url_state"] = {
        "tracked_urls": changes[3],
        "recipient_changes_in_period": int(changes[0] or 0),
        "price_changes_in_period": int(changes[1] or 0),
        "schema_changes_in_period": int(changes[2] or 0),
    }
    out["daily"] = [
        {"day": d, "probes": n, "live": int(l or 0)}
        for d, n, l in conn.execute(
            "SELECT date(ts, 'unixepoch') d, count(*), sum(live) FROM probes WHERE ts >= ? GROUP BY d ORDER BY d",
            (since,)).fetchall()
    ]
    out["named_changes"] = named_changes(conn, since)
    out["hosts"] = host_table(rows)
    return out


def chart_svg(report: dict) -> str:
    """One shareable chart: live rate by rail with median and p95 latency. Presentation attributes only."""
    h = report["history"]
    rails = [(rail, v) for rail, v in h["by_rail"].items() if rail != "unknown"]
    rails.sort(key=lambda kv: -kv[1]["probes"])
    width, row_h, top = 760, 54, 96
    height = top + row_h * len(rails) + 56
    ink, muted, bar, track = "#1c1c22", "#5f5f66", "#2f8f8a", "#e6e2d9"
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d" role="img" '
        'aria-label="Live rate and latency by rail, %s">' % (width, height, width, height, report["meta"]["period_label"]),
        '<rect width="%d" height="%d" fill="#fbf8f2"/>' % (width, height),
        '<text x="32" y="40" font-family="Georgia, serif" font-size="24" fill="%s">State of x402 endpoints, %s</text>' % (ink, report["meta"]["period_label"]),
        '<text x="32" y="66" font-family="Verdana, sans-serif" font-size="13" fill="%s">%s probes on %s URLs; share of probes answered with a live 402 challenge, by recorded probe rail; median and p95 time to the challenge</text>'
        % (muted, f"{h['probes']:,}", f"{h['distinct_urls']:,}"),
    ]
    for i, (rail, v) in enumerate(rails):
        y = top + i * row_h
        rate = float(v["live_rate"].rstrip("%")) if v["live_rate"] != "n/a" else 0.0
        parts.append('<text x="32" y="%d" font-family="Verdana, sans-serif" font-size="14" fill="%s">%s</text>' % (y + 22, ink, rail.capitalize()))
        parts.append('<rect x="140" y="%d" width="420" height="20" rx="4" fill="%s"/>' % (y + 8, track))
        parts.append('<rect x="140" y="%d" width="%d" height="20" rx="4" fill="%s"/>' % (y + 8, int(4.2 * rate), bar))
        parts.append('<text x="%d" y="%d" font-family="Verdana, sans-serif" font-size="13" fill="%s">%s live of %s</text>'
                     % (570, y + 22, ink, v["live_rate"], f"{v['probes']:,}"))
        parts.append('<text x="140" y="%d" font-family="Verdana, sans-serif" font-size="11" fill="%s">median %s ms, p95 %s ms to the challenge</text>'
                     % (y + 44, muted, v["latency_p50_ms"] if v["latency_p50_ms"] is not None else "n/a",
                        v["latency_p95_ms"] if v["latency_p95_ms"] is not None else "n/a"))
    us = h["url_state"]
    parts.append('<text x="32" y="%d" font-family="Verdana, sans-serif" font-size="12" fill="%s">%d observed price changes and %d observed recipient changes among %s tracked URLs. Source: 402signal.com/insights. All recorded traffic classes; see method.</text>'
                 % (height - 22, muted, us["price_changes_in_period"], us["recipient_changes_in_period"], f"{us['tracked_urls']:,}"))
    parts.append("</svg>")
    return "\n".join(parts) + "\n"


def render(report: dict) -> str:
    c, h, meta = report["catalog"], report["history"], report["meta"]
    lines = []
    lines.append("# State of x402 endpoints, %s" % meta["period_label"])
    lines.append("")
    lines.append("Source: 402Signal's shadow catalog (listings from the CDP, PayAI and GoPlausible discovery feeds) "
                 "and its own probe history for the %d days ending %s. Probes are triggered by checks and "
                 "readiness lookups, not uniform sampling; treat rates as observed, not population estimates. "
                 "Aggregates only: no buyer or payer identities." % (meta["days"], meta["until"]))
    lines.append("")
    lines.append("## What changed, named")
    lines.append("")
    changes = h.get("named_changes") or []
    if changes:
        lines.append("Observed by 402Signal's own probes, comparing successive challenges from the same URL. "
                     "Every host is treated the same way; a seller cannot pay to be left out.")
        lines.append("")
        lines.append("| Host | URL | Change | Before | After | Observed | Rail |")
        lines.append("|---|---|---|---|---|---|---|")
        for ch in changes:
            if ch["kind"] == "price":
                before = "%s (%s)" % (ch["before_usd"] or "?", ch["before"] if ch["before"] is not None else "?")
                after = "%s (%s)" % (ch["after_usd"] or "?", ch["after"] if ch["after"] is not None else "?")
            else:
                before, after = (ch["before"] or "?"), (ch["after"] or "?")
            lines.append("| %s | %s | %s | %s | %s | %s | %s |" % (
                ch["host"], ch["url"], "recipient" if ch["kind"] == "recipient" else "price", before, after, ch["at"], ch["rail"]))
        lines.append("")
    else:
        lines.append("No observed price or recipient change in the period.")
        lines.append("")
    claims = c.get("claim_changes") or []
    if claims:
        lines.append("Listing changes reported by the discovery feeds (catalog claims, not observations): " + "; ".join(
            "%s %s on %s (%s)" % (cl["host"], cl["event"].replace("_", " "), cl["at"], cl["source"] or "feed") for cl in claims) + ".")
        lines.append("")
    lines.append("## Catalog")
    lines.append("")
    lines.append("- Listings: %s across %s hosts; %s first seen in the period; %s carry an input schema."
                 % (f"{c['resources_total']:,}", f"{c['hosts_total']:,}", f"{c['resources_new_in_period']:,}",
                    pct(c["listings_with_schema"], c["resources_total"])))
    lines.append("- By discovery source: " + ", ".join("%s %s" % (k, f"{v:,}") for k, v in c["resources_by_source"].items()) + ".")
    lines.append("- Declared facilitators: %s of listings name one." % pct(
        sum(f["claims"] for f in c["facilitators_declared"] if f["facilitator"] != "(none declared)"),
        sum(f["claims"] for f in c["facilitators_declared"])))
    lines.append("")
    lines.append("### Networks by resource-network membership share (%d identifiers seen)" % c["network_count"])
    lines.append("")
    lines.append("| Network identifier | Distinct listings in this network | Membership share |")
    lines.append("|---|---:|---:|")
    for n in c["networks"][:12]:
        lines.append("| %s | %s | %s |" % (n["name"], f"{n['listings']:,}", ("%.1f%%" % n["share"]) if n["share"] is not None else "n/a"))
    lines.append("")
    lines.append("Membership shares use the sum of distinct resource-network pairs across all identifiers, "
                 "not the number of unique resources. A multi-network resource appears in several rows; "
                 "aliases remain separate. These are not unique-listing reach percentages.")
    lines.append("")
    lines.append("### Capabilities (top 10)")
    lines.append("")
    lines.append("| Capability | Listings |")
    lines.append("|---|---:|")
    for cap in c["capabilities"][:10]:
        lines.append("| %s | %s |" % (cap["capability"], f"{cap['listings']:,}"))
    lines.append("")
    lines.append("### Largest hosts by listings (top 10)")
    lines.append("")
    lines.append("| Host | Listings |")
    lines.append("|---|---:|")
    for hst in c["hosts_top"][:10]:
        lines.append("| %s | %s |" % (hst["host"], f"{hst['listings']:,}"))
    lines.append("")
    lines.append("## Liveness and terms (402Signal probes in the period)")
    lines.append("")
    lines.append("- Probes: %s over %s URLs on %s hosts (%s)." % (
        f"{h['probes']:,}", f"{h['distinct_urls']:,}", f"{h['distinct_hosts']:,}",
        ", ".join("%s %s" % (k, f"{v:,}") for k, v in sorted(h["probes_by_traffic_class"].items()))))
    lines.append("- Live 402 challenge: %s of probes; payable %s; invocable (input schema present) %s." % (
        h["live_rate"], h["payable_rate"], h["invocable_rate"]))
    lines.append("- Latency to a live challenge: p50 %s ms, p95 %s ms." % (
        h["latency_p50_ms"] if h["latency_p50_ms"] is not None else "n/a",
        h["latency_p95_ms"] if h["latency_p95_ms"] is not None else "n/a"))
    lines.append("- URLs always live in the period: %d; never live: %d; flapping: %d." % (
        h["urls_always_live"], h["urls_never_live"], h["urls_flapping"]))
    us = h["url_state"]
    lines.append("- Terms changes among %s tracked URLs: %d recipient changes, %d price changes, %d schema changes." % (
        f"{us['tracked_urls']:,}", us["recipient_changes_in_period"], us["price_changes_in_period"], us["schema_changes_in_period"]))
    lines.append("")
    lines.append("| Rail | Probes | Live | Latency p50 | Latency p95 |")
    lines.append("|---|---:|---:|---:|---:|")
    for rail, v in h["by_rail"].items():
        lines.append("| %s | %s | %s | %s | %s |" % (
            rail, f"{v['probes']:,}", v["live_rate"],
            ("%s ms" % v["latency_p50_ms"]) if v["latency_p50_ms"] is not None else "n/a",
            ("%s ms" % v["latency_p95_ms"]) if v["latency_p95_ms"] is not None else "n/a"))
    lines.append("")
    if h["miss_reasons"]:
        lines.append("Why probes missed: " + ", ".join("%s %d" % (k, v) for k, v in h["miss_reasons"].items()) + ".")
        lines.append("")
    if h.get("hosts"):
        lines.append("### Hosts, named (largest by public probes)")
        lines.append("")
        lines.append("| Host | Probes | URLs | Live | Latency p50 | Latency p95 |")
        lines.append("|---|---:|---:|---:|---:|---:|")
        for hs in h["hosts"]:
            lines.append("| %s | %s | %d | %s | %s | %s |" % (
                hs["host"], f"{hs['probes']:,}", hs["urls"], hs["live_rate"],
                ("%s ms" % hs["latency_p50_ms"]) if hs["latency_p50_ms"] is not None else "n/a",
                ("%s ms" % hs["latency_p95_ms"]) if hs["latency_p95_ms"] is not None else "n/a"))
        lines.append("")
        lines.append("Each host has a public page at https://402signal.com/endpoints/<host> with a rolling window that may differ from this report.")
        lines.append("")
    lines.append("Catalog claim events in the period: " + (", ".join(
        "%s %d" % (k, v) for k, v in sorted(c["claim_events_in_period"].items())) or "none") + ".")
    lines.append("")
    lines.append("## Method")
    lines.append("")
    lines.append("A listing is a resource advertised by a facilitator discovery feed. A probe is an unpaid HTTPS GET "
                 "(with a narrowly justified empty POST fallback) from 402Signal to the listed URL; live means the "
                 "seller answered with an x402 402 challenge; payable means the challenge carried a complete supported "
                 "offer; invocable adds an input schema. Latency is round trip to the challenge from Fly.io iad. "
                 "A price change or recipient change is observed when the amount or payTo in a live challenge "
                 "differs from 402Signal's previous trusted observation of the same URL within the period; the "
                 "before and after values come from the observation rows on either side of the change clock. A "
                 "listed change is a discovery feed's claim for a URL changing (the catalog listing, at its claimed "
                 "time); listed changes are reported separately and never counted as observed changes. Sponsored "
                 "and lab traffic classes are shown separately. Overall probe and rail rates include all recorded "
                 "traffic classes; unclassified does not establish independent customer usage. Named host "
                 "rows include organic and unclassified probes but exclude labeled tests and owned hosts. "
                 "Live endpoint pages may use different windows and filters.")
    return "\n".join(lines) + "\n"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="State of x402 endpoints report (read-only)")
    parser.add_argument("--catalog", required=True, help="path to catalog.sqlite (a copy is fine)")
    parser.add_argument("--history", required=True, help="path to history.sqlite (a copy is fine)")
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--until", type=int, default=None, help="Unix seconds; default now")
    parser.add_argument("--json", default=None, help="also write the JSON summary here")
    parser.add_argument("--svg", default=None, help="also write the shareable chart (SVG) here")
    args = parser.parse_args(argv)
    until = int(args.until or time.time())
    since = until - args.days * 86400
    with ro(args.catalog) as cat, ro(args.history) as hist:
        report = {
            "meta": {
                "days": args.days,
                "since": time.strftime("%Y-%m-%d", time.gmtime(since)),
                "until": time.strftime("%Y-%m-%d", time.gmtime(until)),
                "period_label": time.strftime("%B %Y", time.gmtime(until)),
                "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            },
            "catalog": catalog_section(cat, since),
            "history": history_section(hist, since),
        }
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2, sort_keys=True)
    if args.svg:
        with open(args.svg, "w", encoding="utf-8") as fh:
            fh.write(chart_svg(report))
    print(render(report), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
