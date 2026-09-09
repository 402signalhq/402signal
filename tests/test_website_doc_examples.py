"""Documentation request extraction never executes copied shell examples."""
import unittest
from integration.website.doc_examples import CodeBlocks


class DocumentationExamplesTests(unittest.TestCase):
    def read(self, value):
        parser = CodeBlocks()
        parser.feed(value)
        return parser.blocks

    def test_literal_and_curl_bodies_are_both_qualified(self):
        text = '<pre><code>{"url":"https://seller.example/a?x=a%2Bb"}</code></pre>'
        text += '<pre><code>curl -sS https://402signal.com/route \\\n --data \'{"need":"web search","require_route_binding":true}\'</code></pre>'
        self.assertEqual(self.read(text), [
            {"url": "https://seller.example/a?x=a%2Bb"},
            {"need": "web search", "require_route_binding": True},
        ])

    def test_shell_metacharacters_remain_inert_json_text(self):
        text = '<code>curl https://402signal.com/route --json=\'{"need":"$(do_not_execute) `not_a_command`"}\'</code>'
        self.assertEqual(self.read(text), [{"need": "$(do_not_execute) `not_a_command`"}])

    def test_html_entities_preserve_the_documented_url(self):
        self.assertEqual(self.read('<code>{"url":"https://example.com/?a=1&amp;b=a%2Bb"}</code>'),
                         [{"url": "https://example.com/?a=1&b=a%2Bb"}])

    def test_file_arguments_and_other_code_are_not_read_or_executed(self):
        self.assertEqual(self.read('<code>curl https://example.com --data @/private/file</code>'), [])
        self.assertEqual(self.read('<code>node example.mjs</code>'), [])

    def test_invalid_or_ambiguous_json_fails(self):
        for value in ('{"need":"a","need":"b"}', '{"max_price_usd":NaN}', '{broken}'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.read('<code>' + value + '</code>')

    def test_inline_terms_are_not_mistaken_for_requests(self):
        self.assertEqual(self.read('<p>Use <code>require_route_binding</code>.</p>'), [])
