import json, os, threading, unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from unittest.mock import patch
os.environ.setdefault('LIVE402_FIXTURE', '1')
from live402 import developer_guides as guides
from live402.server import Handler, CSP

class DeveloperRecipes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True); cls.thread.start()
    @classmethod
    def tearDownClass(cls): cls.server.shutdown(); cls.server.server_close(); cls.thread.join()
    def request(self, path, method='GET'):
        c = HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        c.request(method, path); response = c.getresponse(); result = response.status, dict(response.getheaders()), response.read().decode(); c.close(); return result
    def test_all_recipes_have_canonical_html_markdown_and_head(self):
        for path, slug in guides.PATHS.items():
            status, headers, html = self.request(path)
            self.assertEqual(status, 200); self.assertEqual(headers['Content-Security-Policy'], CSP)
            self.assertIn('rel="canonical" href="https://402signal.com' + path + '"', html)
            self.assertIn('<h1>' + guides.GUIDES[slug][1] + '</h1>', html)
            self.assertEqual(html.count('data-guide="'), 1)
            self.assertNotRegex(html, r'<[^>]+\shidden(?:[\s=>])'); self.assertNotIn('—', html)
            status, headers, text = self.request(path + '.md')
            self.assertEqual(status, 200); self.assertIn('text/markdown', headers['Content-Type'])
            self.assertTrue(text.startswith('# ' + guides.GUIDES[slug][1])); self.assertNotIn('<section', text)
            self.assertIn('https://402signal.com' + path, text)
            for target in (path, path + '.md'):
                self.assertEqual(self.request(target, 'HEAD')[2], '')
            self.assertIn('https://402signal.com' + path, (guides.STATIC / 'sitemap.xml').read_text())
    def test_unknown_paths_do_not_read_files_or_enable_probes(self):
        with patch('live402.validate.validate_url', side_effect=AssertionError('unexpected probe')):
            for path in ['/developers/../server.py', '/developers/not-a-guide', '/developers/test-buyer/extra', '/developers/../../data', '/developers/not-a-guide.md', '/guides', '/developers/sellers']:
                self.assertEqual(self.request(path)[0], 404)
            self.assertEqual(self.request('/developers/check-api-listing?endpoint=https://127.0.0.1/private')[0], 200)
    def test_recovery_scopes_and_literal_commands_survive_markdown(self):
        seller = guides.markdown('reconcile-seller-payment')
        self.assertIn('payment confirmed; response not retained', seller)
        self.assertIn('node operator.mjs confirm-seller /private/config.json ORIGINAL_JOB_ID', seller)
        self.assertIn('20 seconds', seller); self.assertIn('not permission to rerun', seller)
        route = guides.markdown('recover-routing-attempt')
        self.assertIn('client.recover(attemptId)', route)
        self.assertIn('billing.settlement_state=not_attempted', route)
        self.assertIn('```', guides.markdown('test-buyer'))
    def test_public_release_record_and_current_discovery(self):
        from live402.discover import LLMS_TXT
        status, _, text = self.request('/capabilities.json'); self.assertEqual(status, 200)
        record = json.loads(text); self.assertEqual(len(record['packages']), 5)
        for package in record['packages']:
            self.assertEqual(package['state'], 'published')
            self.assertRegex(package['sha256'], r'^[0-9a-f]{64}$')
            self.assertRegex(package['source_revision'], r'^[0-9a-f]{40}$')
            self.assertIn(package['tag'], package['archive'])
        pending = record['pending_packages']
        self.assertEqual(pending[0]['tag'], 'route-guard-v0.7.2')
        self.assertEqual(pending[0]['state'], 'pending')
        self.assertNotIn('sha256', pending[0])
        self.assertIn('releases/tag/route-guard-v0.7.1', LLMS_TXT)
        self.assertNotIn('releases/tag/route-guard-v0.7.2', LLMS_TXT)
        self.assertNotIn('route-guard-v0.5.0', LLMS_TXT)
        self.assertEqual(self.request('/capabilities.json', 'HEAD')[2], '')
        for package in record['packages'] + record['pending_packages']:
            self.assertIn(package['recipe'], guides.PATHS)
            self.assertEqual(self.request(package['recipe'])[0], 200)
            self.assertEqual(self.request(package['recipe'] + '.md')[0], 200)
        self.assertNotRegex(text, r'(?<![\w-])(?:/guides|/developers/sellers)(?![\w-])')
        self.assertNotRegex(LLMS_TXT, r'(?<![\w-])(?:/guides|/developers/sellers)(?![\w-])')
    def test_copied_briefs_point_at_retrievable_recipes(self):
        html = (guides.STATIC / 'developers.html').read_text()
        for path in ('/developers/test-buyer', '/developers/check-offer', '/developers/native-mpp', '/developers/sessions-and-invoices', '/developers/check-group-offer', '/developers/check-api-listing', '/developers/recover-routing-attempt', '/developers/evidence'):
            self.assertIn('https://402signal.com' + path, html)
        self.assertNotRegex(html, r'(?<![\w-])(?:/guides|/developers/sellers)(?![\w-])')
        listing = guides.markdown('check-api-listing')
        self.assertIn('https://402signal.com/developers/check-api-listing', listing)
        self.assertNotIn('/developers/sellers', listing)
        self.assertNotIn('/guides', listing)
