"""Track C drafts stay HOLD: no external write, no stale PQ marketing."""

from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
DRAFT = (ROOT / "docs" / "track-c-discovery-drafts.md").read_text(encoding="utf-8")
GLAMA = (ROOT / "docs" / "glama-release.md").read_text(encoding="utf-8")


class TrackCDiscoveryDraftsTests(unittest.TestCase):
    def test_draft_is_hold_only(self):
        self.assertIn("DRAFT / NO EXTERNAL WRITE", DRAFT)
        self.assertIn("Each channel needs Ross per-channel GO before any write.", DRAFT)
        self.assertIn("**Needs Ross per-channel GO before any write.**", DRAFT)
        self.assertGreaterEqual(DRAFT.count("Needs Ross per-channel GO before any write."), 3)
        self.assertIn("Do not `POST` to MCP Registry, Glama, x402-list `/submit`", DRAFT)

    def test_discovery_not_endorsement_and_canonical_pay_url(self):
        self.assertIn("discovery locations, not endorsements", DRAFT)
        self.assertIn("https://402signal.com", DRAFT)
        self.assertIn("https://402signal.com/mcp", DRAFT)
        self.assertIn("POST https://402signal.com/route", DRAFT)
        self.assertIn("$0.003 USDC", DRAFT)
        self.assertIn("Base, Solana, and Algorand", DRAFT)

    def test_no_stale_confirmation_or_credentials(self):
        self.assertEqual(DRAFT.count("confirmation_ready"), 1)
        self.assertIn("Do not use stale `confirmation_ready`", DRAFT)
        self.assertNotIn("PRIVATE_KEY", DRAFT)
        self.assertNotIn("fly secrets", DRAFT)

    def test_glama_procedure_holds_writes(self):
        self.assertIn("needs Ross per-channel GO before any Glama write", GLAMA)
        self.assertIn("track-c-discovery-drafts.md", GLAMA)


if __name__ == "__main__":
    unittest.main()
