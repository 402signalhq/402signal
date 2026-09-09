"""Shared human-site chrome. Presentation only; never changes payment evidence."""
from __future__ import annotations

import html as html_mod
import re
from html.parser import HTMLParser
from urllib.parse import urlsplit

CONTACT_EMAIL = "ross@402signal.com"
CONTACT_MAILTO = "mailto:ross@402signal.com"
NAV = (("/#product", "Product"), ("/developers", "Developers"), ("/catalog", "Explore"), ("/#pricing", "Pricing"), ("/how#trust", "Trust"))
FOOTER = (
    ("https://github.com/402signalhq/402signal", "GitHub", True),
    ("https://x.com/402Signal", "@402Signal", True),
    ("/how", "How it works", False),
    ("/openapi.json", "OpenAPI", False),
    ("/mcp.json", "MCP", False),
    ("/transparency", "Transparency", False),
    ("/contact", "Contact", False),
    ("/contact#security", "Security reporting", False),
    ("https://github.com/402signalhq/402signal/blob/main/LICENSE", "License", True),
    (CONTACT_MAILTO, CONTACT_EMAIL, False),
)
LISTED_ON = (
    ("https://glama.ai/mcp/servers/402signalhq/402signal", "Glama"),
    ("https://registry.modelcontextprotocol.io/?q=402signal", "MCP Registry"),
    ("https://github.com/Haustorium12/gold-402/blob/main/directory/aggregators.md", "Gold-402"),
    ("https://smithery.ai/servers/live402/signal", "Smithery"),
    ("https://agentic.market/services/402signal-com", "Agentic Market"),
    ("https://github.com/michielpost/x402-dev/blob/master/Projects.md", "x402-dev"),
    ("https://facilitator.goplausible.xyz/dashboard/bazaar?q=402signal", "GoPlausible"),
)


def esc(value) -> str:
    return html_mod.escape("" if value is None else str(value), quote=True)


def header_html(current: str = "") -> str:
    if current in ("/transparency", "/how"):
        current = "/how#trust"
    links = []
    for href, label in NAV:
        cur = ' aria-current="page"' if current == href else ""
        links.append('<a href="%s"%s>%s</a>' % (esc(href), cur, esc(label)))
    return ('<header class="site"><a class="brand" href="/"><span class="mark">402</span>'
            '<span class="brand-name">402Signal</span></a><nav class="nav" aria-label="Primary">'
            + "".join(links) + '</nav></header>')


def footer_html(current: str = "") -> str:
    links = []
    for href, label, external in FOOTER:
        rel = ' rel="noopener noreferrer"' if external else ""
        cur = ' aria-current="page"' if current == href else ""
        links.append('<a href="%s"%s%s>%s</a>' % (esc(href), rel, cur, esc(label)))
    return '<footer class="foot"><p>402Signal</p><p>' + "".join(links) + '</p></footer>'


def listed_on_items_html() -> str:
    return "\n".join('<a href="%s" rel="noopener noreferrer">%s</a>' % (esc(href), esc(label)) for href, label in LISTED_ON)


def listed_on_row_html() -> str:
    return ('<section class="discover-row" aria-label="Public directories"><h2>Listed in</h2>'
            '<p>Directory links show where 402Signal is listed. They are not endorsements.</p>'
            '<p class="listed-on">' + listed_on_items_html() + '</p></section>')


def listed_on_html(*, title: str = "Listed in", note: str = "") -> str:
    extra = '<p class="note">%s</p>' % esc(note) if note else ""
    return '<details class="ecosystem"><summary>%s</summary><p class="listed-on">%s</p>%s</details>' % (esc(title), listed_on_items_html(), extra)


def signal_flow_html(*, variant: str = "product") -> str:
    del variant
    parts = (("Search", "Find candidates across supported x402 discovery sources."),
             ("Check", "Call candidate endpoints and read the payment requirements they return now."),
             ("Match", "Apply your network, price, latency, and invocation constraints."),
             ("Return", "Get the best qualifying route, or a typed reason nothing matched."))
    return '<section class="block" id="how-it-works"><h2>How it works</h2><div class="decision-grid">' + "".join(
        '<article class="decision-card"><h3>%s</h3><p>%s</p></article>' % (esc(title), esc(text)) for title, text in parts
    ) + '</div></section>'


# Fixed presentation for server-rendered pages. Dynamic records are not rewritten.
GENERATED_PAGE_META = {
    "/dashboard": (
        "Explore the current API index · 402Signal",
        "Inspect discovery coverage and recent index state. Catalog entries are not fresh offer checks or payment endorsements.",
        "Catalog overview",
        "This is an index snapshot, not a recommendation to pay. Use Explore to inspect an endpoint, or the developer guide to run a supported check.",
        "/catalog", "Explore endpoints"),
    "/route": (
        "Build a supported buyer check · 402Signal",
        "Learn how to request a qualifying paid API observation, verify it locally, and keep seller payment in your own buyer.",
        "HTTP routing interface",
        "Viewing this page does not submit a route, connect a wallet or authorize payment. Start with an unpaid request or run the offline buyer checks.",
        "/developers#route-binding", "Choose the buyer guide"),
    "/transparency": (
        "Inspect decision checkpoints · 402Signal PQ Trust",
        "Inspect public checkpoints and Algorand anchor status. Private observation records support review of checked offers, not surveillance of every agent action.",
        "Public evidence viewer",
        "This viewer shows checkpoint history, not private purchases or every action an agent took. Keep the original request, receipt and reveal to investigate a checked offer. Pending anchors are not confirmed.",
        "/how#trust", "What this evidence establishes"),
}


class _Canonical(HTMLParser):
    def __init__(self):
        super().__init__()
        self.path = None

    def handle_starttag(self, tag, attrs):
        data = dict(attrs)
        if tag != "link" or data.get("rel") != "canonical":
            return
        try:
            url = urlsplit(data.get("href", ""))
            if url.scheme == "https" and url.netloc == "402signal.com" and not url.query and not url.fragment:
                path = url.path.removesuffix(".html")
                if path in GENERATED_PAGE_META:
                    self.path = path
        except ValueError:
            return


def prepare_generated_html(document: str) -> str:
    """Idempotent head/intro refresh for three known human pages only.

    Called by the existing HTML presentation pass before asset versioning.
    Never runs on JSON responses and never parses or edits a stored proof.
    All inserted values are developer-owned constants; no request data is used.
    """
    head = re.search(r"<head\b[^>]*>(.*?)</head\s*>", document, re.S | re.I)
    if not head:
        return document
    parser = _Canonical()
    parser.feed(head.group(1))
    if parser.path not in GENERATED_PAGE_META:
        return document
    title, description, label, explanation, href, action = GENERATED_PAGE_META[parser.path]
    inner = re.sub(r"<title\b[^>]*>.*?</title\s*>", "", head.group(1), flags=re.S | re.I)
    # Remove only presentation metadata inside the actual head, not body records.
    def keep_meta(match):
        class Reader(HTMLParser):
            attributes = {}
            def handle_starttag(self, tag, attrs):
                self.attributes = dict(attrs)
        reader = Reader()
        reader.feed(match.group(0))
        attrs = reader.attributes
        key = attrs.get("name") or attrs.get("property")
        return "" if key in {"description", "og:title", "og:description", "twitter:title", "twitter:description"} else match.group(0)
    inner = re.sub(r"<meta\b[^>]*>", keep_meta, inner, flags=re.I)
    metadata = ('<title>%s</title><meta name="description" content="%s" />'
                '<meta property="og:title" content="%s" /><meta property="og:description" content="%s" />'
                '<meta name="twitter:title" content="%s" /><meta name="twitter:description" content="%s" />') % tuple(
                    esc(v) for v in (title, description, title, description, title, description))
    out = document[:head.start(1)] + inner + metadata + document[head.end(1):]
    out = re.sub(r'<header\s+class=[\"\']site[\"\'][^>]*>.*?</header\s*>', lambda _: header_html(parser.path), out, count=1, flags=re.S | re.I)
    if 'id="customer-page-context"' not in out:
        context = ('<aside id="customer-page-context" class="page-context"><p class="eyebrow">%s</p>'
                   '<p>%s</p><a href="%s">%s</a></aside>') % tuple(esc(v) for v in (label, explanation, href, action))
        out = re.sub(r"<main\b[^>]*>", lambda m: m.group(0) + context, out, count=1, flags=re.I)
    return out
