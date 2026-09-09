"""Presentation regression tests, separate from payment and log verification."""
import unittest
from html.parser import HTMLParser
from live402 import asset_version, site_chrome


class _Metadata(HTMLParser):
    def __init__(self):
        super().__init__()
        self.titles = 0
        self.descriptions = []
        self.ids = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'title':
            self.titles += 1
        if tag == 'meta' and attrs.get('name') == 'description':
            self.descriptions.append(attrs.get('content'))
        if 'id' in attrs:
            self.ids.append(attrs['id'])


def _page(canonical):
    # The marker represents an already-rendered opaque evidence record. The
    # presentation pass must not normalize JSON or signed checkpoint text.
    proof = '<pre id="opaque-proof">{"checkpoint":"A\\n\\n\\u2014 B", "amount":"0001"}</pre>'
    body = '<main><h1>Original data heading</h1>' + proof + '<div id="data-rows">ORIGINAL-ROWS</div></main>'
    return ('<!doctype html><html><head><title>Old title</title>'
            '<link rel="canonical" href="' + canonical + '" />'
            '<meta name="description" content="Old description" />'
            '<meta property="og:title" content="Old social title" />'
            '<link rel="stylesheet" href="/styles.css" /></head><body>'
            '<header class="site">Old navigation</header>' + body + '</body></html>'), proof


class CustomerPresentationTests(unittest.TestCase):
    def test_all_three_generated_pages_get_specific_metadata(self):
        for path, expected in site_chrome.GENERATED_PAGE_META.items():
            with self.subTest(path=path):
                page, proof = _page('https://402signal.com' + path)
                rendered = site_chrome.prepare_generated_html(page)
                parsed = _Metadata()
                parsed.feed(rendered)
                self.assertEqual(parsed.titles, 1)
                self.assertEqual(parsed.descriptions, [expected[1]])
                self.assertEqual(parsed.ids.count('customer-page-context'), 1)
                self.assertIn(proof, rendered)
                self.assertIn('<div id="data-rows">ORIGINAL-ROWS</div>', rendered)
                self.assertIn('<h1>Original data heading</h1>', rendered)
                for href, label in site_chrome.NAV:
                    self.assertIn('href="' + href + '"', rendered)
                    self.assertIn(label, rendered)

    def test_second_presentation_pass_does_not_duplicate_or_change_content(self):
        for path in site_chrome.GENERATED_PAGE_META:
            with self.subTest(path=path):
                original, _ = _page('https://402signal.com' + path)
                first = site_chrome.prepare_generated_html(original)
                self.assertEqual(first, site_chrome.prepare_generated_html(first))

    def test_asset_stamping_and_presentation_remain_idempotent(self):
        page, proof = _page('https://402signal.com/transparency')
        stamped = asset_version.stamp_html(page, version='review123')
        self.assertIn('/styles.css?v=review123', stamped)
        self.assertIn(proof, stamped)
        self.assertEqual(stamped, asset_version.stamp_html(stamped, version='review123'))

    def test_unrelated_or_untrusted_canonical_does_not_select_a_template(self):
        for canonical in ('https://402signal.com/developers',
                          'https://evil.example/transparency',
                          'https://402signal.com.evil.example/transparency',
                          'https://user@402signal.com/transparency',
                          'http://402signal.com/transparency',
                          'https://402signal.com/transparency?x=1',
                          'https://402signal.com/transparency#fake'):
            with self.subTest(canonical=canonical):
                page, _ = _page(canonical)
                self.assertEqual(page, site_chrome.prepare_generated_html(page))

    def test_no_head_or_json_is_left_untouched(self):
        for original in ('{"checkpoint":"immutable"}', '<main>unchanged</main>'):
            self.assertEqual(original, site_chrome.prepare_generated_html(original))

    def test_html_aliases_use_the_same_page_scope(self):
        original, proof = _page('https://402signal.com/dashboard.html')
        rendered = site_chrome.prepare_generated_html(original)
        self.assertIn('Catalog overview', rendered)
        self.assertIn(proof, rendered)
