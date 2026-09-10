"""Permanent guides derived from the reviewed developer page, never request HTML."""
from html import escape
from html.parser import HTMLParser
from pathlib import Path
import re

STATIC = Path(__file__).resolve().parent / 'static'
# Fixed routes, not a filesystem path derived from a request.
GUIDES = {
    'test-buyer': ('quickstart', 'Test a buyer without a funded wallet', 'Run offline offer-change checks, connect a trusted adapter and interpret measured results.'),
    'check-offer': ('route-binding', 'Add an offer check before payment', 'Wrap existing sign: observe, bind, locally verify, then wallet. Fail closed. Payment-path owners, not merchants.'),
    'native-mpp': ('native-mpp', 'Select the intended MPP charge', 'Preserve complete offers and require one explicit supported match before authorization.'),
    'sessions-and-invoices': ('batch-support', 'Check a session or invoice commitment', 'Separate seller call prices, cumulative spend, deposited capital and native fees.'),
    'check-group-offer': ('check-group-offer', 'Check a group offer', 'Validate a grouped seller challenge from the live wire. Send caps, not a merchant profile.'),
    'check-api-listing': ('sellers', 'Check your API listing', 'Use free discovery and listed-endpoint readiness without initiating a seller payment.'),
    'recover-routing-attempt': ('recovery', 'Recover a lost 402Signal response', 'Recover the original routing attempt and inspect its checking-fee outcome without signing again.'),
    'reconcile-seller-payment': ('seller-recovery', 'Reconcile a seller payment after a timeout', 'Inspect the original payment without resubmitting or claiming that a missing response was recovered.'),
    'interfaces': ('interfaces', 'Choose HTTP, SDK or MCP', 'Choose the smallest applicable free or authorized paid interface.'),
    'evidence': ('pq-trust', 'Verify a retained decision record', 'Compare retained evidence with independent policy and wallet records; distinguish receipts from anchors.'),
    'operating-limits': ('policy-guide', 'Operate a buyer within explicit limits', 'Keep spending controls, private evidence and recovery state in trusted application code.'),
    'supported-profiles': ('compatibility', 'Check supported profiles and releases', 'Distinguish source support, published packages, hosted availability and dated qualification.'),
}
PATHS = {'/developers/' + slug: slug for slug in GUIDES}
MARKDOWN_PATHS = {path + '.md': slug for path, slug in PATHS.items()}

def panel(slug):
    source = (STATIC / 'developers.html').read_text(encoding='utf-8')
    ident = GUIDES[slug][0]
    match = re.search(r'<section class="block guide-panel" id="' + ident + r'".*?</section>', source, re.S)
    if match is None:
        raise ValueError('missing reviewed guide')
    content = match.group()
    for other, (anchor, _, _) in GUIDES.items():
        content = content.replace('href="#' + anchor + '"', 'href="/developers/' + other + '"')
        content = content.replace('https://402signal.com/developers#' + anchor, 'https://402signal.com/developers/' + other)
    from live402 import capabilities
    return capabilities.apply_developers_copy(content)

def render(slug):
    source = (STATIC / 'developers.html').read_text(encoding='utf-8')
    _, title, description = GUIDES[slug]
    url = 'https://402signal.com/developers/' + slug
    head, rest = source.split('<main id="main">', 1)
    footer = rest.split('</main>', 1)[1]
    head = re.sub(r'<title>.*?</title>', '<title>' + escape(title) + ' · 402Signal</title>', head)
    for attribute, key, value in [('name', 'description', description), ('property', 'og:title', title), ('property', 'og:description', description), ('property', 'og:url', url)]:
        head = re.sub(r'<meta ' + attribute + '="' + key + r'" content="[^"]*" />', '<meta ' + attribute + '="' + key + '" content="' + escape(value, quote=True) + '" />', head)
    head = head.replace('rel="canonical" href="https://402signal.com/developers"', 'rel="canonical" href="' + url + '"')
    head = head.replace('</head>', '<link rel="alternate" type="text/markdown" href="' + url + '.md" /></head>')
    intro = '<section class="hero compact"><p class="eyebrow"><a href="/developers">Developer guides</a></p><h1>' + escape(title) + '</h1><p class="lede">' + escape(description) + '</p><p><a href="' + url + '.md">Read as Markdown</a> · <a href="/capabilities.json">Packages and capability record</a></p></section>'
    return head + '<main id="main">' + intro + panel(slug) + '</main>' + footer

class _Markdown(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []; self.pre = False; self.links = []
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ('h1','h2','h3','h4'): self.parts.append('\n\n' + '#' * int(tag[1]) + ' ')
        elif tag in ('p','div','section','dl','table','tr','details'): self.parts.append('\n\n')
        elif tag in ('li','dt'): self.parts.append('\n- ')
        elif tag in ('td','th'): self.parts.append(' | ')
        elif tag == 'br': self.parts.append('\n')
        elif tag == 'pre': self.pre = True; self.parts.append('\n\n```\n')
        elif tag == 'code' and not self.pre: self.parts.append('`')
        elif tag == 'a': self.links.append(attrs.get('href','')); self.parts.append('[')
    def handle_endtag(self, tag):
        if tag == 'pre': self.pre = False; self.parts.append('\n```\n\n')
        elif tag == 'code' and not self.pre: self.parts.append('`')
        elif tag == 'a': self.parts.append('](' + self.links.pop() + ')')
        elif tag in ('p','h1','h2','h3','h4','summary','form'): self.parts.append('\n\n')
    def handle_data(self, data):
        self.parts.append(data if self.pre else re.sub(r'\s+', ' ', data))

def markdown(slug):
    parser = _Markdown(); parser.feed(panel(slug))
    return '# ' + GUIDES[slug][1] + '\n\n' + GUIDES[slug][2] + '\n\nCanonical: https://402signal.com/developers/' + slug + '\n\n' + re.sub(r'\n[ \t]*\n(?:[ \t]*\n)+', '\n\n', ''.join(parser.parts)).strip() + '\n'
