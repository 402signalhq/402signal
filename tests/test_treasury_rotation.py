"""Routing-fee treasuries rotated 2026-09-13: retired addresses must never be served again."""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from live402 import discover, payment

ROOT = Path(__file__).resolve().parents[1]
RETIRED = {
    "base": "0xb18fc2275f36dae99eb215caeff03b431f887d16",
    "solana": "HCM423cyKYVUoq9GvmqUphZwYVB6M2wez34i9jzSewLy",
}
CURRENT = {
    "base": "0xa2604ae688228af8349363770351bfcec66d4fa0",
    "solana": "C8qDYG8NTyvdY85gvGfs1WajwGhiLu6f1vi3JaG1r1iA",
}
SERVED_SUFFIXES = {".py", ".json", ".html", ".md", ".txt", ".js", ".mjs", ".css", ".xml", ".svg"}


class TreasuryRotationTests(unittest.TestCase):
    def test_defaults_are_the_current_treasuries(self):
        self.assertTrue(payment.payto_equal(payment.DEFAULT_PAYTO, CURRENT["base"], "base"))
        self.assertTrue(payment.payto_equal(payment.DEFAULT_PAYTO_SOLANA, CURRENT["solana"], "solana"))
        for rail, address in CURRENT.items():
            self.assertTrue(payment.valid_payto_for_rail(address, rail), rail)

    def test_retired_treasuries_are_absent_from_the_served_package(self):
        for path in (ROOT / "live402").rglob("*"):
            if not path.is_file() or path.suffix not in SERVED_SUFFIXES:
                continue
            text = path.read_text(encoding="utf-8", errors="ignore").lower()
            for rail, address in RETIRED.items():
                self.assertNotIn(address.lower(), text, "%s retired treasury in %s" % (rail, path.relative_to(ROOT)))

    def test_discovery_advertises_only_current_treasuries(self):
        spec = json.dumps(discover.openapi_spec())
        for address in RETIRED.values():
            self.assertNotIn(address.lower(), spec.lower())
        self.assertIn(CURRENT["solana"], spec)
        self.assertIn(CURRENT["base"], spec.lower())


if __name__ == "__main__":
    unittest.main()
