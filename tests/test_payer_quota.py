"""Per-payer unsettled attempt budget. All I/O mocked."""

from __future__ import annotations

import os
import time
import unittest
from unittest.mock import patch

os.environ.setdefault("LIVE402_FIXTURE", "1")

from live402 import facilitator, payer_quota, payment, route

RESOURCE = "https://402signal.com/route"
PAYER = "0x" + "ab" * 20


class PayerQuotaUnitTests(unittest.TestCase):
    def setUp(self):
        payer_quota.reset()

    def tearDown(self):
        payer_quota.reset()

    def test_unsettled_attempts_are_capped_per_payer(self):
        with patch.dict(os.environ, {"LIVE402_PAYER_UNSETTLED_PER_WINDOW": "3"}):
            for _ in range(3):
                payer_quota.reserve("base", PAYER, now=100.0).finish(False)
            with self.assertRaises(payer_quota.Exhausted):
                payer_quota.reserve("base", PAYER.upper().replace("0X", "0x"), now=101.0)
            self.assertIsNotNone(payer_quota.reserve("base", "0x" + "cd" * 20, now=101.0))
            self.assertIsNotNone(payer_quota.reserve("solana", PAYER, now=101.0))

    def test_settled_attempts_are_refunded(self):
        with patch.dict(os.environ, {"LIVE402_PAYER_UNSETTLED_PER_WINDOW": "2"}):
            for step in range(10):
                payer_quota.reserve("base", PAYER, now=float(step)).finish(True)

    def test_budget_recovers_after_the_window(self):
        with patch.dict(os.environ, {"LIVE402_PAYER_UNSETTLED_PER_WINDOW": "1", "LIVE402_PAYER_WINDOW_S": "600"}):
            payer_quota.reserve("base", PAYER, now=0.0).finish(False)
            with self.assertRaises(payer_quota.Exhausted):
                payer_quota.reserve("base", PAYER, now=10.0)
            self.assertIsNotNone(payer_quota.reserve("base", PAYER, now=601.0))

    def test_disabled_or_unknown_payer_is_untracked(self):
        with patch.dict(os.environ, {"LIVE402_PAYER_UNSETTLED_PER_WINDOW": "0"}):
            self.assertIsNone(payer_quota.reserve("base", PAYER))
        self.assertIsNone(payer_quota.reserve("base", None))
        self.assertIsNone(payer_quota.reserve("base", "  "))


class VerifyPayerTests(unittest.TestCase):
    def _verify(self, body):
        result = facilitator.FacilitatorResult(ok=True, body=body)
        with patch.object(facilitator, "_call", return_value=result):
            return facilitator.verify({}, {"network": payment.BASE_CAIP2})

    def test_only_a_rail_valid_payer_is_kept(self):
        self.assertEqual(
            self._verify({"isValid": True, "payer": "0x" + "1" * 40, "note": "x"}).body,
            {"isValid": True, "payer": "0x" + "1" * 40},
        )
        self.assertEqual(self._verify({"isValid": True, "payer": "not-an-address"}).body, {"isValid": True})
        self.assertEqual(self._verify({"isValid": True}).body, {"isValid": True})


class RouteIntegrationTests(unittest.TestCase):
    def setUp(self):
        payer_quota.reset()
        self.accept = next(
            row for row in payment.payment_required(RESOURCE)["accepts"] if payment.rail_of_accept(row) == "base"
        )

    def tearDown(self):
        payer_quota.reset()

    def _attempt(self, fp):
        miss = {"live": False, "payable": False, "invocable": False, "selected_payment": None,
                "miss_reason": "no_candidates", "batch_id": "b"}
        verified = facilitator.FacilitatorResult(ok=True, body={"isValid": True, "payer": "0x" + "1" * 40})
        with patch("live402.facilitator.verify", return_value=verified), \
                patch("live402.route.run_probe", return_value=(503, dict(miss))), \
                patch("live402.replay.authorize", return_value=True) as authorize:
            out = route._paid_execute({"need": "weather"}, {}, self.accept, RESOURCE, None,
                                      time.monotonic() + 30, fp)
        payer_quota.finish_current(False)
        return out, authorize

    def test_payer_over_budget_is_refused_before_durable_admission(self):
        with patch.dict(os.environ, {"LIVE402_PAYER_UNSETTLED_PER_WINDOW": "2"}):
            for index in range(2):
                out, authorize = self._attempt("%064x" % index)
                self.assertNotEqual(out[0], 429, out)
                authorize.assert_called_once()
            out, authorize = self._attempt("%064x" % 9)
        self.assertEqual(out[0], 429)
        self.assertEqual(out[1]["error"], "payer attempt budget exhausted")
        self.assertIs(out[1]["retry_same_request"], True)
        authorize.assert_not_called()

    def test_challenge_advertises_replay_key(self):
        self.assertIn("Replay-Key", payment.payment_required(RESOURCE)["help"]["replayKey"])


if __name__ == "__main__":
    unittest.main()
