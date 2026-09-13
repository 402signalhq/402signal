"""Public per-host endpoint pages: aggregate-only, cached, neutral, bounded."""
import os
import tempfile
import threading
import time
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer

os.environ.setdefault("LIVE402_FIXTURE", "1")
os.environ.pop("LOCAL_FREE", None)

from live402 import endpoints, history, shadow
from live402.server import Handler

HOST = "seller-pages.example"
URL_A = "https://%s/api/weather?units=metric" % HOST
URL_B = "https://%s/api/search" % HOST
OTHER = "https://other-host.example/api/one"
PAYTO = "0xabcabcabcabcabcabcabcabcabcabcabcabcabca"


def _get(port, path, accept="text/html"):
    conn = HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request("GET", path, headers={"Accept": accept})
    res = conn.getresponse()
    raw = res.read()
    headers = {k.lower(): v for k, v in res.getheaders()}
    conn.close()
    return res.status, raw.decode("utf-8"), headers


def _item(url, name, capability_hint, schema=True):
    return {
        "resource": url,
        "serviceName": name,
        "description": capability_hint,
        "_input_schema_present": schema,
        "accepts": [{"scheme": "exact", "network": "eip155:8453", "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                     "maxAmountRequired": "10000", "payTo": PAYTO}],
    }


class EndpointPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        os.environ["LIVE402_CATALOG_DB"] = os.path.join(cls.tmp.name, "catalog.sqlite")
        os.environ["LIVE402_HISTORY_DB"] = os.path.join(cls.tmp.name, "history.sqlite")
        os.environ["LIVE402_PQ_LOG_DB"] = os.path.join(cls.tmp.name, "pq-log.sqlite")
        shadow.reset()
        history.reset()
        endpoints.reset_cache()
        shadow.upsert_items([
            _item(URL_A, "Weather lookup", "Local weather forecast for a city"),
            _item(URL_B, "Web search", "Web search results for a query", schema=False),
            _item(OTHER, "Other seller", "Token price lookup"),
        ], source="cdp")
        now = int(time.time())
        for latency, live in ((120, True), (180, True), (240, True), (None, False)):
            snap = {"live": live, "status": 402 if live else 200, "latency_ms": latency, "payTo": PAYTO if live else None,
                    "batch_id": "pagebatch", "_route_traffic_class": history.TRAFFIC_ORGANIC}
            if not live:
                snap["miss_reason"] = "no_402_envelope"
            history.record_probe(URL_A, snap)
        # Lab traffic must never reach the public page.
        history.record_probe(URL_B, {"live": True, "status": 402, "latency_ms": 5, "payTo": PAYTO, "batch_id": "labbatch",
                                     "_route_traffic_class": history.TRAFFIC_SPONSORED})
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shadow.reset()
        history.reset()
        endpoints.reset_cache()
        for key in ("LIVE402_CATALOG_DB", "LIVE402_HISTORY_DB", "LIVE402_PQ_LOG_DB"):
            os.environ.pop(key, None)
        cls.tmp.cleanup()

    def test_host_normalization_rejects_junk(self):
        self.assertEqual(endpoints.normalize_host("Seller-Pages.Example."), "seller-pages.example")
        for bad in ("", "no-dots", "-bad.example", "a..b", "a/b.example", "a b.example", "x" * 260 + ".example", "seller.example/../"):
            self.assertIsNone(endpoints.normalize_host(bad), bad)

    def test_facts_count_only_public_trusted_probes(self):
        facts = endpoints.host_facts(HOST)
        self.assertEqual(facts["listings"], 2)
        self.assertEqual(facts["with_schema"], 1)
        self.assertEqual(facts["probes"], 4)
        self.assertEqual(facts["live"], 3)
        self.assertAlmostEqual(facts["live_rate"], 0.75)
        self.assertEqual(facts["p50_ms"], 180)
        self.assertEqual(facts["top_miss"], "no_402_envelope")
        self.assertEqual(facts["networks"][0][0], "Base")
        self.assertIsNone(endpoints.host_facts("unknown-host.example"))

    def test_host_page_renders_aggregates_without_private_data(self):
        status, html, headers = _get(self.port, "/endpoints/" + HOST)
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers["content-type"])
        self.assertEqual(headers.get("cache-control"), "public, max-age=300")
        self.assertIn("default-src 'none'", headers.get("content-security-policy", ""))
        for phrase in (HOST, "listings in the catalog", "public probes in 30 days", "75.0%", "180 ms", "no_402_envelope",
                       "Nothing a seller pays for changes these numbers", "/endpoints/%s/badge.svg" % HOST, "Skip to content", "ross@402signal.com"):
            self.assertIn(phrase, html)
        self.assertNotIn(PAYTO, html)
        self.assertNotIn("other-host.example", html)
        self.assertEqual(html.count("<h1>"), 1)

    def test_index_badge_sitemap_and_404s(self):
        status, html, _ = _get(self.port, "/endpoints")
        self.assertEqual(status, 200)
        self.assertIn('href="/endpoints/%s"' % HOST, html)
        self.assertIn('href="/endpoints/other-host.example"', html)
        status, svg, headers = _get(self.port, "/endpoints/%s/badge.svg" % HOST)
        self.assertEqual(status, 200)
        self.assertIn("image/svg+xml", headers["content-type"])
        self.assertIn("live 75.0%", svg)
        self.assertNotIn("<script", svg)
        status, svg, _ = _get(self.port, "/endpoints/other-host.example/badge.svg")
        self.assertEqual(status, 200)
        self.assertIn("no public data yet", svg)
        status, xml, headers = _get(self.port, "/endpoints/sitemap.xml")
        self.assertEqual(status, 200)
        self.assertIn("application/xml", headers["content-type"])
        self.assertIn("https://402signal.com/endpoints/%s" % HOST, xml)
        for path in ("/endpoints/nope.example", "/endpoints/%s/other.svg" % HOST, "/endpoints/%s/a/b" % HOST, "/endpoints/..%2F..", "/endpoints/bad%20host"):
            status, body, _ = _get(self.port, path)
            self.assertEqual(status, 404, path)
            self.assertIn("That page is not here.", body)
        status, body, headers = _get(self.port, "/endpoints/nope.example", accept="application/json")
        self.assertEqual(status, 404)
        self.assertIn("json", headers["content-type"])

    def test_verify_page_and_module_are_served_under_the_csp(self):
        status, html, headers = _get(self.port, "/verify")
        self.assertEqual(status, 200)
        self.assertIn("default-src 'none'", headers.get("content-security-policy", ""))
        self.assertIn('type="module" src="/verify.js?v=', html)
        self.assertIn('id="verify-form"', html)
        self.assertIn("Nothing is uploaded", html)
        status, js, headers = _get(self.port, "/verify.js")
        self.assertEqual(status, 200)
        self.assertIn("javascript", headers.get("content-type", ""))
        for phrase in ("crypto.subtle", "verifyRouteReceipt", "Ed25519"):
            self.assertIn(phrase, js)
        self.assertNotIn("fetch(", js)

    def test_robots_and_head(self):
        from live402 import discover
        self.assertIn("Allow: /endpoints", discover.ROBOTS_TXT)
        self.assertIn("Sitemap: https://402signal.com/endpoints/sitemap.xml", discover.ROBOTS_TXT)
        conn = HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("HEAD", "/endpoints/" + HOST)
        res = conn.getresponse()
        body = res.read()
        conn.close()
        self.assertEqual(res.status, 200)
        self.assertEqual(body, b"")


if __name__ == "__main__":
    unittest.main()
