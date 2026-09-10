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

REVIEWED_KEYS = (
    "job",
    "label",
    "buyer_fields",
    "hosted_enablement_env",
    "verifier_package",
    "historical_verifier",
)
PACKED_TIP = "120786b19fbc7f965ebdb587832ef15ff9faef2b"
PROVISIONAL_PACK_SHA256 = (
    "f09b4e038b6bde9670afe725af4170b4f52c7323ca775bcb1b2fcbc8ab200497"
)
PROVISIONAL_SUMS_SHA256 = (
    "be043932144d010a8c9d0e0542f8d6b396f72c27d94bc5cac05aa2befa9fefe8"
)


def _static():
    return json.loads(capabilities.STATIC.read_text(encoding="utf-8"))


class CapabilitiesHonestyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.static = _static()
        cls.package_count = len(cls.static["packages"])

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

    def assert_reviewed_metadata(self, block):
        reviewed = self.static["check_group_offer"]
        for key in REVIEWED_KEYS:
            self.assertIn(key, reviewed, key)
            self.assertEqual(block[key], reviewed[key], key)
        self.assertEqual(block["verifier_package"], "route-guard-v0.7.2")
        self.assertEqual(block["historical_verifier"], "route-guard-v0.7.1")
        self.assertEqual(block["job"], "chk_grp")
        self.assertEqual(block["buyer_fields"], ["url", "buyer_limits", "require_route_binding"])

    def assert_package_record(self, record):
        self.assertEqual(len(record["packages"]), self.package_count)
        self.assertEqual(self.package_count, 6)
        tags = [package["tag"] for package in record["packages"]]
        self.assertEqual(tags[0], "route-guard-v0.7.2")
        self.assertIn("route-guard-v0.7.1", tags)
        pending = next(package for package in record["packages"] if package["tag"] == "route-guard-v0.7.2")
        self.assertEqual(pending["state"], "pending")
        self.assertEqual(pending.get("digest_status"), "provisional-until-release")
        self.assertNotEqual(pending["state"], "published")
        self.assertNotIn("sha256", pending)
        self.assertNotIn("archive", pending)
        self.assertNotIn("checksum_file", pending)
        self.assertNotIn("checksum_file_sha256", pending)
        self.assertNotIn("published_at", pending)
        self.assertEqual(pending["source_revision"], PACKED_TIP)
        self.assertEqual(pending["provisional_pack_sha256"], PROVISIONAL_PACK_SHA256)
        self.assertEqual(pending["provisional_sums_sha256"], PROVISIONAL_SUMS_SHA256)
        self.assertIn("not a runtime allowlist", record["scope_note"])

    def test_empty_allowlist_keeps_verifier_metadata_and_marks_hosted_off(self):
        with patch.dict(os.environ, {"BATCH_OBSERVATION_PROFILES": ""}, clear=False):
            os.environ.pop("BATCH_OBSERVATION_PROFILES", None)
            block = capabilities.check_group_offer()
            self.assert_reviewed_metadata(block)
            self.assertFalse(block["hosted"])
            self.assertEqual(block["hosted_status"], "off")
            self.assertEqual(block["codecs"], [])
            self.assertIn("not enabled", block["note"])
            record = capabilities.record()
            self.assertEqual(record["check_group_offer"], block)
            self.assert_package_record(record)
            status, _, text = self.request("/capabilities.json")
            self.assertEqual(status, 200)
            served = json.loads(text)
            self.assert_reviewed_metadata(served["check_group_offer"])
            self.assertEqual(served["check_group_offer"]["codecs"], [])
            self.assertEqual(served["check_group_offer"]["hosted_status"], "off")
            self.assertFalse(served["check_group_offer"]["hosted"])
            self.assert_package_record(served)
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

    def test_nonempty_allowlist_keeps_verifier_metadata_and_lists_enabled_codecs(self):
        with patch.dict(os.environ, {"BATCH_OBSERVATION_PROFILES": "exact,algorand-atomic-batch-v1,unknown"}):
            self.assertEqual(capabilities.enabled_codecs(), ["exact", "atom"])
            block = capabilities.check_group_offer()
            self.assert_reviewed_metadata(block)
            self.assertTrue(block["hosted"])
            self.assertEqual(block["hosted_status"], "on")
            self.assertEqual(block["codecs"], ["exact", "atom"])
            self.assertNotIn("sess", block["codecs"])
            self.assertNotIn("mpp", block["codecs"])
            self.assertNotIn("inv", block["codecs"])
            self.assertIn("currently enabled", block["note"])
            record = capabilities.record()
            self.assert_package_record(record)
            self.assertEqual(record["check_group_offer"]["codecs"], ["exact", "atom"])
            served = json.loads(self.request("/capabilities.json")[2])
            self.assert_reviewed_metadata(served["check_group_offer"])
            self.assertEqual(served["check_group_offer"]["codecs"], ["exact", "atom"])
            self.assertTrue(served["check_group_offer"]["hosted"])
            self.assert_package_record(served)
            html = self.request("/developers")[2]
            self.assertIn('data-guide-link="check-group-offer">Check group offer</a>', html)
            self.assertNotIn("hosted off", html)
            self.assertIn("Currently enabled hosted codecs: <code>exact</code>, <code>atom</code>.", html)
            self.assertNotIn("<code>sess</code>", html.split("Currently enabled hosted codecs:")[1].split("</p>")[0])
            guide = self.request("/developers/check-group-offer")[2]
            self.assertIn("<code>exact</code>", guide)
            self.assertIn("<code>atom</code>", guide)
            self.assertNotIn("Hosted Check group offer is not enabled.", guide)

    def test_static_record_keeps_package_metadata_without_five_live_codecs(self):
        static = self.static
        self.assertEqual(static["check_group_offer"]["verifier_package"], "route-guard-v0.7.2")
        self.assertEqual(static["check_group_offer"]["historical_verifier"], "route-guard-v0.7.1")
        self.assertNotIn("codecs", static["check_group_offer"])
        self.assertNotIn("exact,sess,mpp,atom,inv", json.dumps(static["check_group_offer"]))
        self.assertEqual(len(static["packages"]), 6)
        self.assertEqual(static["packages"][0]["tag"], "route-guard-v0.7.2")
        self.assertEqual(static["packages"][0]["state"], "pending")
        self.assertEqual(static["packages"][0]["digest_status"], "provisional-until-release")
        self.assertNotIn("sha256", static["packages"][0])
        self.assertNotIn("archive", static["packages"][0])
        self.assertEqual(static["packages"][0]["source_revision"], PACKED_TIP)
        self.assertEqual(static["packages"][0]["provisional_pack_sha256"], PROVISIONAL_PACK_SHA256)
        self.assertEqual(static["packages"][0]["provisional_sums_sha256"], PROVISIONAL_SUMS_SHA256)
        self.assertIn("See check_group_offer.codecs", static["merchant_integrations"][1]["hosted_enablement_note"])
        self.assertNotIn("codec tokens exact,sess,mpp,atom,inv", static["merchant_integrations"][1]["hosted_enablement_note"])

    def test_head_capabilities_has_empty_body(self):
        status, _, body = self.request("/capabilities.json", "HEAD")
        self.assertEqual(status, 200)
        self.assertEqual(body, "")


if __name__ == "__main__":
    unittest.main()
