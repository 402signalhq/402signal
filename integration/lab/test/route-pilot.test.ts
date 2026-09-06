import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Address} from '@algorandfoundation/algokit-utils';
import {Transaction,TransactionType,groupTransactions,encodeSignedTransaction} from '@algorandfoundation/algokit-utils/transact';
import {address,getBase58Decoder,createTransactionMessage,setTransactionMessageFeePayer,compileTransaction,getTransactionEncoder} from '@solana/kit';
import {RAILS,railInfo,type Rail} from '../src/config.js';
import {type BuyerConfig,type Signer,validateBuyer} from '../src/buyer.js';
import {RoutePilot,recheckRoute,ROUTE_PROTOCOL,inspectRoute} from '../src/route-pilot.js';
import {Ledger} from '../src/ledger.js';
import {encode64,canonical,digest} from '../src/json.js';
import {utility,example} from '../src/utilities.js';
import {ALGO_GENESIS} from '../src/mainnet-policy.js';
import type {Transport} from '../src/transport.js';
const sol=(n:number)=>getBase58Decoder().decode(new Uint8Array(32).fill(n));
const algo=(n:number)=>new Address(new Uint8Array(32).fill(n)).toString();
const buyers={base:'0x'+'22'.repeat(20),solana:sol(2),algorand:algo(2)};
const sellers={base:'0x'+'33'.repeat(20),solana:sol(3),algorand:algo(3)};
const routers={base:'0x'+'44'.repeat(20),solana:sol(4),algorand:algo(4)};
function config():BuyerConfig {return {mode:'mainnet',routerUrl:'https://402signal.com/route',sellerOrigin:'https://seller.example',ledgerPath:':memory:',
 sellerMaxAtomic:'1000',sellerPayTo:sellers,routerPayTo:routers,feePayers:{base:[],solana:[sol(5)],algorand:[algo(5)]},
 capAtomicPerRail:{base:'20000',solana:'20000',algorand:'20000'},
 mainnet:{workflow:'seller_only',buyerNativeFeeAtomic:'0',buyerAddresses:buyers,rpcUrls:{base:'https://base.example',solana:'https://sol.example',algorand:'https://algo.example'}},
 routePilot:{protocol:ROUTE_PROTOCOL,routerFeePayers:{base:[],solana:[sol(6)],algorand:[algo(6)]}}};}
const classification={protocol:ROUTE_PROTOCOL,traffic_class:'self_test',organic_demand:false,processing:'production'};
function fixture(c:BuyerConfig,rail:Rail,scenario='success') {
 let routerPosts=0,sellerPosts=0,signatures=0,network=0;const info=railInfo(rail,'mainnet');
 const req=(router:boolean)=>({scheme:'exact',network:info.network,asset:info.asset,amount:router?'3000':'1000',payTo:(router?routers:sellers)[rail],maxTimeoutSeconds:60,
   extra:rail==='base'?{name:'USD Coin',version:'2'}:{feePayer:(router?c.routePilot!.routerFeePayers:c.feePayers)[rail][0]}});
 const sign:Signer=async(_rail,ch)=>{
  signatures++;const r=ch.accepts[0]!;let payload:any={authorization:{nonce:'0x'+String(signatures).padStart(64,'0')},signature:'PRIVATE_CANARY'};
  if(rail==='solana')payload={transaction:Buffer.from(getTransactionEncoder().encode(compileTransaction(setTransactionMessageFeePayer(address(sol(5)),createTransactionMessage({version:0}))))).toString('base64')};
  if(rail==='algorand'){
   const common={genesisHash:Buffer.from(ALGO_GENESIS,'base64'),firstValid:1n,lastValid:100n};
   const tx=groupTransactions([new Transaction({...common,type:TransactionType.Payment,sender:Address.fromString(algo(5)),fee:2000n,payment:{receiver:Address.fromString(algo(5)),amount:0n}}),
     new Transaction({...common,type:TransactionType.AssetTransfer,sender:Address.fromString(buyers.algorand),fee:0n,assetTransfer:{receiver:Address.fromString(r.payTo),assetId:31566704n,amount:BigInt(r.amount)}})]);
   payload={paymentGroup:['fixture',Buffer.from(encodeSignedTransaction({txn:tx[1]!,sig:new Uint8Array(64).fill(1)})).toString('base64')]};
  }
  return {x402Version:2,accepted:r,payload};
 };
 const send:Transport=async(url,_method,body:any,h)=>{
  network++;const router=url===c.routerUrl; if(!router){assert.equal(_method,'GET');assert.equal(body,undefined);}
  if(!h?.['PAYMENT-SIGNATURE']){
   let r=req(router);if(!router&&scenario==='quote_changed')r={...r,amount:'999'};
   const ch:any={x402Version:2,resource:{url},accepts:[r]};
   if(router){ch.lab_testing={...classification,origins:[c.sellerOrigin]};
    ch.billing={model:'success_only_v1',amount_atomic:'3000',asset:'USDC',typed_misses_settled:false,seller_payment_separate:true};
    if(scenario==='old_router')ch.lab_testing={...classification,protocol:'402signal-lab-route-v1',history_promoted:false,pq_recorded:false};
   }
   return {status:402,headers:new Headers({'PAYMENT-REQUIRED':encode64(ch)}),body:ch};
  }
  if(router)routerPosts++;else sellerPosts++;
  if(scenario===(router?'router_lost':'seller_lost'))throw Error('PRIVATE_CANARY');
  const tx=rail==='base'?'0x'+'ab'.repeat(32):rail==='solana'?'2'.repeat(88):'A'.repeat(52);
  const headers=new Headers({'PAYMENT-RESPONSE':encode64({success:true,transaction:tx,network:info.network,amount:req(router).amount,payload:'PRIVATE_CANARY'})});
  if(!router)return {status:200,headers,body:{result:utility('payload/sha256',example('payload/sha256'))}};
  assert.equal(body.lab_test,ROUTE_PROTOCOL);
  assert.equal(body.require_transparency,true);assert.equal(body.require_route_binding,true);
  const result:any={pq_trust:{transparency:{status:'pending',state:'checkpoint_signed',receipt:{checkpoint:'fixture note',index:0,inclusion_path:[]},reveal:{event_version:'402signal.route_decision.v4'}}},url:body.url,live:true,payable:true,status:402,lab_testing:classification,
   selected_payment:{rail,network:info.network,asset:info.asset,payTo:sellers[rail],amount_atomic:1000},
   billing:{model:'success_only_v1',condition:'live_eligible_route_found',display_amount:'$0.003',amount_atomic:'3000',asset:'USDC',rail,settled:true,settlement_attempted:true,settlement_state:'settled'}};
  let status=200;
  if(['free_miss','legacy_free_miss','malformed_free_miss','unknown_200','receipt_miss'].includes(scenario)){status=scenario==='legacy_free_miss'?503:200;result.live=false;result.payable=false;result.invocable=false;result.selected_payment=null;result.miss_reason='constraints_unmet';result.billing={...result.billing,settled:false,settlement_attempted:false,settlement_state:'not_attempted'};headers.delete('PAYMENT-RESPONSE');delete result.pq_trust;}
  if(scenario==='malformed_free_miss')result.payable=true;
  if(scenario==='unknown_200')result.billing.settlement_state='unknown';
  if(scenario==='receipt_miss')headers.set('PAYMENT-RESPONSE',encode64({success:true,transaction:tx,network:info.network,amount:'3000'}));
  if(scenario==='wrong_selected')result.selected_payment.payTo=buyers[rail];
  if(scenario==='missing_classification')delete result.lab_testing;
  if(scenario==='settled_503'){status=503;result.live=false;result.pq_trust={transparency:{status:'unavailable',state:'unavailable'}};}
  if(scenario==='missing_pq')delete result.pq_trust;
  return {status,headers,body:result};
 };
 return {sign,send,verifyBinding:(o:any)=>{assert.equal(o.request.method,'GET');return {accepted:req(false)};},counts:()=>({routerPosts,sellerPosts,signatures,network})};
}
for(const rail of RAILS){
 test(`${rail}: mainnet routing keeps separate intents, confirmations, and classification`,async()=>{
  const c=config(),l=new Ledger(':memory:'),f=fixture(c,rail);const observed:string[]=[];
  try {const r=await new RoutePilot(c,l,f.sign,f.sign,async(i)=>{observed.push(i.amount);return {state:'confirmed'};},f.send,f.verifyBinding).run('full',rail,'payload/sha256');
   assert.equal(r.delivery,'validated');assert.equal(r.router.state,'confirmed');assert.equal(r.seller.state,'confirmed');assert.equal(r.pq_evidence,'signature_and_inclusion_verified');
   assert.equal(r.pq_trust?.transparency.state,'checkpoint_signed');assert.equal(r.pq_trust?.transparency.status,'pending');
   assert.equal(r.proof_status?.receipt,'signature_and_inclusion_verified');assert.equal(r.proof_status?.anchor,'not_checked');
   assert(r.timings_ms && ['router_signing','router_confirmation','seller_confirmation','proof_and_quote_verification','total'].every(k=>Number.isFinite(r.timings_ms![k]) && r.timings_ms![k]!>=0));
   assert.deepEqual(observed,['3000','1000']);assert.equal(l.getIntent('full:router').intent.payTo,routers[rail]);assert.equal(l.getIntent('full:seller').intent.payTo,sellers[rail]);
   assert.deepEqual(f.counts(),{routerPosts:1,sellerPosts:1,signatures:2,network:4});
   for(const table of ['route_runs','intents'])assert(!JSON.stringify(l.db.prepare('SELECT * FROM '+table).all()).includes('PRIVATE_CANARY'));
  }finally{l.close();}
 });
 for(const scenario of ['old_router','free_miss','legacy_free_miss','malformed_free_miss','unknown_200','receipt_miss','wrong_selected','quote_changed','missing_classification','missing_pq','settled_503','router_lost','seller_lost']){
  test(`${rail}: ${scenario} stops correctly without retry`,async()=>{
   const c=config(),l=new Ledger(':memory:'),f=fixture(c,rail,scenario);
   try {const b=new RoutePilot(c,l,f.sign,f.sign,async()=>({state:'confirmed'}),f.send,f.verifyBinding);const r=await b.run('stop',rail,'payload/sha256');
    assert.equal(f.counts().sellerPosts,scenario==='seller_lost'?1:0);
    if(scenario==='old_router'){assert.equal(f.counts().signatures,0);assert.equal(r.stopped_because,'router_production_processing_not_deployed');}
    if(scenario==='settled_503'){assert.equal(r.router.state,'confirmed');assert.equal(r.pq_evidence,'unavailable');}
    if(scenario==='free_miss'||scenario==='legacy_free_miss'){assert.equal(r.route_status,scenario==='free_miss'?200:503);assert.equal(f.counts().signatures,1);assert.equal(r.pq_evidence,'not_checked');assert.equal(r.router.state,'not_settled');assert.equal(r.stopped_because,undefined);}else assert(r.stopped_because);
    const count=f.counts();await assert.rejects(b.run('stop',rail,'payload/sha256'),/reserved/);assert.deepEqual(f.counts(),count);
   }finally{l.close();}
  });
 }
 test(`${rail}: unknown router across restart reconciles without paying seller`,async()=>{
  const root=mkdtempSync(join(tmpdir(),'route-test-')),path=join(root,'ledger.sqlite'),c=config();let l=new Ledger(path);const f=fixture(c,rail);
  try {const r=await new RoutePilot(c,l,f.sign,f.sign,async()=>({state:'unknown'}),f.send,f.verifyBinding).run('unknown',rail,'payload/sha256');
   assert.equal(r.router.state,'receipt_observed');assert.equal(f.counts().sellerPosts,0);l.close();l=new Ledger(path);
   await assert.rejects(new RoutePilot(c,l,f.sign,f.sign,async()=>({state:'confirmed'}),f.send,f.verifyBinding).run('another',rail,'payload/sha256'),/unresolved/);
   const out=await recheckRoute(c,l,'unknown',async()=>({state:'confirmed'}));assert.equal(out.resolved,true);assert.equal(out.payment_resubmitted,false);
   assert.equal(out.workflow_complete,false);assert.equal(out.recovery.payments_reconciled,true);
   assert.equal(out.proof_status?.receipt,'verification_failed');
   assert.equal(out.seller_execution_resumed,false);assert.equal(out.budget_released,false);assert.equal(f.counts().routerPosts,1);assert.equal(f.counts().sellerPosts,0);
  }finally{l.close();rmSync(root,{recursive:true});}
 });
}
test('legacy budget survives upgrade, concurrent reservation, and route policy changes',async()=>{
 const c=config(),l=new Ledger(':memory:'),f=fixture(c,'base');
 try {l.bindCampaign(digest(canonical({mode:c.mode,policy:c.mainnet,origin:c.sellerOrigin,recipients:c.sellerPayTo,feePayers:c.feePayers})));
  l.reserveSpend('old','base','1000','1000',true);l.spendState('old','complete');c.capAtomicPerRail.base='4000';
  const b=new RoutePilot(c,l,f.sign,f.sign,async()=>({state:'confirmed'}),f.send,f.verifyBinding);
  await assert.rejects(b.run('over','base','payload/sha256'),/cap/);assert.equal(f.counts().network,0);
  c.capAtomicPerRail.base='5000';const outcomes=await Promise.allSettled([b.run('a','base','payload/sha256'),b.run('b','base','payload/sha256')]);
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);assert.equal(f.counts().routerPosts,1);assert.equal((l.db.prepare('SELECT sum(amount) n FROM spend').get() as any).n,5000);
  const altered=structuredClone(c);altered.routerPayTo.base=buyers.base;
  await assert.rejects(new RoutePilot(altered,l,f.sign,f.sign,async()=>({state:'confirmed'}),f.send,f.verifyBinding).run('changed','base','payload/sha256'),/route_policy_changed/);
 }finally{l.close();}
});
test('receipt disk failure leaves router unresolved and prevents seller signing',async()=>{
 const c=config(),l=new Ledger(':memory:'),f=fixture(c,'base');
 try {l.recordReceipt=()=>{throw Error('disk');};const r=await new RoutePilot(c,l,f.sign,f.sign,async()=>({state:'confirmed'}),f.send,f.verifyBinding).run('disk','base','payload/sha256');
  assert(r.stopped_because);assert.equal(f.counts().signatures,1);assert.equal(f.counts().sellerPosts,0);
  await assert.rejects(new RoutePilot(c,l,f.sign,f.sign,async()=>({state:'confirmed'}),f.send,f.verifyBinding).run('new','base','payload/sha256'),/unresolved/);
 }finally{l.close();}
});
test('unpaid inspect checks production processing without signatures',async()=>{
 const c=config(),f=fixture(c,'base');const r=await inspectRoute(c,'base','payload/sha256',f.send);
 assert.equal(r.signs_or_sends_payments,false);assert.equal(f.counts().signatures,0);
 assert.equal(validateBuyer(c).routerUrl,'https://402signal.com/route');
 assert.throws(()=>validateBuyer({...c,routePilot:undefined}),/production_router/);
});
test('price-miss scenario sends zero seller price bound and never executes a billed winner',async()=>{
 for(const behavior of ['free_miss','success']) {
  const c=config(),l=new Ledger(':memory:'),f=fixture(c,'base',behavior);let bound:any;
  try {const r=await new RoutePilot(c,l,f.sign,f.sign,async()=>({state:'confirmed'}),async(u,m,b:any,h)=>{if(u===c.routerUrl)bound=b.max_price_usd;return f.send(u,m,b,h);}).run('miss','base','payload/sha256','price_miss');
   assert.equal(bound,0);assert.equal(f.counts().sellerPosts,0);
   if(behavior==='success')assert.equal(r.stopped_because,'expected_free_miss_was_billed');else assert.equal(r.router.state,'not_settled');
  }finally{l.close();}
 }
});
test('intent or phase disk failure before submit never sends payment',async()=>{
 for(const method of ['recordIntent','saveRoute'] as const) {
  const c=config(),l=new Ledger(':memory:'),f=fixture(c,'base');
  try {l[method]=()=>{throw Error('storage canary');};const r=await new RoutePilot(c,l,f.sign,f.sign,async()=>({state:'confirmed'}),f.send,f.verifyBinding).run('blocked','base','payload/sha256');
   assert(r.stopped_because);assert.equal(f.counts().routerPosts,0);assert.equal(f.counts().sellerPosts,0);
  }finally{l.close();}
 }
});

test('failed proof verification blocks seller signing and submission',async()=>{
 const c=config(),l=new Ledger(':memory:'),f=fixture(c,'base');
 try {
  const r=await new RoutePilot(c,l,f.sign,f.sign,async()=>({state:'confirmed'}),f.send,
    ()=>{throw Error('invalid proof');}).run('bad-proof','base','payload/sha256');
  assert.equal(r.router.state,'confirmed');
  assert.equal(r.seller.state,'not_attempted');
  assert.equal(f.counts().signatures,1);
  assert.equal(f.counts().sellerPosts,0);
  assert(r.stopped_because);
 } finally {l.close();}
});
