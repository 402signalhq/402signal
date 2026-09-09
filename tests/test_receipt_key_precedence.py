"""Pinned log key wins over a key carried on the receipt or stale sqlite."""

from __future__ import annotations

import os
import tempfile
import unittest

os.environ.setdefault("LIVE402_FIXTURE", "1")

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from live402 import batch_binding as bb
from live402 import route_binding as rb
from live402.pq import events, receipt, store
from live402.pq import checkpoint as ckpt


class ReceiptKeyPrecedenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._prev = {
            key: os.environ.get(key)
            for key in (
                "LIVE402_PQ_LOG_DB",
                "LIVE402_PQ_LOG_VKEY",
                "LIVE402_PQ_LOG_VKEY_MAINNET",
                "LIVE402_PQ_LOG_EPOCH",
                "LIVE402_PQ_FALCON_NETWORK",
            )
        }
        os.environ["LIVE402_PQ_LOG_DB"] = os.path.join(self.tmp.name, "pq-log.sqlite")
        os.environ.pop("LIVE402_PQ_LOG_VKEY", None)
        os.environ.pop("LIVE402_PQ_LOG_VKEY_MAINNET", None)
        os.environ.pop("LIVE402_PQ_LOG_EPOCH", None)
        os.environ.pop("LIVE402_PQ_FALCON_NETWORK", None)
        store.reset()
        self.key = Ed25519PrivateKey.generate()
        self.pin = receipt.configure_signer(self.key)
        self.addCleanup(self._cleanup)

    def _cleanup(self):
        receipt.configure_signer(None)
        store.reset()
        for key, val in self._prev.items():
            if val is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = val
        self.tmp.cleanup()

    def _other_vkey(self) -> str:
        from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

        pk = Ed25519PrivateKey.generate().public_key().public_bytes(
            Encoding.Raw, PublicFormat.Raw
        )
        return ckpt.vkey_encode("402signal.com/pq/log", pk)

    def _proof(self) -> dict:
        ev = events.route_decision_event(need="key-precedence", ts=1756627200)
        return receipt.issue(ev)

    def test_pin_wins_when_receipt_offers_another_key(self):
        proof = self._proof()
        offered = self._other_vkey()
        proof["vkey"] = offered
        receipt.verify_receipt(proof, self.pin)
        with self.assertRaises(receipt.ReceiptError):
            receipt.verify_receipt(proof, offered)

    def test_empty_pin_fails_closed_instead_of_adopting_offered_or_sqlite(self):
        proof = self._proof()
        proof["vkey"] = self.pin
        store.meta_set("vkey", self.pin)
        for pin in ("", "   "):
            with self.assertRaises(receipt.ReceiptError):
                receipt.verify_receipt(proof, pin)
            self.assertEqual(
                receipt.resolve_verify_vkey(None, proof),
                self.pin,
            )

    def test_env_pin_wins_over_stale_sqlite_and_receipt_offered_key(self):
        proof = self._proof()
        offered = self._other_vkey()
        proof["vkey"] = offered
        store.meta_set("vkey", offered)
        os.environ["LIVE402_PQ_LOG_VKEY"] = self.pin
        self.assertEqual(receipt.resolve_verify_vkey(None, proof), self.pin)
        receipt.verify_receipt(proof)
        with self.assertRaises(receipt.ReceiptError):
            receipt.verify_receipt(proof, offered)

    def test_rotation_requires_explicit_pin_update(self):
        proof = self._proof()
        successor = self._other_vkey()
        proof["vkey"] = successor
        receipt.verify_receipt(proof, self.pin)
        with self.assertRaises(receipt.ReceiptError):
            receipt.verify_receipt(proof, successor)
        self.assertEqual(receipt.resolve_verify_vkey(self.pin, proof), self.pin)
        self.assertNotEqual(receipt.resolve_verify_vkey(self.pin, proof), successor)

    def test_route_binding_keeps_caller_pin(self):
        self.assertRaises(
            rb.BindingError,
            rb.verify_route,
            {"pq_trust": {"transparency": {}}},
            {"require_route_binding": True},
            vkey="",
            status=402,
            envelope={"x402Version": 2, "accepts": []},
            url="https://example.com/api",
            method="GET",
        )
        self.assertRaises(
            rb.BindingError,
            rb.verify_route,
            {"pq_trust": {"transparency": {}}},
            {"require_route_binding": True},
            vkey=None,
            status=402,
            envelope={"x402Version": 2, "accepts": []},
            url="https://example.com/api",
            method="GET",
        )

    def test_batch_binding_refuses_empty_pin(self):
        with self.assertRaises(rb.BindingError):
            bb.verify_route(
                {"pq_trust": {"transparency": {}}},
                {"merchant_profile": "base-x402-batch-v1"},
                vkey="",
                challenge={},
            )


if __name__ == "__main__":
    unittest.main()
