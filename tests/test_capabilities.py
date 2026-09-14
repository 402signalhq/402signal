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
# Tag route-guard-v0.7.4 at the merge commit of PR #232; sdk/route-guard bytes are unchanged
# after 922e8aa. The downloaded GitHub bytes matched this pair (reproduced three times, npm 11.19.0).
PUBLISHED_TIP = "5bc1e651c7501706e90788e498d98d0918e9eeb8"
PUBLISHED_PACK_SHA256 = (
    "164a1328ddcba856b667b74b43573bfb455016144cef84858ae66054be64b5ff"
)
PUBLISHED_SUMS_SHA256 = (
    "d414db64f83d5f68013451c912c7c6a6c03aa32d95d4007ac5b942b353abeaa9"
)
PUBLISHED_AT = "2026-09-13T23:35:35Z"
PUBLISHED_ARCHIVE = (
    "https://github.com/402signalhq/402signal/releases/download/"
    "route-guard-v0.7.4/402signal-route-guard-0.7.4.tgz"
)
PUBLISHED_CHECKSUM_FILE = (
    "https://github.com/402signalhq/402signal/releases/download/"
    "route-guard-v0.7.4/SHA256SUMS"
)
PUBLISHED_DISTRIBUTION = "GitHub release archive and npm registry (@402signal/route-guard@0.7.4, provenance)"
# The previous release (0.7.3, tag at its merge commit, PR #205) stays published and unchanged.
PREVIOUS_TIP = "58241029bf3a7949c388bf3398279fdf446c2893"
PREVIOUS_PACK_SHA256 = (
    "bb5b49e63b37297b4460c37c6337ff80070988f8103c55ac309549d7d1790f76"
)
PREVIOUS_SUMS_SHA256 = (
    "e8502e1f3e7c510fa41f579b65dd64168ac85d105e28b2482e8e4c184442d66d"
)
PREVIOUS_DISTRIBUTION = "GitHub release archive and npm registry (@402signal/route-guard@0.7.3, provenance)"
# 0.7.2 was the last archive-only release.
OLDER_PACK_SHA256 = (
    "f23d534537a847d592770aea2bbdbbce493f668645d6dcf95985b21d2a70195a"
)
# 0.7.5 release candidate (security review 2026-09-14): provisional pair reproduced twice with
# npm 11.19.0 on the release branch; not an install URL until the release flips the row.
PENDING_TAG = "route-guard-v0.7.5"
PENDING_PACK_SHA256 = (
    "4c325c41db1ca4f744539b3daf00d9651ce2d1a0e236009cdd9a6b9d29724c69"
)
PENDING_SUMS_SHA256 = (
    "56fdac051d9531f3d8dca5d4c0b9814b3a7492bc8fe6a1e8e0d918e93cbda4fb"
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
        self.assertEqual(block["verifier_package"], "route-guard-v0.7.4")
        self.assertEqual(block["historical_verifier"], "route-guard-v0.7.1")
        self.assertEqual(block["job"], "chk_grp")
        self.assertEqual(block["buyer_fields"], ["url", "buyer_limits", "require_route_binding"])

    def assert_package_record(self, record):
        self.assertEqual(len(record["packages"]), self.package_count)
        self.assertEqual(self.package_count, 9)
        tags = [package["tag"] for package in record["packages"]]
        self.assertEqual(tags[:5], [PENDING_TAG, "route-guard-v0.7.4", "route-guard-v0.7.3", "route-guard-v0.7.2", "route-guard-v0.7.1"])
        self.assertEqual([package["tag"] for package in record["packages"] if package.get("state") != "published"], [PENDING_TAG])
        pending = next(package for package in record["packages"] if package["tag"] == PENDING_TAG)
        self.assertEqual(pending["state"], "pending")
        self.assertEqual(pending["digest_status"], "provisional-until-release")
        self.assertEqual(pending["provisional_pack_sha256"], PENDING_PACK_SHA256)
        self.assertEqual(pending["provisional_sums_sha256"], PENDING_SUMS_SHA256)
        self.assertRegex(pending["source_revision"], r"^[0-9a-f]{40}$")
        for key in ("archive", "sha256", "checksum_file", "checksum_file_sha256", "npm", "published_at"):
            self.assertNotIn(key, pending, key)
        self.assertIn("not an install URL", pending["distribution"])
        published = next(package for package in record["packages"] if package["tag"] == "route-guard-v0.7.4")
        self.assertEqual(published["state"], "published")
        self.assertNotIn("digest_status", published)
        self.assertNotIn("provisional_pack_sha256", published)
        self.assertNotIn("provisional_sums_sha256", published)
        self.assertEqual(published["published_at"], PUBLISHED_AT)
        self.assertEqual(published["source_revision"], PUBLISHED_TIP)
        self.assertEqual(published["archive"], PUBLISHED_ARCHIVE)
        self.assertEqual(published["sha256"], PUBLISHED_PACK_SHA256)
        self.assertEqual(published["checksum_file"], PUBLISHED_CHECKSUM_FILE)
        self.assertEqual(published["checksum_file_sha256"], PUBLISHED_SUMS_SHA256)
        self.assertEqual(published["npm"], "@402signal/route-guard@0.7.4")
        self.assertEqual(published["distribution"], PUBLISHED_DISTRIBUTION)
        self.assertEqual(published["recipe"], "/developers/check-group-offer")
        previous = next(package for package in record["packages"] if package["tag"] == "route-guard-v0.7.3")
        self.assertEqual(previous["state"], "published")
        self.assertEqual(previous["source_revision"], PREVIOUS_TIP)
        self.assertEqual(previous["sha256"], PREVIOUS_PACK_SHA256)
        self.assertEqual(previous["checksum_file_sha256"], PREVIOUS_SUMS_SHA256)
        self.assertEqual(previous["distribution"], PREVIOUS_DISTRIBUTION)
        self.assertEqual(previous["npm"], "@402signal/route-guard@0.7.3")
        older = next(package for package in record["packages"] if package["tag"] == "route-guard-v0.7.2")
        self.assertEqual(older["state"], "published")
        self.assertEqual(older["sha256"], OLDER_PACK_SHA256)
        self.assertEqual(older["distribution"], "GitHub release archive; not npm registry")
        self.assertNotIn("npm", older)
        historical = next(package for package in record["packages"] if package["tag"] == "route-guard-v0.7.1")
        self.assertEqual(historical["state"], "published")
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
        self.assertEqual(static["check_group_offer"]["verifier_package"], "route-guard-v0.7.4")
        self.assertEqual(static["check_group_offer"]["historical_verifier"], "route-guard-v0.7.1")
        self.assertNotIn("codecs", static["check_group_offer"])
        self.assertNotIn("exact,sess,mpp,atom,inv", json.dumps(static["check_group_offer"]))
        self.assertEqual(len(static["packages"]), 9)
        self.assertEqual(static["packages"][0]["tag"], "route-guard-v0.7.4")
        self.assertEqual(static["packages"][0]["state"], "published")
        self.assertEqual(static["packages"][1]["tag"], "route-guard-v0.7.3")
        self.assertEqual(static["packages"][1]["sha256"], PREVIOUS_PACK_SHA256)
        self.assertEqual(static["packages"][2]["tag"], "route-guard-v0.7.2")
        self.assertEqual(static["packages"][2]["sha256"], OLDER_PACK_SHA256)
        published = next(package for package in static["packages"] if package["tag"] == "route-guard-v0.7.4")
        self.assertEqual(published["state"], "published")
        self.assertNotIn("digest_status", published)
        self.assertNotIn("provisional_pack_sha256", published)
        self.assertNotIn("provisional_sums_sha256", published)
        self.assertEqual(published["published_at"], PUBLISHED_AT)
        self.assertEqual(published["source_revision"], PUBLISHED_TIP)
        self.assertEqual(published["archive"], PUBLISHED_ARCHIVE)
        self.assertEqual(published["sha256"], PUBLISHED_PACK_SHA256)
        self.assertEqual(published["checksum_file"], PUBLISHED_CHECKSUM_FILE)
        self.assertEqual(published["checksum_file_sha256"], PUBLISHED_SUMS_SHA256)
        self.assertIn("See check_group_offer.codecs", static["merchant_integrations"][1]["hosted_enablement_note"])
        self.assertNotIn("codec tokens exact,sess,mpp,atom,inv", static["merchant_integrations"][1]["hosted_enablement_note"])

    def test_head_capabilities_has_empty_body(self):
        status, _, body = self.request("/capabilities.json", "HEAD")
        self.assertEqual(status, 200)
        self.assertEqual(body, "")


if __name__ == "__main__":
    unittest.main()
