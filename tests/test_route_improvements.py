import io
import urllib.error
import json
import os
import tempfile
import unittest
from unittest.mock import patch, MagicMock

from live402 import history, lab_traffic, reputation, route, probe, route_observability as telemetry
from live402.route_binding import BindingError
import test_route_binding as binding_tests
from test_route_binding import bound_winner
from test_success_only_billing import RESOURCE


class DiagnosticsTests(unittest.TestCase):
    setUp = binding_tests.BindingTests.setUp
    cleanup = binding_tests.BindingTests.cleanup
    execute = binding_tests.BindingTests.execute

    def test_safe_binding_reasons_and_timings_survive_replay(self):
        with patch('live402.route_binding.build', side_effect=BindingError('unsupported_challenge')):
            first, calls = self.execute((200, bound_winner()))
        self.assertEqual(calls, (1, 1, 0, 0))
        self.assertEqual(first[1]['binding_error_reason'], 'unsupported_challenge')
        self.assertEqual(first[1]['route_outcome']['code'], 'binding_failed')
        self.assertFalse(first[1]['route_outcome']['automatic_payment_retry'])
        self.assertTrue({'verification','routing_probe','binding_validation'} <= first[1]['timings_ms'].keys())
        again, calls = self.execute((200, bound_winner()))
        self.assertEqual(first, again)
        self.assertEqual(calls, (0, 0, 0, 0))

    def test_actual_wire_challenge_reason_survives_billable_validation(self):
        winner = bound_winner()
        envelope = {**winner['envelope'], 'inputSchema': {'type':'object'}}
        opener = MagicMock()
        opener.open.side_effect = urllib.error.HTTPError(winner['url'], 402, 'Payment required',
            {'Content-Type':'application/json'}, io.BytesIO(json.dumps(envelope).encode()))
        with patch('live402.probe._opener', return_value=opener):
            snap = probe._one_request(winner['url'], 'GET', pinned_addrs=[('fixture',)])
        self.assertIsNone(snap['binding_observation'])
        self.assertEqual(snap['binding_error_reason'], 'unsupported_challenge')
        winner.pop('binding_observation')
        winner['binding_error_reason'] = snap['binding_error_reason']
        out, calls = self.execute((200, winner))
        self.assertEqual(calls, (1,1,0,0))
        self.assertEqual(out[1]['binding_error_reason'], 'unsupported_challenge')

    def test_exception_messages_are_never_public_diagnostics(self):
        for exc in (ValueError('PRIVATE_CANARY'), TypeError('PRIVATE_CANARY'), BindingError('https://private.example/secret')):
            self.assertEqual(telemetry.binding_reason(exc), 'invalid_evidence')
        with patch('live402.route_binding.build', side_effect=ValueError('PRIVATE_CANARY')):
            out, _ = self.execute((200, bound_winner()))
        self.assertNotIn('PRIVATE_CANARY', json.dumps(out))

    def test_contradictory_billing_never_advises_new_payment(self):
        out = telemetry.outcome(200, {'billing':{'settlement_state':'settled','settled':True,'settlement_attempted':False}})
        self.assertEqual(out['code'],'settlement_unknown')
        self.assertFalse(out['automatic_payment_retry'])

    def test_unpaid_challenge_body_and_header_remain_identical(self):
        import base64
        code, body, headers = route.handle_route({}, {}, RESOURCE)
        self.assertEqual(code,402)
        self.assertEqual(body,json.loads(base64.b64decode(headers['PAYMENT-REQUIRED'])))
        self.assertNotIn('timings_ms',body)

    def test_timing_context_does_not_leak_between_requests(self):
        with telemetry.trace() as first:
            with telemetry.phase('verification'): pass
        with telemetry.trace() as second:
            self.assertEqual(second,{})
        self.assertIn('verification',first)


class OperatorScoringTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.env=patch.dict(os.environ,{'LIVE402_HISTORY_DB':self.tmp.name+'/history.sqlite','LIVE402_LAB_ORIGINS':'https://lab.example'})
        self.env.start();self.addCleanup(self.env.stop);history.reset();self.addCleanup(history.reset)

    def record(self,url,**extra):
        history.record_probe(url,{'live':True,'status':402,'payable':True,'rail':'base','amount':'1000','payTo':'0x'+'11'*20,**extra})

    def test_operator_history_retained_without_score_or_confidence_growth(self):
        url='https://lab.example/base/test'
        self.record(url);first=reputation.for_result({},evidence=history.reputation_evidence(url))
        for _ in range(25):self.record(url)
        evidence=history.reputation_evidence(url);last=reputation.for_result({},evidence=evidence)
        self.assertEqual(evidence['n_7d'],26);self.assertEqual(evidence['self_test_count_7d'],26)
        self.assertEqual(evidence['scoring_probe_count_7d'],0)
        self.assertEqual(first['reputation_score'],last['reputation_score'])
        self.assertEqual(first['reputation_confidence'],last['reputation_confidence'])
        self.assertNotIn('usage',last['scoring_components']['present'])
        self.assertNotIn('observed_performance',last['scoring_components']['present'])
        self.assertEqual(history.summary(url)['n_7d'],26)

    def test_caller_cannot_select_traffic_class_and_persisted_class_is_sticky(self):
        url='https://ordinary.example/api'
        self.record(url,traffic_class='self_test',lab_testing=lab_traffic.classification())
        self.assertEqual(history.reputation_evidence(url)['scoring_probe_count_7d'],1)
        lab='https://lab.example/api';self.record(lab,traffic_class='organic')
        with patch.dict(os.environ,{'LIVE402_LAB_ORIGINS':''}):
            self.assertEqual(history.reputation_evidence(lab)['scoring_probe_count_7d'],0)

    def test_legacy_unknown_rows_on_configured_lab_origin_are_excluded_on_read(self):
        url='https://lab.example/old'
        with patch.dict(os.environ,{'LIVE402_LAB_ORIGINS':''}):self.record(url)
        self.assertEqual(history.reputation_evidence(url)['scoring_probe_count_7d'],0)
        self.assertEqual(history._connect().execute('SELECT traffic_class FROM probes').fetchone()[0],'unclassified')

    def test_schema_upgrade_preserves_existing_observations(self):
        url='https://ordinary.example/legacy';self.record(url)
        conn=history._connect()
        original=conn.execute('SELECT id,url,ts,live FROM probes').fetchall()
        conn.execute('ALTER TABLE probes DROP COLUMN traffic_class');conn.commit();conn.close()
        history._conn=None;history._conn_path=None
        evidence=history.reputation_evidence(url)
        self.assertEqual(evidence['n_7d'],1)
        self.assertEqual(history._connect().execute('SELECT id,url,ts,live FROM probes').fetchall(),original)
        self.assertEqual(history._connect().execute('SELECT traffic_class FROM probes').fetchone()[0],'unclassified')

    def test_history_read_failure_cannot_restore_lab_scoring(self):
        result={'url':'https://lab.example/api','history':{'n_7d':100,'success_7d':1}}
        with patch('live402.history.reputation_evidence',side_effect=OSError('unavailable')):
            rep=reputation.attach(result)['reputation']
        self.assertEqual(rep['usage']['scoring_probe_count']['value'],0)
        self.assertNotIn('usage',rep['scoring_components']['present'])
        self.assertNotIn('observed_performance',rep['scoring_components']['present'])

    def test_model_is_versioned_and_unclassified_is_not_claimed_organic(self):
        spec=reputation.model_spec();self.assertEqual(spec['model_id'],'reputation-v2')
        self.assertIn('not proof of organic',spec['traffic_policy']['unclassified'])
