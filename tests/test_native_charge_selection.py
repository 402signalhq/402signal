"""Synthetic native multi-offer selection and independent pre-settlement gates."""
import base64
import copy
import json
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch
from live402 import batch_binding as bb, route_binding as rb, route, replay
from live402.batch_profiles import native_charge
import tests.test_batch_binding as batch_helpers
from tests.test_batch_binding import vector
from test_success_only_billing import RESOURCE, _headers, _payload, _verified, _settled

ROOT = Path(__file__).resolve().parents[1]
BASE = json.loads((ROOT / 'tests/fixtures/base-native-mpp-v5.json').read_text())

def header(item, **changes):
    p = {**item['params'], **changes}
    return 'Payment ' + ', '.join(k + '=' + json.dumps(v) for k, v in p.items())

def mixed(v):
    v = copy.deepcopy(v)
    original = native_charge.challenges(v['challenge']['wwwAuthenticate'])[0]
    other = copy.deepcopy(original['request'])
    if original['params']['method'] == 'evm':
        other['methodDetails']['chainId'] = 42220
    else:
        other['amount'] = '1001'
    token = base64.urlsafe_b64encode(rb.canonical(other)).decode().rstrip('=')
    alt = header(original, id='other-chain-or-price', request=token)
    tempo = header(original, id='tempo', method='tempo', description='comma, and "quoted" text')
    chosen = header(original, description='original, chosen')
    v['challenge']['wwwAuthenticate'] = ', '.join([tempo, alt, chosen, header(original, id='other-realm', realm='other.example')])
    v['challenge']['bodyText'] = '{"altPayment":{"type":"proof-of-work","difficulty":4}}'
    v['challenge']['paymentRequired'] = 'eyJ4NDAyVmVyc2lvbiI6Mn0='
    v['observation']['challenge'] = v['challenge']
    return v

class NativeSelectionTests(unittest.TestCase):
    def setUp(self):
        self.helper = batch_helpers.BatchTests()
        self.helper.setUp()
        self.addCleanup(self.helper.doCleanups)

    def test_exact_selection_preserves_full_channels_and_old_single_receipt(self):
        bb.verify_route(BASE['response'], BASE['request'], vkey=BASE['trusted_vkey'], challenge=BASE['challenge'], now=BASE['now'])
        v = mixed(BASE)
        binding = bb.build(v['request'], v['observation'])
        self.assertEqual(binding['challenge'], v['challenge'])
        self.assertEqual(binding['terms'], BASE['response']['batch_terms'])
        item = native_charge.select(v['challenge'], v['observation']['request'], 'evm', 'merchant.example', lambda e: bb.PROFILES['base-mpp-charge-v1'](e, v['observation']['request'], v['request']['buyer_limits']))
        self.assertEqual(item['params']['id'], 'base-native-synthetic')
        self.assertEqual(item['index'], 2)

    def test_ambiguous_matches_refuse_in_either_order_and_before_settle(self):
        v = mixed(vector(4))
        result = self.helper.result(v)
        item = native_charge.challenges(v['challenge']['wwwAuthenticate'])[2]
        duplicate = header(item, id='another-qualified-identity')
        original = v['challenge']['wwwAuthenticate']
        for raw in [original + ', ' + duplicate, duplicate + ', ' + original]:
            v['challenge']['wwwAuthenticate'] = raw
            with self.assertRaises(ValueError):
                bb.build(v['request'], v['observation'])
            replay.reset()
            with patch('live402.route.run_probe', return_value=(200, result)), patch('live402.facilitator.verify', return_value=_verified()), patch('live402.facilitator.settle') as settle:
                out = route.handle_route(v['request'], _headers(_payload()), RESOURCE)
                self.assertFalse(out[1]['billing']['settled'])
                settle.assert_not_called()

    def test_quote_aware_grammar_duplicates_and_bounds(self):
        raw = mixed(BASE)['challenge']['wwwAuthenticate']
        self.assertEqual(native_charge.challenges(raw)[0]['params']['description'], 'comma, and "quoted" text')
        single = BASE['challenge']['wwwAuthenticate']
        self.assertEqual(len(native_charge.challenges(', '.join([single] * 16))), 16)
        for bad in [single + ', id="duplicate"', single + ', ID="duplicate"', raw + ',', raw + ', Basic realm="x"', raw.replace('Payment ', 'Payment  ,', 1), ', '.join([single] * 17)]:
            with self.subTest(raw=bad[:40]), self.assertRaises(ValueError):
                native_charge.challenges(bad)

    def test_python_and_javascript_signed_proof_agree_and_bind_every_channel(self):
        algo = json.loads((ROOT / 'tests/fixtures/algorand-mpp-charge.json').read_text())[0]
        algo['observation'] = {'request': rb.request_context(algo['request']['url'], 'GET'), 'observed_at': algo['now'], 'challenge': algo['challenge']}
        for original in [BASE, algo]:
            v = mixed(original)
            out = self.helper.issue(v)
            now = v['now']
            bb.verify_route(out, v['request'], vkey=self.helper.vkey, challenge=v['challenge'], now=now)
            payload = {'routeRequestJson': json.dumps(v['request']), 'routeResponseJson': json.dumps(out), 'challenge': v['challenge'], 'trustedLogVkey': self.helper.vkey, 'now': now}
            script = """import {verifyBatchRoute} from './sdk/route-guard/batch.mjs';
import fs from 'node:fs'; import assert from 'node:assert/strict';
const p=JSON.parse(fs.readFileSync(0,'utf8')); verifyBatchRoute(p);
for(const k of ['bodyText','paymentRequired','wwwAuthenticate']) {
 const q=structuredClone(p);q.challenge[k]+=' ';assert.throws(()=>verifyBatchRoute(q));
}
process.stdout.write('verified and three raw mutations refused');"""
            run = subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT, input=json.dumps(payload), text=True, capture_output=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            for key in ['bodyText', 'paymentRequired', 'wwwAuthenticate']:
                c = {**v['challenge'], key: v['challenge'][key] + ' '}
                with self.assertRaises(ValueError):
                    bb.verify_route(out, v['request'], vkey=self.helper.vkey, challenge=c, now=now)

    def test_python_javascript_parser_reject_the_same_malformed_headers(self):
        single = BASE['challenge']['wwwAuthenticate']
        cases = [mixed(BASE)['challenge']['wwwAuthenticate'],
                 ', '.join([single] * 16),
                 single + ', id="again"', single + ', ID="again"',
                 single + ',', single + ', Basic realm="x"',
                 single.replace('17:01:00.000Z', '25:01:00.000Z'),
                 single.replace('2026-09-08', '2026-02-30'),
                 ', '.join([single] * 17)]
        expected = []
        for raw in cases:
            try:
                items = native_charge.challenges(raw)
                expected.append([{'params': item['params'], 'raw': item['raw'], 'expiry': item['expiry']} for item in items])
            except ValueError:
                expected.append(None)
        script = """import fs from 'node:fs';import {nativeChargeChallenges} from './sdk/route-guard/batch-profiles/native-charge.mjs';
const cases=JSON.parse(fs.readFileSync(0,'utf8'));
console.log(JSON.stringify(cases.map(raw=>{try{return nativeChargeChallenges(raw).map(({params,raw,expiry})=>({params,raw,expiry}));}catch{return null;}})));"""
        out = subprocess.run(['node','--input-type=module','-e',script],cwd=ROOT,input=json.dumps(cases),text=True,capture_output=True)
        self.assertEqual(out.returncode,0,out.stderr)
        self.assertEqual(json.loads(out.stdout),expected)

    def test_qualifying_multi_offer_settles_one_router_fee_and_recovers_original_response(self):
        v = mixed(vector(4))
        result = self.helper.result(v)
        with patch('live402.route.run_probe', return_value=(200, result)), patch('live402.facilitator.verify', return_value=_verified()) as verify, patch('live402.facilitator.settle', return_value=_settled()) as settle:
            out = route.handle_route(v['request'], _headers(_payload()), RESOURCE)
            self.assertEqual(out[0], 200, out)
            self.assertTrue(out[1]['billing']['settled'])
            self.assertEqual(out[1]['billing']['amount_atomic'], '3000')
            self.assertEqual(out[1]['batch_binding']['challenge'], v['challenge'])
            replay.reset_memory()
            self.assertEqual(route.handle_route(v['request'], _headers(_payload()), RESOURCE), out)
            self.assertEqual((verify.call_count, settle.call_count), (1, 1))
