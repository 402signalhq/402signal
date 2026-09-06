"""HTTP success for completed unpaid misses must not grant economic authority."""
import copy
import time
import unittest
from unittest.mock import patch

from live402 import mcp, replay, route
from live402.route_outcomes import NORMAL_MISS_REASONS
from test_success_only_billing import _miss, _payload, _routing_accept, _verified, RESOURCE


class MissStatusTests(unittest.TestCase):
    def execute(self, body):
        with patch('live402.facilitator.verify', return_value=_verified()), \
             patch('live402.replay.authorize', return_value=True), \
             patch('live402.route.run_probe', return_value=(503, body)), \
             patch('live402.facilitator.settle') as settle, \
             patch('live402.history.mark_batch_settled') as mark, \
             patch('live402.route._attach_pq_trust') as proof:
            out = route._paid_execute({'need': 'weather'}, _payload(), _routing_accept('base'),
                                      RESOURCE, None, time.monotonic() + 60, 'fixture')
        settle.assert_not_called()
        mark.assert_not_called()
        proof.assert_not_called()
        return out

    def test_all_completed_misses_are_unpaid_http_success(self):
        for reason in NORMAL_MISS_REASONS:
            with self.subTest(reason=reason):
                out = self.execute(_miss(reason))
                self.assertEqual(out[0], 200)
                self.assertIsNone(out[2])
                self.assertEqual(replay._explicit_outcome_state(out), replay.STATE_NOT_SETTLED)

    def test_incomplete_failed_and_malformed_results_remain_errors(self):
        changes = [
            {'error': 'discovery_unavailable'}, {'binding_error': 'unprovable'},
            {'evaluation_complete': False}, {'candidate_evaluation_complete': False},
            {'probe_budget_exhausted': True}, {'miss_reason': 'probe_timeout'},
            {'evaluation_complete': 'true'}, {'candidate_evaluation_complete': None},
            {'probe_budget_exhausted': 0},
            {'miss_reason': 'upstream_5xx'}, {'miss_reason': 'ssrf'},
            {'miss_reason': 'probe_limit_reached'}, {'miss_reason': 'new_unknown_reason'},
            {'miss_reason': []}, {'payable': True}, {'selected_payment': {}},
        ]
        for change in changes:
            with self.subTest(change=change):
                out = self.execute({**_miss(), **change})
                self.assertEqual(out[0], 503)
                self.assertIs(out[1]['billing']['settled'], False)

    def test_http_200_contradictions_cannot_be_recorded_as_unpaid(self):
        out = self.execute(_miss())
        for change in ({'live': True}, {'payable': True}, {'selected_payment': {}},
                       {'miss_reason': 'probe_timeout'}, {'error': 'broken'},
                       {'candidate_evaluation_complete': False}):
            body = {**copy.deepcopy(out[1]), **change}
            self.assertIsNone(replay._explicit_outcome_state((200, body, None)))
        for key in ('live', 'payable', 'selected_payment', 'miss_reason'):
            body = copy.deepcopy(out[1]); body.pop(key)
            self.assertIsNone(replay._explicit_outcome_state((200, body, None)))
        self.assertEqual(replay._explicit_outcome_state((200, out[1], {'payment-response': 'receipt'})),
                         replay.STATE_UNKNOWN)

    def test_need_discovery_miss_gets_explicit_non_executable_fields(self):
        with patch('live402.probe.route_need', return_value={'live': False, 'miss_reason': 'no_candidates'}):
            code, body = route.run_probe({'need': 'weather'})
        self.assertEqual(code, 503)  # Internal producer remains separate from the paid boundary.
        self.assertIs(body['payable'], False)
        self.assertIsNone(body['selected_payment'])
        self.assertEqual(self.execute(body)[0], 200)

    def test_mcp_normal_miss_is_correlated_success_without_payment_receipt(self):
        out = self.execute(_miss('reachable_200'))
        for version in mcp.SUPPORTED_PROTOCOLS:
            with patch('live402.mcp.handle_route', return_value=out):
                status, response, headers = mcp.handle_mcp(
                    {'jsonrpc': '2.0', 'id': 'miss-1', 'method': 'tools/call',
                     'params': {'name': 'route', 'arguments': {'need': 'weather'}}},
                    {'MCP-Protocol-Version': version}, 'https://402signal.com/mcp')
            self.assertEqual(status, 200)
            self.assertEqual(response['id'], 'miss-1')
            self.assertIs(response['result']['isError'], False)
            self.assertNotIn('PAYMENT-RESPONSE', headers or {})
