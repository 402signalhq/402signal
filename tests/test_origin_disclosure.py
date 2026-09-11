"""Canonical host and public disclosure pages."""
import os
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer

os.environ.setdefault("LIVE402_FIXTURE", "1")
os.environ.pop("LOCAL_FREE", None)
from live402.server import Handler, HSTS


def _full(port, path, extra=None, method="GET"):
    conn = HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request(method, path, headers=dict(extra or {}))
    res = conn.getresponse()
    raw, headers, status = res.read(), {k.lower(): v for k, v in res.getheaders()}, res.status
    conn.close()
    return status, raw.decode("utf-8"), headers


class OriginDisclosureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ.pop("LOCAL_FREE", None)
        os.environ["LIVE402_FIXTURE"] = "1"
        cls.tmp = tempfile.TemporaryDirectory()
        os.environ["LIVE402_PQ_LOG_DB"] = os.path.join(cls.tmp.name, "pq-log.sqlite")
        from live402.pq import store
        store.reset()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        from live402.pq import store
        store.reset()
        os.environ.pop("LIVE402_PQ_LOG_DB", None)
        cls.tmp.cleanup()

    def test_privacy_and_terms_pages(self):
        for path, phrase in (("/privacy", "What this service stores."), ("/terms", "What a check is.")):
            status, html, _ = _full(self.port, path)
            self.assertEqual(status, 200, path)
            self.assertIn(phrase, html)
            self.assertIn("ross@402signal.com", html)

    def test_www_redirects_to_apex(self):
        status, _, headers = _full(self.port, "/privacy", {"Host": "www.402signal.com"})
        self.assertEqual(status, 301)
        self.assertEqual(headers.get("location"), "https://402signal.com/privacy")

    def test_loopback_host_is_not_redirected(self):
        status, _, headers = _full(self.port, "/privacy")
        self.assertEqual(status, 200)
        self.assertNotIn("location", headers)

    def test_hsts_includes_subdomains(self):
        self.assertEqual(HSTS, "max-age=31536000; includeSubDomains")
        _, _, headers = _full(self.port, "/privacy")
        self.assertEqual(headers.get("strict-transport-security"), HSTS)
        self.assertNotIn("preload", HSTS)
