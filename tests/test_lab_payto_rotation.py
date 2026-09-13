"""A lab seller's recipient rotation is refused like a public one, with nothing public written."""

from __future__ import annotations

import os
import tempfile
import unittest
from unittest.mock import patch

os.environ.setdefault("LIVE402_FIXTURE", "1")

from live402 import history, payment, probe, route, session

LAB_ORIGIN = "https://fixture.402signal.local"
WEATHER = LAB_ORIGIN + "/weather"
PAY_A = "0xabcabcabcabcabcabcabcabcabcabcabcabcabca"
PAY_B = "0xbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc"


def _snap(pay_to: str, ts: int) -> dict:
    return {
        "live": True, "status": 402, "latency_ms": 10, "has_402_challenge": True, "payTo": pay_to,
        "amount": "10000", "asset": payment.USDC_BASE, "rail": "base", "ts": ts,
        "envelope": {"x402Version": 2, "accepts": [{
            "scheme": "exact", "network": payment.BASE_CAIP2, "asset": payment.USDC_BASE,
            "amount": "10000", "payTo": pay_to, "maxTimeoutSeconds": 60,
        }]},
    }


class LabPayToRotationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = patch.dict(os.environ, {
            "LIVE402_HISTORY_DB": os.path.join(self.tmp.name, "history.sqlite"),
            "LIVE402_SESSION_DB": os.path.join(self.tmp.name, "session.sqlite"),
            "LIVE402_LAB_ORIGINS": LAB_ORIGIN,
            "LOCAL_FREE": "1",
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        history.reset()
        session.reset()
        self.addCleanup(history.reset)
        self.addCleanup(session.reset)

    def _url_state(self):
        return history._connect().execute(
            "SELECT last_payTo, pending_payTo FROM url_state WHERE url = ?", (WEATHER,)
        ).fetchone()

    def test_history_flags_the_rotation_from_the_labs_own_rows_only(self):
        self.assertFalse(history.record_probe(WEATHER, _snap(PAY_A, 1000)).get("payTo_pending"))
        self.assertFalse(history.record_probe(WEATHER, _snap(PAY_A, 1001)).get("payTo_pending"))
        rotated = history.record_probe(WEATHER, _snap(PAY_B, 1002))
        self.assertTrue(rotated.get("payTo_pending"))
        self.assertTrue(rotated["payTo_flipped"])
        # The next observation of the new recipient is the new reference.
        self.assertFalse(history.record_probe(WEATHER, _snap(PAY_B, 1003)).get("payTo_pending"))
        # Nothing public moved: no trusted recipient state for the lab URL.
        self.assertIsNone(self._url_state())
        rows = history._connect().execute(
            "SELECT traffic_class FROM probes WHERE url = ?", (WEATHER,)).fetchall()
        self.assertEqual({row[0] for row in rows}, {history.TRAFFIC_SELF_TEST})

    def test_public_urls_are_untouched_by_the_lab_rule(self):
        public = "https://public-seller.example/api"
        with patch.dict(os.environ, {"LIVE402_LAB_ORIGINS": ""}):
            history.record_probe(public, dict(_snap(PAY_A, 1000), trust_class=history.TRUST_ROUTE_TENTATIVE))
            meta = history.record_probe(public, dict(_snap(PAY_B, 1001), trust_class=history.TRUST_ROUTE_TENTATIVE))
        # Tentative public rows never establish a recipient, exactly as before.
        self.assertFalse(meta.get("payTo_pending"))

    def test_route_refuses_the_rotated_lab_seller_as_a_typed_miss(self):
        original = probe.probe_url
        new_pay = {"value": None}

        def rotated_probe(url, *args, **kwargs):
            result = original(url, *args, **kwargs)
            if new_pay["value"] and isinstance(result, dict) and result.get("live"):
                result["payTo"] = new_pay["value"]
                selected = result.get("selected_payment")
                if isinstance(selected, dict):
                    selected["payTo"] = new_pay["value"]
                env = result.get("envelope")
                if isinstance(env, dict):
                    for option in env.get("accepts") or []:
                        if isinstance(option, dict):
                            option["payTo"] = new_pay["value"]
            return result

        with patch.object(probe, "probe_url", side_effect=rotated_probe):
            code, first, _ = route.handle_route({"url": WEATHER}, {}, "https://402signal.com/route")
            self.assertEqual(code, 200, first)
            self.assertTrue(first.get("live"))
            self.assertFalse(first.get("payTo_pending"))
            new_pay["value"] = PAY_B
            code, second, _ = route.handle_route({"url": WEATHER}, {}, "https://402signal.com/route")
        self.assertIn(code, (200, 503))
        self.assertIs(second.get("live"), False)
        self.assertIsNone(second.get("selected_payment"))
        self.assertTrue(second.get("payTo_pending"))
        self.assertTrue(second.get("payTo_changed"))
        self.assertEqual(second.get("risk"), ["payTo_changed"])
        self.assertEqual(second.get("miss_reason"), "no_payto")
        self.assertIsNone(self._url_state())


if __name__ == "__main__":
    unittest.main()
