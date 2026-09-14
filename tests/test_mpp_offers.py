"""MPP challenge observation: tempo/evm charge, session and subscription terms; MPP-only sellers are live."""

from __future__ import annotations

import base64
import json
import os
import unittest

os.environ.setdefault("LIVE402_FIXTURE", "1")

from live402 import evm_chains, mpp_offers, payment, probe, select

RECIPIENT = "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00"
TEMPO_USD = "0x20c0000000000000000000000000000000000000"
BASE_USDC = payment.USDC_BASE
PAYTO = "0xabcabcabcabcabcabcabcabcabcabcabcabcabca"


def b64(obj) -> str:
    return base64.urlsafe_b64encode(json.dumps(obj, separators=(",", ":"), sort_keys=True).encode()).decode().rstrip("=")


def challenge(method, intent, request, cid="kM9xPqWvT2nJrHsY4aDfEb", realm="api.example.com", expires="2030-01-06T12:00:00Z", extra=""):
    parts = ['Payment id="%s"' % cid, 'realm="%s"' % realm, 'method="%s"' % method, 'intent="%s"' % intent,
             'request="%s"' % b64(request)]
    if expires:
        parts.append('expires="%s"' % expires)
    return ", ".join(parts) + extra


TEMPO_CHARGE = {"amount": "1000000", "currency": TEMPO_USD, "recipient": RECIPIENT, "methodDetails": {"chainId": 4217, "supportedModes": ["pull"]}}
BASE_CHARGE = {"amount": "5000", "currency": BASE_USDC, "recipient": PAYTO, "methodDetails": {"chainId": 8453, "credentialTypes": ["authorization"]}}
TEMPO_SESSION = {"amount": "10", "unitType": "llm_token", "suggestedDeposit": "5000000", "currency": TEMPO_USD, "recipient": RECIPIENT,
                 "methodDetails": {"escrowContract": "0x" + "e" * 40, "sessionProtocol": "v2"}}
TEMPO_SUB = {"amount": "9990000", "currency": TEMPO_USD, "recipient": RECIPIENT, "periodCount": 1, "periodUnit": "month",
             "subscriptionExpires": "2030-12-31T00:00:00Z", "methodDetails": {"chainId": 4217}}


class OrdinaryProbeTests(unittest.TestCase):
    def test_ordinary_probe_keeps_mpp_offers_through_winner_assembly(self):
        """Security review F3: the winning attempt's MPP offers were dropped before the snap."""
        from unittest.mock import patch

        offers = mpp_offers.from_headers({"www-authenticate": challenge("evm", "charge", BASE_CHARGE)})
        self.assertTrue(offers and offers[0]["classified"])
        attempt = {"live": True, "status": 402, "has_402_challenge": False, "payTo": PAYTO, "rail": "base",
                   "miss_reason": None, "envelope": None, "mpp_offers": offers,
                   "binding_observation": None, "binding_error_reason": None}
        with patch.object(probe.fixtures, "fixture_mode", return_value=False), \
                patch.object(probe, "_pin_https_target", return_value=("https://seller.example/mpp", [("203.0.113.9", 443)])), \
                patch.object(probe, "_one_request", side_effect=lambda *a, **k: dict(attempt)):
            result = probe._probe_url_unbudgeted("https://seller.example/mpp", None, record=False)
        self.assertTrue(result["live"])
        self.assertEqual([o["method"] for o in result.get("mpp_offers") or []], ["evm"])
        self.assertTrue(result.get("payable"), result)
        options = payment.payment_options_from_result(result)
        self.assertEqual([(o["scheme"], o["rail"]) for o in options], [("mpp-charge", "base")])


class ParseTests(unittest.TestCase):
    def test_parses_one_and_many_challenges_in_wire_order(self):
        raw = challenge("tempo", "charge", TEMPO_CHARGE) + ", " + challenge("stripe", "charge", {"amount": 100, "currency": "usd"}, cid="def", expires="")
        items = mpp_offers.parse(raw)
        self.assertEqual([(i["index"], i["method"], i["intent"]) for i in items], [(0, "tempo", "charge"), (1, "stripe", "charge")])
        self.assertEqual(items[0]["request"], TEMPO_CHARGE)
        self.assertEqual(items[0]["realm"], "api.example.com")
        self.assertIsInstance(items[0]["expires"], int)
        self.assertIsNone(items[1]["expires"])

    def test_malformed_input_is_no_offer(self):
        for bad in ("Basic realm=x", 'Payment id="a"', 'Payment id="a", realm="r", method="tempo", intent="charge", request="!!"',
                    'Payment id="a", realm="r", method="tempo", intent="charge", request="%s"' % b64([1, 2]), "", "x" * 20000):
            with self.subTest(bad=bad[:40]):
                self.assertEqual(mpp_offers.from_headers({"WWW-Authenticate": bad}), [])
        self.assertEqual(mpp_offers.from_headers({}), [])
        self.assertEqual(mpp_offers.from_headers({"www-authenticate": "Bearer realm=x"}), [])


class NormalizeTests(unittest.TestCase):
    def test_tempo_charge_is_a_classified_charge_on_the_tempo_rail(self):
        offer = mpp_offers.from_headers({"www-authenticate": challenge("tempo", "charge", TEMPO_CHARGE)})[0]
        self.assertEqual((offer["method"], offer["intent"], offer["network"], offer["rail"]), ("tempo", "charge", "eip155:4217", "tempo"))
        self.assertEqual((offer["asset"], offer["payTo"], offer["amount_atomic"]), (TEMPO_USD, RECIPIENT, 1000000))
        self.assertTrue(offer["classified"])
        self.assertEqual(evm_chains.rail_of_network("eip155:4217"), "tempo")
        self.assertIsNone(evm_chains.usdc_of_rail("tempo"))

    def test_tempo_default_chain_and_missing_terms(self):
        no_chain = dict(TEMPO_CHARGE, methodDetails={})
        offer = mpp_offers.from_headers({"www-authenticate": challenge("tempo", "charge", no_chain)})[0]
        self.assertEqual(offer["network"], "eip155:4217")
        self.assertTrue(offer["classified"])
        no_amount = {k: v for k, v in TEMPO_CHARGE.items() if k != "amount"}
        offer = mpp_offers.from_headers({"www-authenticate": challenge("tempo", "charge", no_amount)})[0]
        self.assertFalse(offer["classified"])
        evm_no_chain = dict(BASE_CHARGE, methodDetails={"credentialTypes": ["authorization"]})
        offer = mpp_offers.from_headers({"www-authenticate": challenge("evm", "charge", evm_no_chain)})[0]
        self.assertFalse(offer["classified"])
        self.assertNotIn("network", offer)

    def test_session_and_subscription_terms_are_observed_not_priced(self):
        offers = mpp_offers.from_headers({"www-authenticate": challenge("tempo", "session", TEMPO_SESSION) + ", " + challenge("tempo", "subscription", TEMPO_SUB, cid="sub1")})
        session, sub = offers
        self.assertEqual((session["intent"], session["unit_amount_atomic"], session["unit_type"], session["suggested_deposit_atomic"]), ("session", 10, "llm_token", 5000000))
        self.assertEqual((session["session_protocol"], session["escrow_contract"]), ("v2", "0x" + "e" * 40))
        self.assertTrue(session["classified"])
        self.assertEqual((sub["intent"], sub["amount_atomic"], sub["period_count"], sub["period_unit"]), ("subscription", 9990000, 1, "month"))
        self.assertIsInstance(sub["subscription_expires"], int)
        self.assertEqual(mpp_offers.charge_options(offers), [])
        terms = mpp_offers.public_terms(offers)
        self.assertEqual([t["intent"] for t in terms], ["session", "subscription"])
        self.assertNotIn("id", terms[0])

    def test_unknown_method_stays_visible_and_unclassified(self):
        offer = mpp_offers.from_headers({"www-authenticate": challenge("stripe", "charge", {"amount": 100, "currency": "usd"})})[0]
        self.assertEqual((offer["method"], offer["classified"]), ("stripe", False))
        self.assertNotIn("network", offer)


class OptionTests(unittest.TestCase):
    def _result(self, header, envelope=None):
        result = {"live": True, "url": "https://seller.example/api", "mpp_offers": mpp_offers.from_headers({"www-authenticate": header})}
        if envelope is not None:
            result["envelope"] = envelope
        return result

    def test_mpp_only_base_charge_is_a_complete_usd_priced_option(self):
        result = self._result(challenge("evm", "charge", BASE_CHARGE))
        opts = payment.payment_options_from_result(result)
        self.assertEqual(len(opts), 1)
        opt = opts[0]
        self.assertEqual((opt["scheme"], opt["rail"], opt["network"], opt["normalized_usd"], opt["display_amount"]), ("mpp-charge", "base", "eip155:8453", 0.005, "$0.005"))
        self.assertTrue(payment.is_complete_payment_option(opt))
        self.assertTrue(select._is_payable(result))
        selected = select.pick_selected_payment(result)
        self.assertEqual(selected["payTo"], PAYTO)
        public = payment.selected_payment_fields(selected)
        self.assertEqual((public["scheme"], public["mpp"]["method"], public["mpp"]["intent"]), ("mpp-charge", "evm", "charge"))

    def test_tempo_charge_is_payable_without_a_dollar_figure(self):
        result = self._result(challenge("tempo", "charge", TEMPO_CHARGE))
        opt = payment.payment_options_from_result(result)[0]
        self.assertEqual((opt["rail"], opt["normalized_usd"], opt["decimals"]), ("tempo", None, None))
        self.assertEqual(opt["display_amount"], "1000000 " + TEMPO_USD)
        self.assertTrue(payment.is_complete_payment_option(opt))
        self.assertTrue(select._is_payable(result))
        lock = select.parse_constraints({"networks": ["tempo"]})
        self.assertTrue(select.selected_payment_matches_networks(select.pick_selected_payment(result), lock))

    def test_x402_and_mpp_offers_are_both_observed_and_cheapest_wins(self):
        x402 = {"scheme": "exact", "network": "eip155:8453", "asset": BASE_USDC, "amount": "10000", "payTo": PAYTO, "maxTimeoutSeconds": 60}
        result = self._result(challenge("evm", "charge", BASE_CHARGE), envelope={"x402Version": 2, "accepts": [x402]})
        opts = payment.payment_options_from_result(result)
        self.assertEqual(sorted(o["scheme"] for o in opts), ["exact", "mpp-charge"])
        selected = select.pick_selected_payment(result, "cheapest")
        self.assertEqual((selected["scheme"], selected["amount_atomic"]), ("mpp-charge", 5000))

    def test_x402_selected_payment_projection_is_unchanged(self):
        x402 = {"scheme": "exact", "network": "eip155:8453", "asset": BASE_USDC, "amount": "10000", "payTo": PAYTO, "maxTimeoutSeconds": 60}
        result = {"live": True, "envelope": {"x402Version": 2, "accepts": [x402]}}
        public = payment.selected_payment_fields(select.pick_selected_payment(result))
        self.assertEqual(set(public), {"rail", "network", "asset", "amount_atomic", "display_amount", "normalized_usd", "payTo", "facilitator"})


class ProbeTests(unittest.TestCase):
    def test_health_from_probe_carries_public_terms(self):
        snap = {"live": True, "status": 402, "latency_ms": 12, "has_402_challenge": True, "payTo": RECIPIENT,
                "mpp_offers": mpp_offers.from_headers({"www-authenticate": challenge("tempo", "charge", TEMPO_CHARGE)})}
        out = probe.health_from_probe("https://seller.example/api", snap)
        self.assertEqual(out["mpp_offers"][0]["network"], "eip155:4217")
        self.assertNotIn("id", out["mpp_offers"][0])
        self.assertNotIn("mpp_offers", probe.health_from_probe("https://seller.example/api", {"live": False, "status": 500}))


if __name__ == "__main__":
    unittest.main()
