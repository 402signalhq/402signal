"""Production processing classification contract; no live facilitator or signer calls."""
import os
import time
import unittest
from unittest.mock import patch
from live402 import lab_traffic, route, replay
from test_success_only_billing import _winner, _miss, _routing_accept, _verified, _settled, _payload, _headers

ORIGIN = "https://402signal-lab-ross.fly.dev"
URL = ORIGIN + "/base/payload/sha256"

def _paid_execute(*args):
    # Isolate the post-verification pipeline. Integrated handle_route tests
    # retain the real replay database and crash/restart guarantees.
    with patch('live402.replay.authorize', return_value=True):
        return route._paid_execute(*args, fp='pipeline-fixture')

class LabTrafficTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"LIVE402_LAB_ORIGINS": ORIGIN, "LIVE402_FIXTURE": "1"})
        self.env.start()
    def tearDown(self):
        self.env.stop()
    def test_exact_origin_and_no_client_claim_authority(self):
        self.assertTrue(lab_traffic.is_lab_url(URL))
        self.assertTrue(lab_traffic.is_lab_url("  " + URL + "  "))
        self.assertTrue(lab_traffic.is_lab_url("https://402SIGNAL-LAB-ROSS.fly.dev:443/base/payload/sha256"))
        for url in [ORIGIN+".evil/path", "https://evil/"+ORIGIN, "https://user@402signal-lab-ross.fly.dev/x", "http://402signal-lab-ross.fly.dev/x"]:
            self.assertFalse(lab_traffic.is_lab_url(url))
        bad = {"url": "https://ordinary.example/x", "lab_test": lab_traffic.PROTOCOL}
        self.assertEqual(route._bad_request(bad)[0], 400)
        with patch.dict(os.environ, {"LIVE402_LAB_ORIGINS": "bad origin"}):
            self.assertFalse(lab_traffic.is_lab_url(URL))
    def test_advertised_capability_and_matching_encoded_header(self):
        import base64, json
        body, headers = route._required_pair("https://402signal.com/route")
        self.assertEqual(body['lab_testing']['origins'], [ORIGIN])
        self.assertEqual(json.loads(base64.b64decode(headers['PAYMENT-REQUIRED'])), body)
    def test_lab_transparency_and_binding_use_normal_validation(self):
        self.assertIsNone(route._bad_request({"url": URL, "require_transparency": True}))
        self.assertIsNone(route._bad_request({"url": URL, "require_route_binding": True}))
    def test_direct_probe_persists_history_and_attaches_reputation(self):
        win=_winner();win['url']=URL
        with patch('live402.route._lookup_claimed', return_value=None), patch('live402.probe.probe_url', return_value=win), \
             patch('live402.history.persist_route_batch') as persist, patch('live402.history.attach_to_result', side_effect=lambda r:r) as attach, patch('live402.reputation.attach') as reputation:
            route.run_probe({'url':URL})
            persist.assert_called_once();attach.assert_called_once();reputation.assert_called_once()
    def test_lab_success_settles_promotes_and_appends(self):
        win=_winner();win['url']=URL
        with patch('live402.facilitator.verify', return_value=_verified()), patch('live402.route.run_probe', return_value=(200,win)), \
             patch('live402.facilitator.settle', return_value=_settled()) as settle, \
             patch('live402.history.mark_batch_settled') as promote, patch('live402.route._attach_pq_trust',side_effect=lambda code,result,body:result) as pq:
            code,body,headers=_paid_execute({'url':URL,'lab_test':lab_traffic.PROTOCOL},_payload(),_routing_accept(),
                'https://402signal.com/route',None,time.monotonic()+100)
            self.assertEqual(code,200);self.assertTrue(body['billing']['settled']);self.assertIn('PAYMENT-RESPONSE',headers)
            self.assertEqual(body['lab_testing'],lab_traffic.classification())
            settle.assert_called_once();promote.assert_called_once();pq.assert_called_once()
            # Historical replay serialization preserves the public classification.
            encoded=replay._encode_outcome((code,body,headers))
            self.assertIn('self_test',encoded)
    def test_lab_miss_is_free_and_classified(self):
        with patch('live402.facilitator.verify', return_value=_verified()), patch('live402.route.run_probe', return_value=(503,_miss())), \
             patch('live402.facilitator.settle') as settle, patch('live402.history.mark_batch_settled') as promote, \
             patch('live402.route._attach_pq_trust',side_effect=lambda code,result,body:result) as pq:
            code,body,_=_paid_execute({'url':URL},_payload(),_routing_accept(),'https://402signal.com/route',None,time.monotonic()+100)
            self.assertEqual(code,200);self.assertFalse(body['billing']['settled']);self.assertEqual(body['lab_testing'],lab_traffic.classification())
            settle.assert_not_called();promote.assert_not_called();pq.assert_not_called()
    def test_normal_success_keeps_history_and_pq(self):
        with patch('live402.facilitator.verify', return_value=_verified()), patch('live402.route.run_probe', return_value=(200,_winner())), \
             patch('live402.facilitator.settle', return_value=_settled()), patch('live402.history.mark_batch_settled') as promote, \
             patch('live402.route._attach_pq_trust',side_effect=lambda code,result,body:result) as pq:
            code,body,_=_paid_execute({'url':'https://seller.example/x402'},_payload(),_routing_accept(),'https://402signal.com/route',None,time.monotonic()+100)
            self.assertEqual(code,200);self.assertNotIn('lab_testing',body);promote.assert_called_once();pq.assert_called_once()

class LabProductionEvidenceTests(unittest.TestCase):
    """Real temp history/PQ/replay stores and ephemeral Ed25519; fake payments."""
    def setUp(self):
        from test_route_binding import BindingTests
        from live402 import history
        BindingTests.setUp(self)
        self.more_env = patch.dict(os.environ, {
            "LIVE402_LAB_ORIGINS": ORIGIN,
            "LIVE402_HISTORY_DB": self.tmp.name + '/history.sqlite',
        })
        self.more_env.start()
        history.reset()
        self.addCleanup(self.more_env.stop)
        self.addCleanup(history.reset)
        self.body = {'url': URL, 'need': 'operator self-test payload/sha256',
                     'lab_test': lab_traffic.PROTOCOL,
                     'require_transparency': True, 'require_route_binding': True}

    def cleanup(self):
        from test_route_binding import BindingTests
        BindingTests.cleanup(self)

    def winner(self, rail='base'):
        from test_route_binding import bound_winner
        from live402 import route_binding
        win = bound_winner(rail)
        win['url'] = ORIGIN + '/' + rail + '/payload/sha256'
        win['binding_observation']['request'] = route_binding.request_context(win['url'], 'GET', b'')
        return win

    def test_all_rails_use_real_history_and_signed_v4_log(self):
        from live402 import history, facilitator
        from live402.pq import receipt, store
        import json
        for n, rail in enumerate(('base', 'solana', 'algorand')):
            win = self.winner(rail)
            self.body['url'] = win['url']
            win['batch_id'] = 'lab-' + rail
            history.persist_route_batch(win['batch_id'], [win])
            settled = _settled()
            settled.body.pop('payer', None)
            settled.body['network'] = _routing_accept(rail)['network']
            settled.body['transaction'] = {'base': '0x'+'cd'*32, 'solana':'2'*88, 'algorand':'A'*52}[rail]
            with patch('live402.facilitator.verify', return_value=_verified()), \
                 patch('live402.route.run_probe', return_value=(200, win)), \
                 patch('live402.facilitator.settle', return_value=settled):
                code, result, _ = _paid_execute(self.body, _payload(), _routing_accept(rail),
                    'https://402signal.com/route', None, time.monotonic()+100)
            self.assertEqual(code, 200)
            self.assertTrue(result['billing']['settled'])
            self.assertEqual(result['lab_testing']['processing'], 'production')
            tr = result['pq_trust']['transparency']
            self.assertEqual(tr['leaf_type'], '402signal.route_decision.v4')
            self.assertEqual(tr['state'], 'checkpoint_signed')
            self.assertEqual(tr['status'], 'pending')
            receipt.verify_route_receipt(tr['receipt'], tr['reveal'], self.vkey)
            # Provenance is committed privately, not added to the public leaf schema.
            self.assertEqual(json.loads(tr['reveal']['evidence']['request_json'])['lab_test'], lab_traffic.PROTOCOL)
            self.assertEqual(store.size(), n+1)
            import sqlite3
            with sqlite3.connect(self.tmp.name + '/history.sqlite') as db:
                self.assertGreater(db.execute('SELECT COUNT(*) FROM probes WHERE settled_route_observation=1').fetchone()[0], 0)

    def test_replay_after_restart_does_not_append_or_promote_twice(self):
        from live402.pq import store, receipt
        win = self.winner()
        with patch('live402.facilitator.verify', return_value=_verified()) as verify, \
             patch('live402.route.run_probe', return_value=(200, win)), \
             patch('live402.facilitator.settle', return_value=_settled()) as settle, \
             patch('live402.history.mark_batch_settled') as mark:
            first = route.handle_route(self.body, _headers(_payload()), 'https://402signal.com/route')
            self.assertEqual(first[0], 200)
            self.assertEqual(store.size(), 1)
            replay.reset_memory()
            again = route.handle_route(self.body, _headers(_payload()), 'https://402signal.com/route')
            self.assertEqual(again, first)
            self.assertEqual(store.size(), 1)
            verify.assert_called_once();settle.assert_called_once();mark.assert_called_once()
            tr=again[1]['pq_trust']['transparency']
            receipt.verify_route_receipt(tr['receipt'], tr['reveal'], self.vkey)

    def test_settled_transparency_failure_retains_billing_and_provenance(self):
        with patch('live402.facilitator.verify', return_value=_verified()), \
             patch('live402.route.run_probe', return_value=(200, self.winner())), \
             patch('live402.facilitator.settle', return_value=_settled()) as settle, \
             patch('live402.history.mark_batch_settled') as mark, \
             patch('live402.pq.receipt.attach_to_route', side_effect=RuntimeError('fixture')):
            code, result, headers = _paid_execute(self.body, _payload(), _routing_accept(),
                'https://402signal.com/route', None, time.monotonic()+100)
            self.assertEqual(code, 503)
            self.assertTrue(result['billing']['settled'])
            self.assertEqual(result['lab_testing']['processing'], 'production')
            self.assertEqual(result['pq_trust']['transparency']['state'], 'unavailable')
            self.assertIn('PAYMENT-RESPONSE', headers)
            settle.assert_called_once();mark.assert_called_once()
