"""Hosted Check group offer advertising follows the runtime allowlist."""

import json
import os
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from unittest.mock import patch

os.environ.setdefault("LIVE402_FIXTURE", "1")
from live402 import capabilities
from live402.server import Handler


class CapabilitiesHonestyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, path, method="GET"):
        conn = HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        conn.request(method, path)
        response = conn.getresponse()
        result = response.status, dict(response.getheaders()), response.read().decode()
        conn.close()
        return result

    def test_empty_allowlist_keeps_sdk_metadata_and_marks_hosted_off(self):
        with patch.dict(os.environ, {"BATCH_OBSERVATION_PROFILES": ""}, clear=False):
            os.environ.pop("BATCH_OBSERVATION_PROFILES", None)
            block = capabilities.check_group_offer()
            self.assertEqual(block["job"], "chk_grp")
            self.assertEqual(block["label"], "Check group offer")
            self.assertEqual(block["buyer_fields"], ["url", "buyer_limits", "require_route_binding"])
            self.assertFalse(block["hosted"])
            self.assertEqual(block["hosted_status"], "off")
            self.assertEqual(block["codecs"], [])
            self.assertIn("not enabled", block["note"])
            self.assertEqual(block["verifier_package"], "route-guard-v0.7.2")
            self.assertEqual(block["historical_verifier"], "route-guard-v0.7.1")
            record = capabilities.record()
            self.assertEqual(record["check_group_offer"], block)
            self.assertEqual(len(record["packages"]), 5)
            self.assertTrue(all(pkg.get("state") == "published" for pkg in record["packages"]))
            self.assertEqual(record["pending_packages"][0]["tag"], "route-guard-v0.7.2")
            self.assertEqual(record["pending_packages"][0]["state"], "pending")
            self.assertNotIn("sha256", record["pending_packages"][0])
            self.assertNotIn("published_at", record["pending_packages"][0])
            self.assertIn("not a runtime allowlist", record["scope_note"])
            status, _, text = self.request("/capabilities.json")
            self.assertEqual(status, 200)
            served = json.loads(text)
            offer = served["check_group_offer"]
            self.assertEqual(offer["codecs"], [])
            self.assertEqual(offer["hosted_status"], "off")
            self.assertFalse(offer["hosted"])
            self.assertIn("not enabled", offer["note"])
            self.assertEqual(offer["verifier_package"], "route-guard-v0.7.2")
            self.assertEqual(offer["historical_verifier"], "route-guard-v0.7.1")
            self.assertEqual(len(served["packages"]), 5)
            html_status, _, html = self.request("/developers")
            self.assertEqual(html_status, 200)
            self.assertIn("Check group offer · hosted off", html)
            self.assertIn("Hosted Check group offer is not enabled.", html)
            self.assertNotIn("Currently enabled hosted codecs:", html)
            self.assertNotIn("<!--CHECK_GROUP_CHIP-->", html)
            self.assertNotIn("<!--CHECK_GROUP_HOSTED-->", html)
            guide = self.request("/developers/check-group-offer")[2]
            self.assertIn("Hosted Check group offer is not enabled.", guide)
            self.assertNotIn("<code>exact</code>, <code>sess</code>, <code>mpp</code>", guide)
            md = self.request("/developers/check-group-offer.md")[2]
            self.assertIn("Hosted Check group offer is not enabled.", md)

    def test_nonempty_allowlist_lists_only_enabled_codecs_and_keeps_sdk_fields(self):
        with patch.dict(os.environ, {"BATCH_OBSERVATION_PROFILES": "exact,algorand-atomic-batch-v1,unknown"}):
            self.assertEqual(capabilities.enabled_codecs(), ["exact", "atom"])
            block = capabilities.check_group_offer()
            self.assertTrue(block["hosted"])
            self.assertEqual(block["hosted_status"], "on")
            self.assertEqual(block["codecs"], ["exact", "atom"])
            self.assertNotIn("sess", block["codecs"])
            self.assertNotIn("mpp", block["codecs"])
            self.assertNotIn("inv", block["codecs"])
            self.assertIn("currently enabled", block["note"])
            self.assertEqual(block["verifier_package"], "route-guard-v0.7.2")
            self.assertEqual(block["historical_verifier"], "route-guard-v0.7.1")
            record = capabilities.record()
            self.assertEqual(record["packages"][0]["tag"], "route-guard-v0.7.1")
            self.assertEqual(record["check_group_offer"]["codecs"], ["exact", "atom"])
            served = json.loads(self.request("/capabilities.json")[2])
            self.assertEqual(served["check_group_offer"]["codecs"], ["exact", "atom"])
            self.assertTrue(served["check_group_offer"]["hosted"])
            self.assertEqual(served["check_group_offer"]["verifier_package"], "route-guard-v0.7.2")
            html = self.request("/developers")[2]
            self.assertIn('data-guide-link="check-group-offer">Check group offer</a>', html)
            self.assertNotIn("hosted off", html)
            self.assertIn("Currently enabled hosted codecs: <code>exact</code>, <code>atom</code>.", html)
            self.assertNotIn("<code>sess</code>", html.split("Currently enabled hosted codecs:")[1].split("</p>")[0])
            guide = self.request("/developers/check-group-offer")[2]
            self.assertIn("<code>exact</code>", guide)
            self.assertIn("<code>atom</code>", guide)
            self.assertNotIn("Hosted Check group offer is not enabled.", guide)

    def test_static_record_does_not_advertise_five_live_codecs_or_publish_072(self):
        static = json.loads(capabilities.STATIC.read_text(encoding="utf-8"))
        self.assertNotIn("codecs", static["check_group_offer"])
        self.assertNotIn("exact,sess,mpp,atom,inv", json.dumps(static["check_group_offer"]))
        self.assertEqual(static["check_group_offer"]["verifier_package"], "route-guard-v0.7.2")
        self.assertEqual(static["check_group_offer"]["historical_verifier"], "route-guard-v0.7.1")
        self.assertEqual(len(static["packages"]), 5)
        tags = [pkg["tag"] for pkg in static["packages"]]
        self.assertNotIn("route-guard-v0.7.2", tags)
        self.assertEqual(static["pending_packages"][0]["state"], "pending")
        self.assertNotIn("sha256", static["pending_packages"][0])
        self.assertNotIn("published_at", static["pending_packages"][0])
        self.assertNotIn("archive", static["pending_packages"][0])
        self.assertIn("See check_group_offer.codecs", static["merchant_integrations"][1]["hosted_enablement_note"])
        self.assertNotIn("codec tokens exact,sess,mpp,atom,inv", static["merchant_integrations"][1]["hosted_enablement_note"])

    def test_head_capabilities_has_empty_body(self):
        status, _, body = self.request("/capabilities.json", "HEAD")
        self.assertEqual(status, 200)
        self.assertEqual(body, "")


if __name__ == "__main__":
    unittest.main()
