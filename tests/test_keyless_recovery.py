"""Keyless recovery, minimal: a repeated final authorization without a Replay-Key gets a typed 409."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import tempfile
import unittest
from unittest.mock import patch

os.environ.setdefault("LIVE402_FIXTURE", "1")
os.environ.pop("LOCAL_FREE", None)

from live402 import facilitator, payment, replay
from live402.route import handle_route

RESOURCE = "https://402signal.com/route"


def _payload(nonce: str) -> dict:
    nonce_hex = hashlib.sha256(nonce.encode("utf-8")).hexdigest()
    return {
        "x402Version": 2,
        "resource": {"url": RESOURCE},
        "accepted": {"scheme": "exact", "network": payment.BASE_CAIP2, "asset": "USDC", "currency": payment.USDC_BASE,
                     "amount": payment.AMOUNT_ATOMIC, "payTo": payment.DEFAULT_PAYTO, "maxTimeoutSeconds": 60},
        "payload": {"signature": "0x" + ("ab" * 65),
                    "authorization": {"from": "0x1111111111111111111111111111111111111111", "to": payment.DEFAULT_PAYTO,
                                      "value": payment.AMOUNT_ATOMIC, "validAfter": "0", "validBefore": "9999999999",
                                      "nonce": "0x" + nonce_hex}},
    }


class _Headers(dict):
    def get(self, key, default=None):
        for name, val in self.items():
            if str(name).lower() == str(key).lower():
                return val
        return default


def _headers(payload: dict, *, key: str | None, replay_only: bool = False) -> _Headers:
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    out = {"PAYMENT-SIGNATURE": base64.b64encode(raw).decode("ascii")}
    if key:
        out["Replay-Key"] = key
    if replay_only:
        out["Replay-Only"] = "1"
    return _Headers(out)


def _fake_post(url, body, headers=None, timeout=20.0):
    _ = body, headers, timeout
    if str(url).rstrip("/").endswith("/verify"):
        return 200, {"isValid": True}
    if str(url).rstrip("/").endswith("/settle"):
        return 200, {"success": True, "transaction": "0x" + ("cd" * 32), "network": payment.BASE_CAIP2,
                     "payer": "0x1111111111111111111111111111111111111111"}
    return 404, {"error": "unexpected"}


class KeylessRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._prev_db = os.environ.get("LIVE402_REPLAY_DB")
        os.environ["LIVE402_REPLAY_DB"] = os.path.join(self.tmp.name, "replay.sqlite")
        replay.reset()
        os.environ["CDP_ACCESS_TOKEN"] = "test-fixture-token"

    def tearDown(self):
        replay.reset()
        os.environ.pop("CDP_ACCESS_TOKEN", None)
        if self._prev_db is None:
            os.environ.pop("LIVE402_REPLAY_DB", None)
        else:
            os.environ["LIVE402_REPLAY_DB"] = self._prev_db
        self.tmp.cleanup()

    def _route(self, payload, **kw):
        body = {"need": "weather", "url": "https://fixture.402signal.local/weather"}
        with patch.object(facilitator, "post_json", _fake_post):
            return handle_route(body, _headers(payload, **kw), RESOURCE)

    def test_settled_authorization_repeated_without_key_is_a_typed_409(self):
        payload = _payload("keyless-settled")
        code, first, _ = self._route(payload, key="a1" * 32)
        self.assertEqual(code, 200)
        self.assertEqual(first["billing"]["settlement_state"], "settled")
        code, again, extra = self._route(payload, key=None)
        self.assertEqual(code, 409)
        self.assertEqual(again["error"], "authorization_already_used")
        self.assertEqual(again["replay"]["state"], "settled")
        self.assertEqual(again["miss_reason"], "authorization_used")
        self.assertEqual((again["billing"]["settlement_state"], again["billing"]["settled"]), ("settled", True))
        self.assertIs(again["new_payment_allowed"], False)
        self.assertIs(again["retry_same_request"], False)
        self.assertIsNone(again["selected_payment"])
        self.assertNotIn("target", again)
        self.assertNotIn("pq_trust", again)
        self.assertEqual(extra["Cache-Control"], "no-store")
        # The private response is still only behind the key.
        code, recovered, _ = self._route(payload, key="a1" * 32, replay_only=True)
        self.assertEqual(code, 200)
        self.assertEqual(recovered["url"], first["url"])

    def test_wrong_key_on_a_final_identity_is_the_same_typed_409(self):
        payload = _payload("keyless-wrong-key")
        self.assertEqual(self._route(payload, key="a1" * 32)[0], 200)
        code, again, _ = self._route(payload, key="b2" * 32)
        self.assertEqual((code, again["error"], again["replay"]["state"]), (409, "authorization_already_used", "settled"))

    def test_fresh_authorization_without_key_still_executes_once(self):
        code, first, _ = self._route(_payload("keyless-fresh"), key=None)
        self.assertEqual(code, 200)
        self.assertEqual(first["billing"]["settlement_state"], "settled")
        code, again, _ = self._route(_payload("keyless-fresh"), key=None)
        self.assertEqual((code, again["replay"]["state"]), (409, "settled"))

    def test_pending_identity_keeps_the_unknown_outcome(self):
        payload = _payload("keyless-pending")
        accept = payment.match_accept(payload, payment.payment_required(RESOURCE, dynamic=False))
        fp = replay.canonical_fingerprint(payload, accept)
        kind, _entry = replay.begin(fp, scope=None, reserve=True)
        self.assertEqual(kind, "run")
        self.assertEqual(replay.ledger_state(fp), replay.STATE_PENDING)
        with patch.object(replay, "begin", return_value=("reject", None)):
            code, again, _ = self._route(payload, key=None)
        self.assertEqual(code, 503)
        self.assertEqual(again["miss_reason"], "settlement_unknown")
        self.assertEqual(again["billing"]["settlement_state"], "unknown")


if __name__ == "__main__":
    unittest.main()
