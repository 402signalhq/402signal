"""Public per-host endpoint pages: catalog facts plus public probe aggregates.

Read-only over the shadow catalog and the probe history. Only public
(organic) probes from trusted observation classes are counted, the same rule
`history.summary` uses, so lab and sponsored traffic never appears here.
Aggregates only: no payer identities, no request bodies, no authorizations.

Neutrality rule: nothing a seller pays for changes these numbers. The method
is published on every page and in the monthly report.
"""
from __future__ import annotations

import re
import threading
import time
from collections import Counter
from urllib.parse import quote, urlsplit

from live402 import history, shadow, site_chrome

HOST_RE = re.compile(
    r"^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$"
)
DAY = 86400
WINDOW = 30 * DAY
CACHE_S = 300
INDEX_LIMIT = 100
LISTINGS_SHOWN = 25
SITEMAP_LIMIT = 2000
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
    "eip155:4217": "Tempo",
    "eip155:4663": "Robinhood Chain",
    "eip155:42161": "Arbitrum One",
    "eip155:42220": "Celo",
    "eip155:43114": "Avalanche C-Chain",
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "Solana",
    "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=": "Algorand MainNet",
    "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k": "Algorand MainNet",
    "xrpl:0": "XRP Ledger",
    "stellar:pubnet": "Stellar",
}

_lock = threading.Lock()
_cache: dict[str, tuple[float, object]] = {}
esc = site_chrome.esc


def normalize_host(raw) -> str | None:
    text = str(raw or "").strip().lower().rstrip(".")
    if not text or len(text) > 253 or not HOST_RE.match(text):
        return None
    return text


def host_of(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").lower()
    except Exception:
        return ""


def network_name(network: str | None) -> str:
    if not network:
        return "unknown"
    return NETWORK_NAMES.get(network, network if len(network) <= 24 else network[:21] + "...")


def _cached(key: str, builder):
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < CACHE_S:
            return hit[1]
    value = builder()
    with _lock:
        if len(_cache) > 2048:
            _cache.clear()
        _cache[key] = (now, value)
    return value


def reset_cache() -> None:
    with _lock:
        _cache.clear()


def _host_patterns(host: str) -> tuple[str, str, str]:
    base = "https://" + host
    return base, base + "/%", base + "?%"


def _catalog_rows(host: str) -> list[tuple]:
    exact, path_like, query_like = _host_patterns(host)
    with shadow._lock:
        conn = shadow._connect()
        rows = conn.execute(
            "SELECT id, canonical_url, service_name, capability, input_schema_present, status, first_seen, last_seen "
            "FROM resources WHERE canonical_url = ? OR canonical_url LIKE ? OR canonical_url LIKE ?",
            (exact, path_like, query_like),
        ).fetchall()
        rows = [r for r in rows if host_of(r[1]) == host]
        ids = [r[0] for r in rows]
        claims: list[tuple] = []
        events: dict[str, int] = {}
        if ids:
            for start in range(0, len(ids), 500):
                chunk = ids[start:start + 500]
                marks = ",".join("?" * len(chunk))
                claims.extend(conn.execute(
                    "SELECT resource_id, network, rail FROM accept_claims WHERE resource_id IN (%s)" % marks, chunk
                ).fetchall())
            since = int(time.time()) - WINDOW
            for event, count in conn.execute(
                "SELECT event, count(*) FROM claim_events WHERE ts >= ? AND (canonical_url = ? OR canonical_url LIKE ? OR canonical_url LIKE ?) GROUP BY event",
                (since, exact, path_like, query_like),
            ).fetchall():
                events[str(event)] = int(count)
    return [rows, claims, events]


def _probe_rows(host: str) -> tuple[list[tuple], int, int]:
    exact, path_like, query_like = _host_patterns(host)
    since = int(time.time()) - WINDOW
    with history._lock:
        conn = history._connect()
        probes = conn.execute(
            "SELECT url, ts, live, latency_ms, miss_reason, rail FROM probes WHERE ts >= ? "
            "AND (url = ? OR url LIKE ? OR url LIKE ?) AND trust_class IN %s AND traffic_class IN %s"
            % (history._TRUSTED_SQL, history._PUBLIC_TRAFFIC_SQL),
            (since, exact, path_like, query_like),
        ).fetchall()
        states = conn.execute(
            "SELECT url, payTo_changed_at, price_changed_at FROM url_state WHERE url = ? OR url LIKE ? OR url LIKE ?",
            (exact, path_like, query_like),
        ).fetchall()
    probes = [p for p in probes if host_of(p[0]) == host]
    recipient_changes = sum(1 for s in states if s[1] and int(s[1]) >= since and host_of(s[0]) == host)
    price_changes = sum(1 for s in states if s[2] and int(s[2]) >= since and host_of(s[0]) == host)
    return probes, recipient_changes, price_changes


def _percentile(values: list[int], q: float) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(q * len(ordered)))]


def host_facts(host: str) -> dict | None:
    """Catalog and public-observation facts for one host, or None when the host has no listings."""
    host = normalize_host(host)
    if host is None:
        return None

    def build():
        rows, claims, events = _catalog_rows(host)
        if not rows:
            return None
        networks: Counter = Counter()
        for _, network, rail in claims:
            networks[network or rail or "unknown"] += 1
        listings = sorted(rows, key=lambda r: (r[7] or 0), reverse=True)
        probes, recipient_changes, price_changes = _probe_rows(host)
        live = [p for p in probes if p[2]]
        latencies = [int(p[3]) for p in live if p[3] is not None]
        misses = Counter(str(p[4]) for p in probes if not p[2] and p[4])
        return {
            "host": host,
            "listings": len(rows),
            "active": sum(1 for r in rows if (r[5] or "active") == "active"),
            "with_schema": sum(1 for r in rows if r[4]),
            "networks": [(network_name(n), c) for n, c in networks.most_common(6)],
            "first_seen": min((r[6] for r in rows if r[6]), default=None),
            "last_seen": max((r[7] for r in rows if r[7]), default=None),
            "sample": [
                {"url": r[1], "name": r[2], "capability": r[3], "schema": bool(r[4]), "status": r[5] or "active"}
                for r in listings[:LISTINGS_SHOWN]
            ],
            "probes": len(probes),
            "live": len(live),
            "live_rate": (len(live) / len(probes)) if probes else None,
            "p50_ms": _percentile(latencies, 0.5),
            "p95_ms": _percentile(latencies, 0.95),
            "last_live_ts": max((int(p[1]) for p in live), default=None),
            "top_miss": misses.most_common(1)[0][0] if misses else None,
            # Observed: a live challenge differed from 402Signal's previous trusted observation
            # of the same URL (the url_state change clocks). Listed: a discovery feed's claim for
            # a URL changed (catalog claim events). Never summed; they are different facts.
            "price_changes": price_changes,
            "recipient_changes": recipient_changes,
            "price_changes_listed": int(events.get("price_changed", 0)),
            "recipient_changes_listed": int(events.get("payTo_changed", 0)),
            "generated_at": int(time.time()),
        }

    return _cached("host:" + host, build)


def index_hosts() -> list[dict]:
    """Hosts by listing count with public observation counts. Cached."""

    def build():
        counts: Counter = Counter()
        with shadow._lock:
            conn = shadow._connect()
            for (url,) in conn.execute("SELECT canonical_url FROM resources WHERE status = 'active' OR status IS NULL"):
                host = host_of(url)
                if host and HOST_RE.match(host):
                    counts[host] += 1
        since = int(time.time()) - WINDOW
        probes: Counter = Counter()
        live: Counter = Counter()
        with history._lock:
            conn = history._connect()
            for url, is_live in conn.execute(
                "SELECT url, live FROM probes WHERE ts >= ? AND trust_class IN %s AND traffic_class IN %s"
                % (history._TRUSTED_SQL, history._PUBLIC_TRAFFIC_SQL),
                (since,),
            ):
                host = host_of(url)
                if host:
                    probes[host] += 1
                    if is_live:
                        live[host] += 1
        out = []
        for host, n in counts.most_common(INDEX_LIMIT):
            out.append({
                "host": host,
                "listings": n,
                "probes": probes.get(host, 0),
                "live_rate": (live.get(host, 0) / probes[host]) if probes.get(host) else None,
            })
        return out

    return _cached("index", build)


def _ago(ts: int | None, now: int | None = None) -> str:
    if not ts:
        return "never"
    now = now or int(time.time())
    delta = max(0, now - int(ts))
    if delta < 3600:
        return "%d min ago" % max(1, delta // 60)
    if delta < DAY:
        return "%d h ago" % (delta // 3600)
    return "%d d ago" % (delta // DAY)


def _pct(value: float | None) -> str:
    return "n/a" if value is None else "%.1f%%" % (100.0 * value)


def _ms(value: int | None) -> str:
    return "n/a" if value is None else "%d ms" % int(value)


def _page(title: str, description: str, canonical: str, body: str, *, wide: bool = True) -> str:
    return (
        '<!doctype html>\n<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />'
        "<title>%s</title>" % esc(title)
        + '<meta name="description" content="%s" />' % esc(description)
        + '<link rel="canonical" href="%s" />' % esc(canonical)
        + '<meta property="og:title" content="%s" /><meta property="og:description" content="%s" />' % (esc(title), esc(description))
        + '<meta property="og:url" content="%s" /><meta property="og:type" content="website" /><meta property="og:site_name" content="402Signal" />' % esc(canonical)
        + '<meta property="og:image" content="https://402signal.com/og.png" /><meta name="twitter:card" content="summary_large_image" /><meta name="twitter:site" content="@402Signal" />'
        + '<link rel="icon" href="/favicon.svg" type="image/svg+xml" /><link rel="stylesheet" href="/styles.css" /></head>'
        + '<body><a class="skip-link" href="#main">Skip to content</a><div class="page%s customer-site endpoint-page">' % (" wide" if wide else "")
        + site_chrome.header_html()
        + '<main id="main">' + body + "</main>"
        + site_chrome.footer_html()
        + "</div></body></html>\n"
    )


METHOD_NOTE = (
    "<p class=\"note\">Listings come from the public discovery feeds (CDP, PayAI, GoPlausible). Observations are unpaid GET "
    "probes 402Signal made on behalf of buyers in the last 30 days, from Ashburn, with redirects refused; live means the seller "
    "answered with a valid x402 challenge. Lab and sponsored traffic is excluded. Nothing a seller pays for changes these numbers. "
    "A price change or recipient change is <em>observed</em> when the amount or payTo in a live challenge differs from "
    "402Signal's previous trusted observation of the same URL within the 30-day window; a <em>listed</em> change is a "
    "discovery feed's claim for a URL changing, counted separately and never as an observation. "
    "<a href=\"/insights/state-of-x402-endpoints-2026-09#method\">Method</a> · <a href=\"/developers/check-api-listing\">Check a listing yourself, unpaid</a></p>"
)


def render_host_html(host: str) -> str | None:
    facts = host_facts(host)
    if not facts:
        return None
    host = facts["host"]
    canonical = "https://402signal.com/endpoints/" + quote(host, safe="")
    badge = "https://402signal.com/endpoints/%s/badge.svg" % quote(host, safe="")
    stats = (
        '<div class="stat-strip"><div><b>%d</b><span>listings in the catalog (%d active)</span></div>'
        '<div><b>%d</b><span>public probes in 30 days</span></div>'
        '<div><b>%s</b><span>answered with a live 402 challenge</span></div>'
        '<div><b>%s</b><span>median time to the challenge (p95 %s)</span></div></div>'
        % (facts["listings"], facts["active"], facts["probes"], esc(_pct(facts["live_rate"])), esc(_ms(facts["p50_ms"])), esc(_ms(facts["p95_ms"])))
    )
    networks = ", ".join("%s (%d)" % (esc(n), c) for n, c in facts["networks"]) or "none declared"
    rows = []
    for item in facts["sample"]:
        path = urlsplit(item["url"]).path or "/"
        if urlsplit(item["url"]).query:
            path += "?" + urlsplit(item["url"]).query
        check = "/developers?endpoint=%s#sellers" % quote(item["url"], safe="")
        rows.append(
            "<tr><td><code>%s</code></td><td>%s</td><td>%s</td><td>%s</td><td><a href=\"%s\">Check</a></td></tr>"
            % (esc(path[:120]), esc(item["name"] or ""), esc(item["capability"] or "unknown"), "yes" if item["schema"] else "no", esc(check))
        )
    if facts["probes"]:
        observed = (
            "<p>%d public probes over 30 days, %d live (%s). Median %s to the challenge, p95 %s. Last live answer %s.%s</p>"
            % (facts["probes"], facts["live"], esc(_pct(facts["live_rate"])), esc(_ms(facts["p50_ms"])), esc(_ms(facts["p95_ms"])),
               esc(_ago(facts["last_live_ts"])),
               (" Most common miss: <code>%s</code>." % esc(facts["top_miss"])) if facts["top_miss"] else "")
        )
    else:
        observed = "<p>No public probes in the last 30 days. Numbers appear here once buyers' checks reach this host; nothing is inferred from the catalog alone.</p>"
    changes = (
        "<p>Observed changes in 30 days, where a live challenge differed from 402Signal's previous trusted observation "
        "of the same URL: price %d, recipient %d. Listed changes in the same window, where a discovery feed's claim for a "
        "URL changed (a catalog claim, not an observation): price %d, recipient %d.</p>"
        % (facts["price_changes"], facts["recipient_changes"], facts["price_changes_listed"], facts["recipient_changes_listed"])
    )
    body = (
        '<section class="hero compact"><p class="eyebrow">Endpoint readiness</p><h1>%s</h1>'
        '<p class="lede">How this seller looks from the buyer\'s side: what it lists, and what 402Signal observed when buyers asked.</p></section>' % esc(host)
        + '<section class="block" id="facts">' + stats
        + "<p>Networks declared across listings: %s. First listed %s; last seen in a feed %s. %d of %d listings carry an input schema.</p></section>"
        % (networks, esc(_ago(facts["first_seen"])), esc(_ago(facts["last_seen"])), facts["with_schema"], facts["listings"])
        + '<section class="block" id="observed"><h2>Public observations, 30 days</h2>' + observed + changes + "</section>"
        + '<section class="block" id="listings"><h2>Listings</h2><p>The %d most recently seen of %d.</p><div class="table-scroll"><table><thead><tr><th scope="col">Path</th><th scope="col">Name</th><th scope="col">Capability</th><th scope="col">Schema</th><th scope="col">Readiness</th></tr></thead><tbody>%s</tbody></table></div></section>'
        % (len(facts["sample"]), facts["listings"], "".join(rows))
        + '<section class="block" id="badge"><h2>Badge</h2><p>Sellers may embed the live badge; it reads the same public numbers and never changes with payment.</p>'
        '<pre class="code"><code>![402Signal readiness](%s)</code></pre><p><img src="%s" alt="402Signal readiness badge for %s" width="240" height="20" /></p></section>'
        % (esc(badge), esc("/endpoints/%s/badge.svg" % quote(host, safe="")), esc(host))
        + '<section class="block" id="method"><h2>Method and neutrality</h2>' + METHOD_NOTE
        + '<p>Operate this host? <a href="mailto:ross@402signal.com?subject=%s">Claim this page</a> to be named as a reference seller and to receive the monthly numbers for your host by email. Public data stays the same either way.</p></section>'
        % esc(quote("claim " + host))
    )
    return _page(
        "%s · x402 endpoint readiness · 402Signal" % host,
        "Listings, networks and 30-day public probe results for %s as seen by buyers through 402Signal." % host,
        canonical, body,
    )


INDEX_SORTS = {
    "listings": lambda h: (-h["listings"], h["host"]),
    "probes": lambda h: (-h["probes"], -h["listings"], h["host"]),
    "live": lambda h: (-(h["live_rate"] if h["live_rate"] is not None else -1.0), -h["probes"], h["host"]),
}


def render_index_html(sort: str | None = None) -> str:
    key = sort if sort in INDEX_SORTS else "listings"
    hosts = sorted(index_hosts(), key=INDEX_SORTS[key])
    rows = "".join(
        '<tr><td><a href="/endpoints/%s">%s</a></td><td>%d</td><td>%d</td><td>%s</td></tr>'
        % (esc(quote(h["host"], safe="")), esc(h["host"]), h["listings"], h["probes"], esc(_pct(h["live_rate"])))
        for h in hosts
    )

    def head(col: str, label: str) -> str:
        if col == key:
            return '<th scope="col" aria-sort="descending">%s</th>' % esc(label)
        return '<th scope="col"><a href="/endpoints?sort=%s">%s</a></th>' % (col, esc(label))

    body = (
        '<section class="hero compact"><p class="eyebrow">Endpoints</p><h1>Sellers as buyers see them.</h1>'
        '<p class="lede">One page per host: catalog listings, declared networks, and what 402Signal observed in the last 30 days when buyers asked. Aggregates only.</p></section>'
        '<section class="block" id="hosts"><div class="table-scroll"><table><thead><tr><th scope="col">Host</th>%s%s%s</tr></thead><tbody>%s</tbody></table></div>'
        "<p>The %d hosts with the most active listings, sorted by %s. Hosts without public probes show n/a until buyers' checks reach them. Operate one of them? Open its page and claim it.</p></section>"
        '<section class="block" id="method"><h2>Method and neutrality</h2>%s</section>'
        % (head("listings", "Listings"), head("probes", "Public probes, 30 d"), head("live", "Live"), rows, len(hosts),
           {"listings": "listings", "probes": "public probes", "live": "live rate"}[key], METHOD_NOTE)
    )
    return _page(
        "Endpoint readiness by host · 402Signal",
        "Catalog listings and 30-day public probe results for the largest x402 sellers, one page per host.",
        "https://402signal.com/endpoints", body,
    )


def sitemap_xml() -> str:
    hosts = index_hosts()[:SITEMAP_LIMIT]
    urls = "".join(
        "  <url><loc>https://402signal.com/endpoints/%s</loc></url>\n" % esc(quote(h["host"], safe="")) for h in hosts
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        "  <url><loc>https://402signal.com/endpoints</loc></url>\n" + urls + "</urlset>\n"
    )


def badge_svg(host: str) -> str | None:
    facts = host_facts(host)
    if not facts:
        return None
    if facts["probes"]:
        value = "live %s · %s" % (_pct(facts["live_rate"]), _ms(facts["p50_ms"]))
        color = "#2f8f8a" if (facts["live_rate"] or 0) >= 0.95 else "#b8892b"
    else:
        value = "no public data yet"
        color = "#6b6b6b"
    label = "402Signal"
    left = 7 * len(label) + 14
    right = 7 * len(value) + 14
    width = left + right
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="20" role="img" aria-label="%s: %s">'
        '<title>%s: %s</title>'
        '<rect width="%d" height="20" rx="3" fill="#1c1c22"/>'
        '<rect x="%d" width="%d" height="20" rx="3" fill="%s"/>'
        '<rect x="%d" width="6" height="20" fill="%s"/>'
        '<g fill="#f7ebd4" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">'
        '<text x="%d" y="14" text-anchor="middle">%s</text>'
        '<text x="%d" y="14" text-anchor="middle">%s</text></g></svg>'
        % (width, esc(label), esc(value), esc(label), esc(value), width, left, right, color, left, color,
           left // 2, esc(label), left + right // 2, esc(value))
    )
