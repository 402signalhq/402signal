#!/usr/bin/env node
/** Execute the installed, compiled example with synthetic proofs and no network. */
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';

const [compiledExample,installedPackage]=process.argv.slice(2);
assert.ok(compiledExample&&installedPackage,'pass compiled example and installed package paths');
const {runSearch}=await import(pathToFileURL(resolve(compiledExample)).href);
const {RouteClient}=await import(pathToFileURL(join(resolve(installedPackage),'client.mjs')).href);
const {FileAttemptStore}=await import(pathToFileURL(join(resolve(installedPackage),'file-store.mjs')).href);
const f=JSON.parse(await readFile(new URL('../sdk/route-guard/test/support/search-example-fixture.json',import.meta.url),'utf8'));
assert.equal(f.synthetic_test_proof,true);assert.equal(f.no_wallet_payment,true);
const UNAVAILABLE={error:'recovery_unavailable',recovery_only:true,new_payment_allowed:false};
let passed=0;

async function scenario(name,options,check){
 const dir=await mkdtemp(join(tmpdir(),'signal-example-'));
 const oldFetch=globalThis.fetch,oldNow=Date.now;
 const counts={reserve:0,sign:0,confirm:0,sellerFetch:0,sellerExecute:0,ordinary:0,recovery:0};
 const requests=[];let intent;
 try{
  Date.now=()=>f.now*1000;
  const store=new FileAttemptStore(join(dir,'attempts'));
  const routeResponse=structuredClone(f.response);
  if(options.invalidProof)routeResponse.pq_trust.transparency.receipt.leaf_hash='00'.repeat(32);
  if(options.unresolved)Object.assign(routeResponse.billing,{settlement_state:'unknown',settled:false});
  const fetchRouter=async(url,init)=>{
   assert.equal(url,'https://402signal.example/route');assert.equal(init.method,'POST');
   assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
   if(init.body==='{}'&&init.headers['Replay-Only']==='1')return new Response(JSON.stringify(UNAVAILABLE),{status:503});
   assert.deepEqual(JSON.parse(init.body),f.request,'exact documented route request');
   intent=await store.get('search-one','intent');assert.ok(intent);assert.equal(init.headers['Replay-Key'],intent.replayKey);
   const authorization=init.headers['PAYMENT-SIGNATURE'];
   if(!authorization)return new Response(JSON.stringify({x402Version:2,accepts:[{scheme:'exact',network:'eip155:8453',asset:f.challenge.accepts[0].asset,payTo:'0x'+'22'.repeat(20),amount:'3000'}]}),{status:402});
   assert.ok(await store.get('search-one','submission'),'journal claims before paid submission');
   assert.equal(authorization,'synthetic-routing-authorization-no-signature');
   requests.push({body:init.body,replayKey:init.headers['Replay-Key'],authorization,recovery:init.headers['Replay-Only']==='1'});
   if(init.headers['Replay-Only']==='1')counts.recovery++;
   else{counts.ordinary++;if(options.routingAmbiguous)throw Error('synthetic_lost_response');}
   return new Response(JSON.stringify(routeResponse),{status:options.unresolved?503:200,headers:{'PAYMENT-RESPONSE':'synthetic-router-receipt'}});
  };
  const client=new RouteClient({store,routerUrl:'https://402signal.example/route',recoveryProfile:'http-route-v1',fetch:fetchRouter,now:()=>f.now*1000,timeoutMs:100});
  globalThis.fetch=async(url,init)=>{
   counts.sellerFetch++;assert.equal(counts.confirm,1);assert.equal(url,f.url);
   assert.equal(init.method,'GET');assert.equal(init.body,undefined);assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
   assert.equal(init.headers,undefined,'unpaid seller GET has no payment or private replay header');
   const challenge=structuredClone(f.challenge);if(options.changedQuote)challenge.accepts[0].amount='2000';
   const body=JSON.stringify(challenge);
   return new Response(body,{status:402,headers:{'PAYMENT-REQUIRED':Buffer.from(body).toString('base64')}});
  };
  const buyer={
   async reserve(id,prices){counts.reserve++;assert.equal(id,'search-one');assert.ok(await store.get(id,'intent'));assert.deepEqual(prices,{routerAtomic:'3000',sellerMaximumAtomic:'1000',asset:'USDC',network:'eip155:8453'});},
   async signRouting(id,challenge){counts.sign++;assert.equal(counts.reserve,1);const acc=JSON.parse(challenge.bodyText).accepts[0];assert.equal(acc.amount,'3000');assert.equal(acc.network,'eip155:8453');assert.equal(acc.asset,f.challenge.accepts[0].asset);assert.equal(acc.payTo,'0x'+'22'.repeat(20));return 'synthetic-routing-authorization-no-signature';},
   async confirmRouting(id,outcome){counts.confirm++;assert.equal(counts.ordinary,1);assert.equal(outcome.classification.settlementReport,'settled');return options.confirm!==false;},
   async executeSellerOnce(id,action,challenge){counts.sellerExecute++;assert.equal(counts.confirm,1);assert.equal(action.request.url,f.url);assert.equal(action.request.method,'GET');assert.equal(action.accepted.amount,'1000');assert.equal(action.accepted.network,'eip155:8453');assert.equal(action.accepted.asset,f.challenge.accepts[0].asset);assert.equal(action.accepted.payTo,'0x'+'11'.repeat(20));assert.ok(Object.isFrozen(action));assert.equal(challenge.status,402);if(options.sellerAmbiguous)throw Error('synthetic_seller_result_unknown');return {synthetic:true,results:[{title:'Synthetic search result',url:'https://example.com/'}]};},
  };
  const run=()=>runSearch({id:'search-one',query:f.query,client,buyer,trustedLogVkey:f.trusted_vkey});
  await check({run,counts,requests,client,store,restart:()=>new RouteClient({store:new FileAttemptStore(join(dir,'attempts')),routerUrl:'https://402signal.example/route',recoveryProfile:'http-route-v1',fetch:fetchRouter,now:()=>f.now*1000,timeoutMs:100})});
  passed++;console.error('PASS '+name);
 }finally{globalThis.fetch=oldFetch;Date.now=oldNow;await rm(dir,{recursive:true,force:true});}
}

await scenario('exact external GET example completes only after confirmation and verified proof',{},async({run,counts,store})=>{
 const out=await run();assert.equal(out.state,'buyer_executor_returned');assert.equal(out.sellerResult.synthetic,true);
 assert.deepEqual(counts,{reserve:1,sign:1,confirm:1,sellerFetch:1,sellerExecute:1,ordinary:1,recovery:0});
 assert.ok(await store.get('search-one','response-original'));
});
await scenario('independent confirmation absent blocks seller challenge and executor',{confirm:false},async({run,counts})=>{
 const out=await run();assert.equal(out.state,'routing_confirmation_unknown');assert.equal(counts.sellerFetch,0);assert.equal(counts.sellerExecute,0);assert.equal(counts.sign,1);
});
await scenario('invalid signed route proof never invokes seller executor',{invalidProof:true},async({run,counts})=>{
 await assert.rejects(run());assert.equal(counts.confirm,1);assert.equal(counts.sellerFetch,1);assert.equal(counts.sellerExecute,0);assert.equal(counts.sign,1);
});
await scenario('changed seller quote never invokes seller executor',{changedQuote:true},async({run,counts})=>{
 await assert.rejects(run(),e=>e.code==='quote_changed');assert.equal(counts.sellerExecute,0);assert.equal(counts.sign,1);
});
await scenario('unresolved routing stops without confirmation or seller activity',{unresolved:true},async({run,counts})=>{
 const out=await run();assert.equal(out.state,'routing_unresolved_or_unpaid');assert.equal(counts.confirm,0);assert.equal(counts.sellerFetch,0);assert.equal(counts.sellerExecute,0);assert.equal(counts.sign,1);
});
await scenario('lost route response recovers exact authorization across restart without re-sign',{routingAmbiguous:true},async({run,counts,requests,restart})=>{
 const out=await run();assert.equal(out.state,'buyer_executor_returned');assert.equal(out.outcome.recoveryOnly,true);assert.equal(counts.ordinary,1);assert.equal(counts.recovery,1);assert.equal(counts.sign,1);assert.equal(counts.sellerExecute,1);
 const recovered=await restart().recover('search-one');assert.equal(recovered.recoveryOnly,true);assert.equal(counts.ordinary,1);assert.equal(counts.recovery,2);assert.equal(counts.sign,1);assert.equal(counts.sellerExecute,1);
 assert.equal(new Set(requests.map(x=>x.body)).size,1);assert.equal(new Set(requests.map(x=>x.authorization)).size,1);assert.equal(new Set(requests.map(x=>x.replayKey)).size,1);
 await assert.rejects(run(),e=>e.code==='attempt_already_exists');assert.equal(counts.sign,1);assert.equal(counts.sellerExecute,1);
});
await scenario('ambiguous seller executor result never re-signs or repeats on same job',{sellerAmbiguous:true},async({run,counts})=>{
 await assert.rejects(run(),/synthetic_seller_result_unknown/);await assert.rejects(run(),e=>e.code==='attempt_already_exists');assert.equal(counts.sign,1);assert.equal(counts.sellerExecute,1);assert.equal(counts.ordinary,1);
});
console.log(JSON.stringify({result:'PASS',searchExampleTests:passed,actualNetworkRequests:0,walletSignatures:0,paidActions:0,fixture:'synthetic_public_test_key'}));
