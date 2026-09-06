import test from 'node:test';
import assert from 'node:assert/strict';
import {isUnsettledRouteMiss, withVerifiedRoute} from '../index.mjs';

const body = () => ({live:false, payable:false, invocable:false, selected_payment:null,
  miss_reason:'constraints_unmet', billing:{model:'success_only_v1', condition:'live_eligible_route_found',
    asset:'USDC', amount_atomic:'3000', display_amount:'$0.003', rail:'base',
    settlement_attempted:false, settled:false, settlement_state:'not_attempted'}});
const classify = (b, status=200, header=null) => isUnsettledRouteMiss({
  httpStatus:status, routeResponseJson:JSON.stringify(b), paymentResponseHeader:header});

test('normal misses accept new HTTP 200 and preserved legacy HTTP 503 on all rails', () => {
  for (const rail of ['base','solana','algorand']) for (const status of [200,503]) {
    const b=body(); b.billing.rail=rail; assert.equal(classify(b,status),true);
  }
  const b=body(); b.miss_reason='probe_timeout';
  assert.equal(classify(b,200),false); assert.equal(classify(b,503),true);
});
test('ambiguous, malformed, failed and paid outcomes never classify as normal HTTP success', () => {
  for (const change of [{live:true},{payable:true},{selected_payment:{}},{error:'unavailable'},
    {binding_error:'invalid'}, {evaluation_complete:false}, {candidate_evaluation_complete:false},
    {probe_budget_exhausted:true}, {evaluation_complete:'true'},
    {candidate_evaluation_complete:null}, {probe_budget_exhausted:0},
    {miss_reason:'unknown'}, {miss_reason:[]}])
    assert.equal(classify({...body(),...change}),false);
  for (const change of [{settled:true},{settled:null},{settled:0},{settlement_attempted:true},
    {settlement_state:'unknown'}, {amount_atomic:'3001'},{model:'future'},{condition:'anything'},
    {asset:'ETH'},{display_amount:'$0'},{rail:'unknown'}]) {
    const b=body(); Object.assign(b.billing,change);
    for (const status of [200,503]) assert.equal(classify(b,status),false);
  }
  for (const key of ['live','payable','selected_payment','miss_reason','billing']) {
    const b=body(); delete b[key]; assert.equal(classify(b),false);
  }
  for (const header of ['', 'receipt']) assert.equal(classify(body(),200,header),false);
  assert.equal(isUnsettledRouteMiss({httpStatus:200,routeResponseJson:JSON.stringify(body())}),false);
  for (const raw of ['{', 'null', JSON.stringify(body()).replace('"live":false','"live":true,"live":false')])
    assert.equal(isUnsettledRouteMiss({httpStatus:200,routeResponseJson:raw,paymentResponseHeader:null}),false);
});
test('a normal HTTP success miss never reaches the guarded seller authorization callback', () => {
  let calls=0;
  assert.throws(() => withVerifiedRoute({routeResponseJson:JSON.stringify(body())}, () => calls++));
  assert.equal(calls,0);
});
