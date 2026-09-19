import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setTimeout as nativeSetTimeout} from 'node:timers';
import {verifyReceipt, verifyRoute} from '../index.mjs';
import {reconcilePayment} from '../recovery.mjs';
const vectors=JSON.parse(readFileSync(new URL('../../../tests/fixtures/route-binding-v1.json',import.meta.url)));
const tx='2'.repeat(88);
const confirmed={state:'confirmed',transaction:tx,level:'solana_finalized',buyer_native_fee_atomic:'0'};

test('delayed finalization reuses the same scoped transaction and never resumes spending',async()=>{
  let count=0;
  const out=await reconcilePayment({rail:'solana',transaction:tx,intervalMs:0,
    observe:async request=>{assert.equal(request.transaction,tx);assert.equal(request.rail,'solana');assert.ok(Object.isFrozen(request));return ++count===10?confirmed:{state:'unknown'};}});
  assert.equal(count,10);assert.equal(out.state,'confirmed');assert.equal(out.payment_resubmitted,false);
  assert.equal(out.seller_execution_resumed,false);assert.equal(out.budget_released,false);
});
test('wrong transaction, weak commitment or a buyer fee stays unknown',async()=>{
  for(const change of [{transaction:'3'.repeat(88)},{level:'confirmed'},{buyer_native_fee_atomic:'1'}]) {
    const out=await reconcilePayment({rail:'solana',transaction:tx,observe:async()=>({...confirmed,...change})});
    assert.equal(out.state,'unknown');assert.equal(out.reason,'confirmation_scope_mismatch');assert.equal(out.observations,1);
  }
});
test('hung reads have a deadline and receive cancellation',async()=>{
  let readSignal;
  const out=await reconcilePayment({rail:'solana',transaction:tx,timeoutMs:10,observe:async({signal})=>{readSignal=signal;return new Promise(()=>{});}});
  assert.equal(out.state,'unknown');assert.equal(out.reason,'confirmation_timeout');assert.equal(out.observations,1);assert.ok(readSignal.aborted);
});
test('aborted and invalid requests do not read or invoke a wallet',async()=>{
  const c=new AbortController();c.abort();let calls=0;
  const observe=async()=>{calls++;return confirmed;};
  assert.equal((await reconcilePayment({rail:'solana',transaction:tx,signal:c.signal,observe})).reason,'aborted');
  await assert.rejects(reconcilePayment({rail:'base',transaction:tx,observe}),/existing_payment_required/);
  await assert.rejects(reconcilePayment({rail:'solana',transaction:tx,maxObservations:10000,observe}),/invalid_recovery_options/);
  assert.equal(calls,0);
});
test('read failures are bounded and exception contents are not returned',async()=>{
  const out=await reconcilePayment({rail:'solana',transaction:tx,maxObservations:3,intervalMs:0,observe:async()=>{throw Error('PRIVATE_CANARY');}});
  assert.equal(out.observations,3);assert.equal(out.state,'unknown');assert.ok(!JSON.stringify(out).includes('PRIVATE_CANARY'));
});
test('historical receipt verification grants no current quote or payment authority',()=>{
  for(const sample of vectors.cases) {
    const options={routeResponseJson:JSON.stringify(sample.response),routeRequestJson:JSON.stringify(sample.request),trustedLogVkey:vectors.trusted_vkey};
    const r=verifyReceipt(options);assert.equal(r.proof,'signature_and_inclusion_verified');assert.equal(r.current_quote,'not_checked');assert.equal(r.anchor,'not_checked');assert.ok(!('accepted' in r));
    assert.throws(()=>verifyRoute({...options,now:sample.response.decision_binding.expires_at,request:{url:sample.response.url,method:sample.method,body:Buffer.from(sample.body)},challenge:{status:402,bodyText:JSON.stringify(sample.challenge)}}),/quote_expired/);
    assert.throws(()=>verifyReceipt({...options,routeRequestJson:'{}'}),/request_mismatch/);
    const bad=structuredClone(sample.response);bad.pq_trust.transparency.reveal.salt=(bad.pq_trust.transparency.reveal.salt[0]==='0'?'1':'0')+bad.pq_trust.transparency.reveal.salt.slice(1);
    assert.throws(()=>verifyReceipt({...options,routeResponseJson:JSON.stringify(bad)}));
  }
});

test('a late observer result cannot turn an expired reconciliation into confirmed',async()=>{
  const out=await reconcilePayment({rail:'solana',transaction:tx,timeoutMs:5,observe:()=>{
    const start=performance.now();while(performance.now()-start<12){};return confirmed;
  }});
  assert.equal(out.state,'unknown');assert.equal(out.reason,'confirmation_timeout');
});

for (const settlesOnAbort of [false, true]) {
  test(`a fired deadline is terminal even before the clock boundary (observer resolves on abort: ${settlesOnAbort})`, async t => {
    // Reproduce timer rounding deterministically without depending on host load.
    t.mock.method(globalThis, 'setTimeout', (callback, _delay, ...args) =>
      nativeSetTimeout(callback, 0, ...args));
    let calls = 0, readSignal;
    const out = await reconcilePayment({
      rail: 'solana', transaction: tx, timeoutMs: 60000, intervalMs: 0, maxObservations: 2,
      observe: ({signal}) => {
        calls++; readSignal = signal;
        return new Promise(resolve => {
          if (settlesOnAbort) signal.addEventListener('abort', () => resolve(confirmed), {once: true});
        });
      },
    });
    assert.equal(out.state, 'unknown');
    assert.equal(out.reason, 'confirmation_timeout');
    assert.equal(out.observations, 1); assert.equal(calls, 1);
    assert.ok(readSignal.aborted);
    assert.equal(out.payment_resubmitted, false);
    assert.equal(out.seller_execution_resumed, false);
    assert.equal(out.budget_released, false);
  });
}
