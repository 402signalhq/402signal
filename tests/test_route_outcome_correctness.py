"""Route outcome correctness: constraint misses stay truthful; schema is not a fake miss."""

from __future__ import annotations

import os
import tempfile
import unittest
from unittest.mock import patch

os.environ.setdefault("LIVE402_FIXTURE", "1")
os.environ.pop("LOCAL_FREE", None)

from live402 import payment, probe, replay, route, select
from live402.pq import events as pq_events
from live402.route import handle_route
from live402.route_outcomes import is_normal_miss
from tests.test_success_only_billing import (
    RESOURCE,
    _headers,
    _miss,
    _payload,
    _settled,
    _verified,
    _winner,
)


def _unresolved_names(result) -> set[str]:
    names = set()
    for row in result.get("unresolved_constraints") or []:
        if isinstance(row, dict) and row.get("name"):
            names.add(str(row["name"]))
        elif row:
            names.add(str(row))
    return names


def _assert_never_settled(test, body):
    billing = body.get("billing") if isinstance(body, dict) else None
    if isinstance(billing, dict):
        test.assertIs(billing.get("settled"), False)
        test.assertIs(billing.get("settlement_attempted"), False)
        test.assertEqual(billing.get("settlement_state"), "not_attempted")
    test.assertFalse(body.get("live"))
    test.assertFalse(body.get("payable"))
    test.assertIsNone(body.get("selected_payment"))
    test.assertFalse(route._billable_winner({"need": "weather"}, 200, body))
    test.assertFalse(route._billable_winner({"need": "weather"}, 503, body))


class FixtureOutcomeTests(unittest.TestCase):
    def test_genuine_success_with_schema_has_no_top_level_miss(self):
        code, body = route.run_probe({"need": "erc20 token balance"})
        self.assertEqual(code, 200)
        self.assertTrue(body.get("live"))
        self.assertTrue(body.get("payable"))
        self.assertTrue(body.get("invocable"))
        self.assertIsInstance(body.get("selected_payment"), dict)
        self.assertNotEqual(body.get("miss_reason"), "no_input_schema")
        self.assertIsNone(body.get("miss_reason"))
        self.assertEqual(body.get("stop_reason"), "winner_selected")

    def test_optional_schema_absence_on_solana_and_algorand_is_informational(self):
        cases = (
            {"need": "web search", "url": "https://fixture.402signal.local/solana/search"},
            {"need": "weather", "url": "https://fixture.402signal.local/algorand/weather"},
        )
        for body in cases:
            with self.subTest(url=body["url"]):
                code, result = route.run_probe(body)
                self.assertEqual(code, 200)
                self.assertTrue(result.get("live"))
                self.assertTrue(result.get("payable"))
                self.assertFalse(result.get("invocable"))
                self.assertIsInstance(result.get("selected_payment"), dict)
                self.assertNotEqual(result.get("miss_reason"), "no_input_schema")
                self.assertIsNone(result.get("miss_reason"))
                target = result.get("target") or {}
                self.assertFalse(target.get("inputSchema"))

    def test_required_schema_failure_is_honest_and_unsettled(self):
        code, body = route.run_probe({
            "need": "weather",
            "url": "https://fixture.402signal.local/algorand/weather",
            "require_invocable": True,
        })
        self.assertEqual(code, 503)
        _assert_never_settled(self, body)
        self.assertIn(body.get("miss_reason"), {"constraints_unmet", "no_input_schema"})
        if body.get("miss_reason") == "constraints_unmet":
            self.assertTrue(body.get("unresolved_constraints"))
            self.assertIn("require_invocable", body.get("unmet_constraints") or [])
            self.assertIn("require_invocable", _unresolved_names(body))

    def test_real_constraint_mismatch_lists_unmet_requirements(self):
        code, body = route.run_probe({
            "need": "weather",
            "url": "https://fixture.402signal.local/weather",
            "max_price_usd": 0.0001,
        })
        self.assertEqual(code, 503)
        _assert_never_settled(self, body)
        self.assertEqual(body.get("miss_reason"), "constraints_unmet")
        self.assertTrue(body.get("unresolved_constraints"))
        self.assertIn("max_price_usd", body.get("unmet_constraints") or [])
        self.assertIn("max_price_usd", _unresolved_names(body))

    def test_no_candidate_needs_are_not_empty_constraint_misses(self):
        for need in ("crypto news", "image generation"):
            with self.subTest(need=need):
                code, body = route.run_probe({"need": need})
                self.assertEqual(code, 503)
                _assert_never_settled(self, body)
                self.assertEqual(body.get("miss_reason"), "no_candidates")
                self.assertNotEqual(body.get("miss_reason"), "constraints_unmet")
                self.assertFalse(body.get("unmet_constraints"))

    def test_live_incomplete_payment_is_not_empty_constraint_miss(self):
        url = "https://wx.example/incomplete-pay"
        item = {"url": url, "description": "crypto news headline feed"}
        probed = {
            "url": url,
            "live": True,
            "status": 402,
            "has_402_challenge": True,
            "challenge_observed": True,
            "payTo": None,
            "envelope": {"x402Version": 2, "accepts": [{"network": payment.BASE_CAIP2}]},
            "latency_ms": 12,
        }
        probed = probe.attach_invocable_target(probed, item, probed["envelope"])
        with patch("live402.probe.fetch_discovery", return_value=[item]), patch(
            "live402.probe.probe_url", return_value=probed
        ):
            code, body = route.run_probe({"need": "crypto news"})
        self.assertEqual(code, 503)
        _assert_never_settled(self, body)
        self.assertNotEqual(body.get("miss_reason"), "constraints_unmet")
        self.assertIn(body.get("miss_reason"), {"no_payto", "no_402_envelope"})
        self.assertFalse(body.get("unmet_constraints"))

    def test_transient_capacity_stays_operational_503(self):
        url = "https://wx.example/capacity"
        item = {"url": url, "description": "image generation"}
        probed = {
            "url": url,
            "live": False,
            "payable": False,
            "invocable": False,
            "selected_payment": None,
            "miss_reason": "probe_capacity",
            "retryable": True,
        }
        with patch("live402.probe.fetch_discovery", return_value=[item]), patch(
            "live402.probe.probe_url", return_value=probed
        ):
            code, body = route.run_probe({"need": "image generation"})
        self.assertEqual(code, 503)
        _assert_never_settled(self, body)
        self.assertEqual(body.get("miss_reason"), "probe_capacity")
        self.assertTrue(body.get("retryable"))
        self.assertFalse(is_normal_miss(body))


class PaidReplayConsistencyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.previous = os.environ.get("LIVE402_REPLAY_DB")
        os.environ["LIVE402_REPLAY_DB"] = os.path.join(self.tmp.name, "replay.sqlite")
        replay.reset()
        self.headers = _headers(_payload("outcome-correctness"))

    def tearDown(self):
        replay.reset()
        if self.previous is None:
            os.environ.pop("LIVE402_REPLAY_DB", None)
        else:
            os.environ["LIVE402_REPLAY_DB"] = self.previous
        self.tmp.cleanup()

    def test_optional_schema_winner_settles_without_schema_miss_and_replays(self):
        winner = _winner("solana")
        winner["invocable"] = False
        winner.pop("miss_reason", None)
        request = {
            "need": "web search",
            "url": "https://fixture.402signal.local/solana/search",
        }
        evidence = {}

        def attach(code, result, body):
            ev = pq_events.private_evidence_v3_from_route(result, body)
            evidence["http"] = ev
            return result

        with patch("live402.facilitator.verify", return_value=_verified()), patch(
            "live402.route.run_probe", return_value=(200, winner)
        ), patch("live402.facilitator.settle", return_value=_settled()), patch(
            "live402.history.mark_batch_settled"
        ), patch("live402.route._attach_pq_trust", side_effect=attach):
            first = handle_route(request, self.headers, RESOURCE)
            replay.reset_memory()
            second = handle_route(request, self.headers, RESOURCE)
        self.assertEqual(first, second)
        code, body, extra = first
        self.assertEqual(code, 200)
        self.assertTrue(body.get("billing", {}).get("settled"))
        self.assertIsNone(body.get("miss_reason"))
        self.assertNotEqual(body.get("miss_reason"), "no_input_schema")
        self.assertIn("PAYMENT-RESPONSE", extra or {})
        self.assertEqual(evidence["http"]["decision"]["miss_reason"], None)
        self.assertEqual(evidence["http"]["decision"]["outcome"], "winner")
        self.assertIs(evidence["http"]["observation"]["invocable"], False)
        self.assertIs(evidence["http"]["observation"]["payable"], True)
        replay_ev = pq_events.private_evidence_v3_from_route(second[1], request)
        self.assertEqual(replay_ev["decision"], evidence["http"]["decision"])

    def test_constraint_miss_never_settles_and_replays_the_same_decision(self):
        miss = _miss("constraints_unmet")
        miss["unmet_constraints"] = ["max_price_usd"]
        miss["unresolved_constraints"] = [{"name": "max_price_usd", "reason": "unmet"}]
        miss["evaluation_complete"] = True
        miss["candidate_evaluation_complete"] = True
        miss["probe_budget_exhausted"] = False
        request = {"need": "weather", "max_price_usd": 0.0001}

        with patch("live402.facilitator.verify", return_value=_verified()) as verify, patch(
            "live402.route.run_probe", return_value=(503, miss)
        ) as probed, patch("live402.facilitator.settle") as settle, patch(
            "live402.history.mark_batch_settled"
        ) as mark, patch("live402.route._attach_pq_trust") as attach:
            first = handle_route(request, self.headers, RESOURCE)
            replay.reset_memory()
            second = handle_route(request, self.headers, RESOURCE)
        self.assertEqual(first, second)
        code, body, extra = first
        self.assertEqual(code, 200)
        self.assertTrue(is_normal_miss(body))
        self.assertEqual(body.get("miss_reason"), "constraints_unmet")
        self.assertIn("max_price_usd", _unresolved_names(body))
        _assert_never_settled(self, body)
        self.assertIsNone(extra)
        self.assertEqual((verify.call_count, probed.call_count, settle.call_count), (1, 1, 0))
        mark.assert_not_called()
        attach.assert_not_called()
        self.assertEqual(second[1].get("miss_reason"), "constraints_unmet")
        self.assertEqual(second[1].get("billing"), body.get("billing"))

    def test_saved_empty_constraint_miss_through_paid_assembly(self):
        saved = {
            "live": False,
            "payable": False,
            "invocable": False,
            "selected_payment": None,
            "miss_reason": "constraints_unmet",
            "unresolved_constraints": [],
            "unmet_constraints": [],
            "stop_reason": "constraints_unmet",
            "tried": 2,
            "candidates_probed": 2,
            "probed_count": 2,
            "compared": [{"url": "https://wx.example/news", "live": True, "selected": False}],
            "last": {"url": "https://wx.example/news", "status": 402, "latency_ms": 18},
            "evaluation_complete": True,
            "candidate_evaluation_complete": True,
            "probe_budget_exhausted": False,
        }
        with patch("live402.facilitator.verify", return_value=_verified()), patch(
            "live402.probe.route_need", return_value=dict(saved)
        ), patch("live402.facilitator.settle") as settle:
            code, body, extra = handle_route({"need": "crypto news"}, self.headers, RESOURCE)
        self.assertEqual(code, 200)
        self.assertTrue(is_normal_miss(body))
        self.assertNotEqual(body.get("miss_reason"), "no_candidates")
        self.assertNotEqual(body.get("miss_reason"), "constraints_unmet")
        self.assertIn(body.get("miss_reason"), {"no_402_envelope", "no_payto"})
        self.assertFalse(body.get("unmet_constraints"))
        _assert_never_settled(self, body)
        settle.assert_not_called()
        self.assertIsNone(extra)

    def test_saved_schema_miss_winner_through_paid_assembly(self):
        winner = _winner("solana")
        winner["invocable"] = False
        winner["miss_reason"] = "no_input_schema"
        with patch("live402.facilitator.verify", return_value=_verified()), patch(
            "live402.probe.route_need", return_value=dict(winner)
        ), patch("live402.facilitator.settle", return_value=_settled()) as settle:
            code, body, extra = handle_route({"need": "web search"}, self.headers, RESOURCE)
        self.assertEqual(code, 200)
        self.assertTrue(body.get("live"))
        self.assertTrue(body.get("payable"))
        self.assertFalse(body.get("invocable"))
        self.assertIsNone(body.get("miss_reason"))
        self.assertTrue(body.get("billing", {}).get("settled"))
        settle.assert_called_once()
        self.assertIn("PAYMENT-RESPONSE", extra or {})
        ev = pq_events.private_evidence_v3_from_route(body, {"need": "web search"})
        self.assertIsNone(ev["decision"]["miss_reason"])
        self.assertEqual(ev["decision"]["outcome"], "winner")

    def test_capacity_miss_stays_503_unsettled_and_not_a_normal_miss(self):
        miss = _miss("probe_capacity")
        miss["retryable"] = True
        with patch("live402.facilitator.verify", return_value=_verified()), patch(
            "live402.route.run_probe", return_value=(503, miss)
        ), patch("live402.facilitator.settle") as settle:
            code, body, extra = handle_route(
                {"need": "image generation"}, self.headers, RESOURCE
            )
        self.assertEqual(code, 503)
        self.assertEqual(body.get("miss_reason"), "probe_capacity")
        _assert_never_settled(self, body)
        self.assertFalse(is_normal_miss(body))
        settle.assert_not_called()
        self.assertEqual((extra or {}).get("Retry-After"), "60")

    def test_sdk_guard_interprets_winner_without_schema_miss_and_constraint_miss(self):
        winner = {
            "live": True,
            "payable": True,
            "invocable": False,
            "selected_payment": _winner()["selected_payment"],
            "billing": {
                "model": payment.ROUTING_BILLING_MODEL,
                "condition": payment.ROUTING_SETTLEMENT_CONDITION,
                "asset": "USDC",
                "amount_atomic": payment.AMOUNT_ATOMIC,
                "display_amount": payment.AMOUNT_USD,
                "rail": "solana",
                "settlement_attempted": True,
                "settled": True,
                "settlement_state": "settled",
            },
        }
        self.assertFalse(is_normal_miss(winner))
        self.assertNotEqual(winner.get("miss_reason"), "no_input_schema")

        miss = {
            "live": False,
            "payable": False,
            "invocable": False,
            "selected_payment": None,
            "miss_reason": "constraints_unmet",
            "unresolved_constraints": [{"name": "networks", "reason": "unmet"}],
            "evaluation_complete": True,
            "candidate_evaluation_complete": True,
            "probe_budget_exhausted": False,
            "billing": {
                "model": payment.ROUTING_BILLING_MODEL,
                "condition": payment.ROUTING_SETTLEMENT_CONDITION,
                "asset": "USDC",
                "amount_atomic": payment.AMOUNT_ATOMIC,
                "display_amount": payment.AMOUNT_USD,
                "rail": "base",
                "settlement_attempted": False,
                "settled": False,
                "settlement_state": "not_attempted",
            },
        }
        self.assertTrue(is_normal_miss(miss))
        self.assertTrue(miss.get("unresolved_constraints"))


class SavedCaseAssemblyTests(unittest.TestCase):
    """Original contradictory bodies must go through run_probe, not a helper-only rewrite."""

    def test_empty_constraint_miss_with_observed_candidates_is_not_no_candidates(self):
        saved = {
            "live": False,
            "payable": False,
            "invocable": False,
            "selected_payment": None,
            "miss_reason": "constraints_unmet",
            "unresolved_constraints": [],
            "unmet_constraints": [],
            "stop_reason": "constraints_unmet",
            "tried": 2,
            "candidates_probed": 2,
            "probed_count": 2,
            "compared": [{"url": "https://wx.example/news", "live": True, "selected": False}],
            "last": {"url": "https://wx.example/news", "status": 402, "latency_ms": 18},
            "evaluation_complete": True,
            "candidate_evaluation_complete": True,
            "probe_budget_exhausted": False,
        }
        with patch("live402.probe.route_need", return_value=dict(saved)):
            code, body = route.run_probe({"need": "crypto news"})
        self.assertEqual(code, 503)
        _assert_never_settled(self, body)
        self.assertNotEqual(body.get("miss_reason"), "no_candidates")
        self.assertNotEqual(body.get("miss_reason"), "constraints_unmet")
        self.assertIn(body.get("miss_reason"), {"no_402_envelope", "no_payto"})
        self.assertFalse(body.get("unmet_constraints"))

    def test_saved_live_winner_with_schema_miss_is_informational(self):
        winner = _winner("solana")
        winner["invocable"] = False
        winner["miss_reason"] = "no_input_schema"
        with patch("live402.probe.route_need", return_value=dict(winner)):
            code, body = route.run_probe({
                "need": "web search",
                "url": None,
            })
        # url is empty so need-routing is used.
        self.assertEqual(code, 200)
        self.assertTrue(body.get("live"))
        self.assertTrue(body.get("payable"))
        self.assertFalse(body.get("invocable"))
        self.assertIsInstance(body.get("selected_payment"), dict)
        self.assertIsNone(body.get("miss_reason"))
        ev = pq_events.private_evidence_v3_from_route(body, {"need": "web search"})
        self.assertIsNone(ev["decision"]["miss_reason"])
        self.assertEqual(ev["decision"]["outcome"], "winner")
        self.assertIs(ev["observation"]["invocable"], False)

    def test_empty_constraint_miss_without_candidates_is_no_candidates(self):
        saved = {
            "live": False,
            "payable": False,
            "invocable": False,
            "selected_payment": None,
            "miss_reason": "constraints_unmet",
            "unresolved_constraints": [],
            "tried": 0,
            "candidates_probed": 0,
            "compared": [],
            "stop_reason": "constraints_unmet",
            "evaluation_complete": True,
            "candidate_evaluation_complete": True,
            "probe_budget_exhausted": False,
        }
        with patch("live402.probe.route_need", return_value=dict(saved)):
            code, body = route.run_probe({"need": "image generation"})
        self.assertEqual(code, 503)
        _assert_never_settled(self, body)
        self.assertEqual(body.get("miss_reason"), "no_candidates")


class ClassifyHelpersTests(unittest.TestCase):
    def test_classify_does_not_invent_constraints(self):
        live = {
            "live": True,
            "payable": False,
            "payTo": "0xabcabcabcabcabcabcabcabcabcabcabcabcabca",
            "envelope": {"x402Version": 2, "accepts": [{"network": payment.BASE_CAIP2}]},
        }
        reason, unmet = select.classify_non_winner([live], {})
        self.assertNotEqual(reason, "constraints_unmet")
        self.assertEqual(unmet, [])
        self.assertEqual(reason, "no_402_envelope")

    def test_publish_does_not_call_observed_candidates_no_candidates(self):
        empty = {
            "miss_reason": "constraints_unmet",
            "stop_reason": "constraints_unmet",
            "unresolved_constraints": [],
            "live": False,
        }
        select.publish_constraint_outcome(empty)
        self.assertEqual(empty.get("miss_reason"), "no_candidates")
        observed = {
            "miss_reason": "constraints_unmet",
            "stop_reason": "constraints_unmet",
            "unresolved_constraints": [],
            "live": False,
            "tried": 1,
            "candidates_probed": 1,
            "last": {"url": "https://wx.example/x", "status": 402},
        }
        select.publish_constraint_outcome(observed)
        self.assertNotEqual(observed.get("miss_reason"), "no_candidates")
        self.assertNotEqual(observed.get("miss_reason"), "constraints_unmet")
        self.assertEqual(observed.get("miss_reason"), "no_402_envelope")


if __name__ == "__main__":
    unittest.main()
