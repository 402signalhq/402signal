"""Real Node seller → Python router/PQ → Node buyer guard → seller execution.

Discovery and facilitators are fixtures. Ed25519 proofs, schemas, SDK guards,
seller HTTP/utility/replay logic are real. External payments are impossible.
"""
import copy
import json
import os
import subprocess
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from live402 import history, payment, replay, route, route_binding as binding
from live402.pq import receipt, store, events
from test_success_only_billing import _verified, _settled, _routing_accept, _payload, _miss, RESOURCE

ROOT=Path(__file__).resolve().parents[2]
LAB=ROOT/'integration/lab'

def node(value):
    p=subprocess.run(['node','tools/contract-driver.mjs'],cwd=LAB,input=json.dumps(value),capture_output=True,text=True,timeout=30)
    if p.returncode:raise AssertionError(p.stderr[-1500:])
    return json.loads(p.stdout)

class ContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not (LAB/'dist/src/seller.js').exists():raise RuntimeError('Build integration/lab before running contract tests')
        cls.cases=node({'mode':'prepare'})

    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.env=patch.dict(os.environ,{'LIVE402_FIXTURE':'1','LOCAL_FREE':'0','LIVE402_LAB_ORIGINS':'https://seller.example',
            'LIVE402_PQ_LOG':'1','LIVE402_PQ_LOG_DB':self.tmp.name+'/pq.sqlite','LIVE402_REPLAY_DB':self.tmp.name+'/replay.sqlite',
            'LIVE402_HISTORY_DB':self.tmp.name+'/history.sqlite','LIVE402_ROUTE_BINDING_TTL_S':'60'})
        self.env.start();self.addCleanup(self.env.stop)
        store.reset();replay.reset();history.reset()
        self.vkey=receipt.configure_signer(Ed25519PrivateKey.generate())
        self.addCleanup(lambda:receipt.configure_signer(None));self.addCleanup(store.reset);self.addCleanup(replay.reset);self.addCleanup(history.reset)

    def issue(self,case,variant=None):
        env=case['challenge']['body'];raw=json.dumps(env).encode()
        observed=binding.observed_challenge(402,{},raw)
        accept=env['accepts'][0];option=payment.validate_observed_accept(accept,env);self.assertIsNotNone(option)
        url=env['resource']['url'];now=int(time.time())
        win={'url':url,'live':True,'payable':True,'invocable':True,'status':402,'payTo':accept['payTo'],'envelope':observed,
            'selected_payment':payment.selected_payment_fields(option),'batch_id':'contract-'+case['rail']+'-'+case['name'],
            'probed_at':events.jcs.utc_seconds_z(now),'observed':{'payable':None,'invocable':None},
            'binding_observation':{'request':binding.request_context(url,'GET',b''),'observed_at':now,'quote_sha256':binding.digest(observed)}}
        if variant=='expired_before_settle':win['binding_observation']['observed_at']=now-120
        if variant=='explicit_false':win['observed']['payable']=False
        body={'url':url,'need':'operator self-test '+case['name'],'networks':[case['rail']],'max_price_usd':0.001,
            'lab_test':'402signal-lab-route-v2','require_route_binding':True,'require_transparency':True}
        if variant=='free_miss':win=_miss('constraints_unmet')
        settled=_settled();settled.body.pop('payer',None);settled.body['network']=_routing_accept(case['rail'])['network']
        settled.body['transaction']={'base':'0x'+'ab'*32,'solana':'2'*88,'algorand':'A'*52}[case['rail']]
        with patch('live402.facilitator.verify',return_value=_verified()),patch('live402.route.run_probe',return_value=(503 if variant=='free_miss' else 200,win)),patch('live402.facilitator.settle',return_value=settled) as settle:
            fp = 'synthetic-contract-' + uuid.uuid4().hex
            self.assertEqual(replay.begin(fp, scope='private-contract', reserve=False)[0], 'run')
            code,result,extra=route._paid_execute(body,_payload(),_routing_accept(case['rail']),RESOURCE,None,time.monotonic()+60,fp)
            replay.finish(fp, (code,result,extra), cache=code != 400)
        return code,result,body,settle.call_count

    def test_nine_real_seller_challenges_route_through_signed_proof_and_guard_to_delivery(self):
        for case in self.cases:
            with self.subTest(rail=case['rail'],utility=case['name']):
                code,result,body,settles=self.issue(case)
                self.assertEqual(code,200);self.assertEqual(settles,1)
                out=node({'mode':'verify','case':case,'response':result,'request':body,'vkey':self.vkey})
                self.assertEqual(out['delivery'],'validated');self.assertEqual(out['callbacks'],1)
                self.assertEqual(out['seller_settlements'],1);self.assertEqual(out['replay'],'same_result')
        self.assertEqual(store.size(),9)

    def test_stale_and_altered_quotes_block_seller_but_keep_historical_receipt_verifiable(self):
        for rail in ('base','solana','algorand'):
            case=next(c for c in self.cases if c['rail']==rail)
            code,result,body,_=self.issue(case);self.assertEqual(code,200)
            for variant in ('expired','different_method','unsupported_schema'):
                out=node({'mode':'verify','case':case,'response':result,'request':body,'vkey':self.vkey,'variant':variant})
                self.assertEqual(out['guard'],'rejected');self.assertEqual(out['callbacks'],0);self.assertEqual(out['seller_settlements'],0)
                self.assertEqual(out['proof'],'signature_and_inclusion_verified')

    def test_expired_observation_false_evidence_and_free_misses_never_settle_or_append(self):
        for case in self.cases:
            for variant in ('expired_before_settle','explicit_false','free_miss'):
                code,result,_,settles=self.issue(case,variant)
                self.assertEqual(code,200 if variant=="free_miss" else 503);self.assertEqual(settles,0)
                self.assertFalse(result['billing']['settled']);self.assertNotIn('pq_trust',result)
        self.assertEqual(store.size(),0)

if __name__=='__main__':unittest.main()
