"""Seller terms cannot bypass the routing-fee gate. All I/O is synthetic."""
import base64
import copy
import json
import urllib.error
from io import BytesIO
import time
import unittest
from unittest.mock import MagicMock, patch
from live402 import payment, probe, route, route_binding, select
from tests import test_success_only_billing as fixtures


class OfferTermBoundaryTests(unittest.TestCase):
    def test_nested_scheme_disagreement_is_not_fixed_or_payable(self):
        for rail in payment.SUPPORTED_RAILS:
            for bad in ('upto', 'batch-settlement', 'EXACT', '', None, False, [], {}):
                for location in ('direct', 'facilitator'):
                    with self.subTest(rail=rail, bad=bad, location=location):
                        result = fixtures._winner(rail)
                        acc = result['envelope']['accepts'][0]
                        acc['extra'] = ({'scheme': bad} if location == 'direct'
                                        else {'facilitator': {'scheme': bad}})
                        self.assertIsNone(payment.payment_option_from_accept(acc)['normalized_usd'])
                        self.assertIsNone(payment.validate_observed_accept(acc, result['envelope']))
                        self.assertIsNone(select.pick_selected_payment(result))
                        self.assertFalse(route._billable_winner({}, 200, result))
                        with self.assertRaises(route_binding.BindingError):
                            route_binding.selected_index(result['envelope'], result['selected_payment'])

    def test_agreeing_optional_scheme_and_facilitator_forms_remain_valid(self):
        for rail in payment.SUPPORTED_RAILS:
            for extra in ({}, {'scheme': 'exact'}, {'facilitator': 'https://facilitator.example'},
                          {'facilitator': {'url': 'https://facilitator.example', 'scheme': 'exact'}},
                          {'scheme': 'exact', 'facilitator': {'scheme': 'exact'},
                           'version': {'opaque': ['metadata']}}):
                with self.subTest(rail=rail, extra=extra):
                    result = fixtures._winner(rail)
                    result['envelope']['accepts'][0]['extra'] = copy.deepcopy(extra)
                    result['selected_payment'] = select.pick_selected_payment(result)
                    self.assertIsNotNone(result['selected_payment'])
                    self.assertTrue(route._billable_winner({}, 200, result))

    def test_omitted_display_scheme_and_nested_variable_terms_stay_distinct(self):
        acc = fixtures._seller_accept()
        acc.pop('scheme')
        self.assertIsNotNone(payment.payment_option_from_accept(acc)['normalized_usd'])
        self.assertIsNone(payment.validate_observed_accept(acc, {'x402Version': 2}))
        acc['extra'] = {'facilitator': {'scheme': 'upto'}}
        option = payment.payment_option_from_accept(acc)
        self.assertIsNone(option['normalized_usd'])
        self.assertTrue(option['display_amount'].startswith('Up to '))

    def test_distinct_hidden_terms_cannot_select_or_bill(self):
        changes = ({'maxTimeoutSeconds': 120}, {'extra': {'feePayer': 'another-payer'}},
                   {'extra': {'facilitator': {'scheme': 'exact', 'feePayer': 'another-payer'}}},
                   {'extra': {'extension': {'limit': 100}}})
        for rail in payment.SUPPORTED_RAILS:
            for change in changes:
                for reverse in (False, True):
                    with self.subTest(rail=rail, change=change, reverse=reverse):
                        result = fixtures._winner(rail)
                        other = copy.deepcopy(result['envelope']['accepts'][0])
                        other.update(copy.deepcopy(change))
                        result['envelope']['accepts'].append(other)
                        if reverse:
                            result['envelope']['accepts'].reverse()
                        self.assertEqual(len(payment.payment_options_from_result(result)), 2)
                        self.assertIsNone(select.pick_selected_payment(result))
                        self.assertFalse(payment.selected_payment_matches_current_envelope(result['selected_payment'], result))
                        self.assertFalse(route._billable_winner({}, 200, result))
                        with self.assertRaises(route_binding.BindingError):
                            route_binding.selected_index(result['envelope'], result['selected_payment'])

    def test_identical_json_duplicates_remain_ordinary_billable(self):
        for rail in payment.SUPPORTED_RAILS:
            result = fixtures._winner(rail)
            result['envelope']['accepts'].append(dict(reversed(list(result['envelope']['accepts'][0].items()))))
            self.assertEqual(len(payment.payment_options_from_result(result)), 1)
            self.assertIsNotNone(select.pick_selected_payment(result))
            self.assertTrue(route._billable_winner({}, 200, result))
            with self.assertRaises(route_binding.BindingError):
                route_binding.selected_index(result['envelope'], result['selected_payment'])

    def test_distinct_amount_offers_still_select_the_cheapest(self):
        for rail in payment.SUPPORTED_RAILS:
            result = fixtures._winner(rail)
            result['envelope']['accepts'].insert(0, fixtures._seller_accept(rail, amount='20000'))
            result['selected_payment'] = select.pick_selected_payment(result, 'cheapest')
            self.assertEqual(result['selected_payment']['amount_atomic'], 10000)
            self.assertTrue(route._billable_winner({}, 200, result))

    def test_rejected_terms_never_settle_promote_or_append(self):
        for rail in payment.SUPPORTED_RAILS:
            for kind in ('scheme', 'ambiguity'):
                with self.subTest(rail=rail, kind=kind):
                    result = fixtures._winner(rail)
                    acc = result['envelope']['accepts'][0]
                    if kind == 'scheme':
                        acc['extra'] = {'facilitator': {'scheme': 'upto'}}
                    else:
                        other = copy.deepcopy(acc)
                        other['maxTimeoutSeconds'] = 120
                        result['envelope']['accepts'].append(other)
                    with patch('live402.facilitator.verify', return_value=fixtures._verified()), \
                         patch('live402.replay.authorize', return_value=True), \
                         patch('live402.route.run_probe', return_value=(200, result)), \
                         patch('live402.facilitator.settle', return_value=fixtures._settled()) as settle, \
                         patch('live402.history.mark_batch_settled') as promote, \
                         patch('live402.route._attach_pq_trust') as append:
                        _, body, _ = route._paid_execute({'need': 'weather'}, {'x402Version': 2, 'payload': {}},
                            fixtures._routing_accept(rail), fixtures.RESOURCE, None, time.monotonic()+60, 'offer-fixture')
                    settle.assert_not_called()
                    promote.assert_not_called()
                    append.assert_not_called()
                    self.assertIs(body['billing']['settlement_attempted'], False)
                    self.assertIsNone(body['selected_payment'])

    def test_ambiguous_cheaper_terms_do_not_hide_unique_offer(self):
        for rail in payment.SUPPORTED_RAILS:
            for order in ((0, 1, 2), (2, 1, 0), (1, 2, 0)):
                for objective in (None, 'cheapest', 'lowest_total_cost', 'fastest_settlement'):
                    with self.subTest(rail=rail, order=order, objective=objective):
                        result = fixtures._winner(rail)
                        first = result['envelope']['accepts'][0]
                        other = dict(first, maxTimeoutSeconds=120)
                        unique = fixtures._seller_accept(rail, amount='20000')
                        offers = [first, other, unique]
                        result['envelope']['accepts'] = [offers[i] for i in order]
                        # All otherwise eligible options have known equal overhead/latency.
                        def eco(option, _result):
                            return {'total_cost_usd': {'value': option['normalized_usd']},
                                    'settlement_or_finality_ms': {'value': 100}}
                        with patch('live402.economics.for_option', side_effect=eco):
                            selected = select.pick_selected_payment(result, objective)
                        self.assertIsNotNone(selected)
                        self.assertEqual(selected['amount_atomic'], 20000)
                        result['selected_payment'] = selected
                        self.assertTrue(route._billable_winner({}, 200, result))
                        self.assertEqual(route_binding.selected_index(result['envelope'], selected),
                                         order.index(2))

    def test_duplicate_wire_terms_never_become_payable(self):
        for rail in payment.SUPPORTED_RAILS:
            result = fixtures._winner(rail)
            normal = json.dumps(result['envelope'])
            variants = [
                normal.replace('"scheme": "exact"', '"scheme":"upto","scheme":"exact"'),
                normal.replace('"maxTimeoutSeconds": 60', '"maxTimeoutSeconds":120,"maxTimeoutSeconds":60'),
                normal.replace('"maxTimeoutSeconds": 60',
                               '"maxTimeoutSeconds":60,"extra":{"facilitator":{"scheme":"upto","scheme":"exact"}}'),
                normal.replace('"maxTimeoutSeconds": 60',
                               '"maxTimeoutSeconds":60,"extra":{"scheme":"upto"},"extra":{"scheme":"exact"}'),
                normal.replace('"maxTimeoutSeconds": 60',
                               '"maxTimeoutSeconds":60,"extra":{"facilitator":{"scheme":"upto"},"facilitator":{"scheme":"exact"}}'),
            ]
            for raw in variants:
                encoded = base64.b64encode(raw.encode()).decode()
                valid_header = base64.b64encode(normal.encode()).decode()
                channels = [
                    ({}, raw.encode()),
                    ({'payment-required': encoded}, b''),
                    ({'x-payment-required': encoded}, b''),
                    ({'payment-required': raw}, b''),
                    ({'payment-required': encoded}, normal.encode()),
                    ({'payment-required': valid_header}, raw.encode()),
                    ({'payment-required': valid_header, 'x-payment-required': encoded}, b''),
                ]
                for headers, body in channels:
                    with self.subTest(rail=rail, raw=raw, headers=list(headers)):
                        opener = MagicMock()
                        opener.open.side_effect = urllib.error.HTTPError(
                            result['url'], 402, 'Payment Required', headers, BytesIO(body))
                        with patch('live402.probe._opener', return_value=opener):
                            snap = probe._one_request(result['url'], 'GET', pinned_addrs=[('fixture',)])
                        observed = dict(result, **snap)
                        self.assertFalse(observed['live'])
                        self.assertIsNone(select.pick_selected_payment(observed))
                        self.assertFalse(route._billable_winner({}, 200, observed))
                        with patch('live402.facilitator.verify', return_value=fixtures._verified()), \
                             patch('live402.replay.authorize', return_value=True), \
                             patch('live402.route.run_probe', return_value=(200, observed)), \
                             patch('live402.facilitator.settle') as settle, \
                             patch('live402.history.mark_batch_settled') as promote, \
                             patch('live402.route._attach_pq_trust') as append:
                            _, out, _ = route._paid_execute(
                                {'need': 'weather'}, {'x402Version': 2, 'payload': {}},
                                fixtures._routing_accept(rail), fixtures.RESOURCE, None,
                                time.monotonic()+60, 'duplicate-wire-fixture')
                        settle.assert_not_called()
                        promote.assert_not_called()
                        append.assert_not_called()
                        self.assertIs(out['billing']['settlement_attempted'], False)

    def test_unambiguous_wire_forms_remain_ordinary_billable(self):
        for rail in payment.SUPPORTED_RAILS:
            result = fixtures._winner(rail)
            result['envelope']['accepts'][0]['extra'] = {
                'facilitator': {'scheme': 'exact'}, 'opaque': {'ratio': 0.5}}
            raw = json.dumps(result['envelope']).encode()
            encoded = base64.b64encode(raw).decode()
            for headers, body in (({}, raw), ({'payment-required': encoded}, b''),
                                  ({'x-payment-required': encoded}, raw),
                                  ({'payment-required': raw.decode()}, b'')):
                envelope, miss = probe.parse_envelope(402, headers, body)
                self.assertIsNone(miss)
                observed = dict(result, envelope=envelope)
                observed['selected_payment'] = select.pick_selected_payment(observed)
                self.assertIsNotNone(observed['selected_payment'])
                self.assertTrue(route._billable_winner({}, 200, observed))


if __name__ == '__main__':
    unittest.main()
