import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {privateKeyToAccount} from 'viem/accounts';
import type {PaymentPayload, PaymentRequirements} from '@x402/core/types';
import type {SettleContext, VerifyContext, FacilitatorClient} from '@x402/core/server';
import {computeChannelId, signVoucher} from '@x402/evm/batch-settlement/client';
import {BatchSettlementEvmScheme, InMemoryChannelStorage, type ChannelStorage, type Channel} from '@x402/evm/batch-settlement/server';
import {FileChannelStorage} from '@x402/evm/batch-settlement/server/file-storage';

// Public, deterministic, unfunded fixture key. No RPC or facilitator requests.
const buyer=privateKeyToAccount(('0x'+'11'.repeat(32)) as `0x${string}`);
const config={payer:buyer.address,payerAuthorizer:buyer.address,
 receiver:'0x2222222222222222222222222222222222222222' as `0x${string}`,
 receiverAuthorizer:'0x2222222222222222222222222222222222222222' as `0x${string}`,
 token:'0x3333333333333333333333333333333333333333' as `0x${string}`,
 withdrawDelay:900,salt:('0x'+'44'.repeat(32)) as `0x${string}`};
const network='eip155:8453',id=computeChannelId(config,network);
const requirements:PaymentRequirements={scheme:'batch-settlement',network,asset:config.token,amount:'3000',payTo:config.receiver,maxTimeoutSeconds:60,
 extra:{receiverAuthorizer:config.receiverAuthorizer,withdrawDelay:900,name:'USD Coin',version:'2'}};
async function request(cap='3000'):Promise<VerifyContext & SettleContext>{
 const voucher=await signVoucher({address:buyer.address,signTypedData:async(d:any)=>buyer.signTypedData(d)},id,cap,network);
 const paymentPayload:PaymentPayload={x402Version:2,accepted:requirements,payload:{type:'voucher',channelConfig:config,voucher}};
 return {paymentPayload,requirements,declaredExtensions:{},phase:'after-handler'};
}
async function fixture(storage:ChannelStorage=new InMemoryChannelStorage()){
 const scheme=new BatchSettlementEvmScheme(config.receiver,{storage});
 const row:Channel={channelId:id,channelConfig:config,chargedCumulativeAmount:'0',signedMaxClaimable:'0',signature:'0x',balance:'300000',totalClaimed:'0',withdrawRequestedAt:0,refundNonce:0,onchainSyncedAt:Date.now(),lastRequestTimestamp:Date.now()};
 await storage.updateChannel(id,()=>row);
 return {scheme,storage};
}
async function verify(scheme:BatchSettlementEvmScheme,ctx:VerifyContext){
 const before=await scheme.schemeHooks.onBeforeVerify!(ctx);
 assert.ok(before && 'skip' in before && before.result.isValid,'real SDK must verify the signed voucher locally');
 return scheme.schemeHooks.onAfterVerify!({...ctx,result:before.result});
}
test('100 SDK voucher lifecycles accrue bounded charges without claiming on-chain settlement',async()=>{
 const {scheme,storage}=await fixture();
 for(let i=1;i<=100;i++){
  const ctx=await request(String(i*3000));
  assert.equal(await verify(scheme,ctx),undefined);
  assert.equal((await storage.get(id))!.chargedCumulativeAmount,String((i-1)*3000));
  const settled=await scheme.schemeHooks.onBeforeSettle!(ctx);
  assert.ok(settled && 'skip' in settled && settled.result.success);
  assert.equal(settled.result.transaction,'','voucher acceptance is not a chain receipt');
  assert.equal((await storage.get(id))!.chargedCumulativeAmount,String(i*3000));
  assert.equal((await storage.get(id))!.totalClaimed,'0');
  const replay=await scheme.schemeHooks.onBeforeVerify!(await request(String(i*3000)));
  assert.ok(replay && 'abort' in replay,'consumed cumulative voucher cannot buy another call');
 }
 const over=await scheme.schemeHooks.onBeforeVerify!(await request('303000'));
 assert.ok(over && 'skip' in over && !over.result.isValid,'deposit balance bounds acceptance');
});
test('concurrent same-channel reservations admit exactly one and cleanup cannot cancel the winner',async()=>{
 const {scheme,storage}=await fixture();
 const ctxs=await Promise.all(Array.from({length:24},()=>request()));
 const results=await Promise.all(ctxs.map(c=>verify(scheme,c)));
 const winners=results.flatMap((r,i)=>r===undefined?[i]:[]);
 assert.equal(winners.length,1);
 for(let i=0;i<ctxs.length;i++) if(i!==winners[0]) await scheme.schemeHooks.onVerifyFailure!({...ctxs[i]!,error:new Error('busy')});
 assert.ok((await storage.get(id))!.pendingRequest);
 const paid=await scheme.schemeHooks.onBeforeSettle!(ctxs[winners[0]!]!);
 assert.ok(paid && 'skip' in paid && paid.result.success);
 assert.equal((await storage.get(id))!.chargedCumulativeAmount,'3000');
});
test('unsuccessful handler cancels reservation without accruing a fee',async()=>{
 const {scheme,storage}=await fixture(),ctx=await request();
 await verify(scheme,ctx);
 await scheme.schemeHooks.onVerifiedPaymentCanceled!({...ctx,reason:'handler_failed',responseStatus:503,settledPhases:[]});
 assert.equal((await storage.get(id))!.chargedCumulativeAmount,'0');
 assert.equal((await storage.get(id))!.pendingRequest,undefined);
 const retry=await request();assert.equal(await verify(scheme,retry),undefined);
});
test('expired reservation can be replaced; old completion cannot charge or clear its replacement',async()=>{
 const {scheme,storage}=await fixture(),old=await request();await verify(scheme,old);
 await storage.updateChannel(id,c=>({...c!,pendingRequest:{...c!.pendingRequest!,expiresAt:0}}));
 const fresh=await request();await verify(scheme,fresh);
 const before=(await storage.get(id))!.pendingRequest!.pendingId;
 await scheme.schemeHooks.onSettleFailure!({...old,error:new Error('late worker')});
 assert.equal((await storage.get(id))!.pendingRequest!.pendingId,before);
 const stale=await scheme.schemeHooks.onBeforeSettle!(old);
 assert.ok(stale && 'abort' in stale);
 const paid=await scheme.schemeHooks.onBeforeSettle!(fresh);assert.ok(paid && 'skip' in paid);
 assert.equal((await storage.get(id))!.chargedCumulativeAmount,'3000');
});
test('reopened durable SDK store preserves pending work and consumed voucher state',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'402signal-batch-'));
 try{
  const {scheme}=await fixture(new FileChannelStorage({directory}));const ctx=await request();await verify(scheme,ctx);
  const storage=new FileChannelStorage({directory});const restarted=new BatchSettlementEvmScheme(config.receiver,{storage});
  const busy=await verify(restarted,await request());assert.ok(busy && 'abort' in busy);
  await scheme.schemeHooks.onBeforeSettle!(ctx);
  const replay=await restarted.schemeHooks.onBeforeVerify!(await request());assert.ok(replay && 'abort' in replay);
  assert.equal((await storage.get(id))!.chargedCumulativeAmount,'3000');
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('stale chain cache delegates to facilitator and does not refresh itself with local reads',async()=>{
 const {scheme,storage}=await fixture();
 await storage.updateChannel(id,c=>({...c!,onchainSyncedAt:Date.now()-3600000}));
 assert.equal(await scheme.schemeHooks.onBeforeVerify!(await request()),undefined);
 assert.equal((await storage.get(id))!.pendingRequest,undefined);
});
test('bad signature and channel binding cannot mutate balances or reserve work',async()=>{
 const {scheme,storage}=await fixture();const ctx=await request();
 const bad=structuredClone(ctx) as any;bad.paymentPayload.payload.voucher.signature='0x'+'00'.repeat(65);
 const r=await scheme.schemeHooks.onBeforeVerify!(bad);assert.ok(r && 'skip' in r && !r.result.isValid);
 const wrong=structuredClone(ctx) as any;wrong.paymentPayload.payload.voucher.channelId='0x'+'ff'.repeat(32);
 const bound=await scheme.schemeHooks.onBeforeVerify!(wrong);assert.ok(bound && 'abort' in bound);
 assert.equal((await storage.get(id))!.pendingRequest,undefined);assert.equal((await storage.get(id))!.chargedCumulativeAmount,'0');
});
test('unavailable storage aborts verification without reporting payment success',async()=>{
 const broken:ChannelStorage={get:async()=>{throw new Error('offline');},list:async()=>[],updateChannel:async()=>{throw new Error('offline');}};
 const scheme=new BatchSettlementEvmScheme(config.receiver,{storage:broken});
 const r=await scheme.schemeHooks.onBeforeVerify!(await request());assert.ok(r && 'abort' in r);
});

function provider(failAt?:string){
 const calls:PaymentPayload[]=[];
 const client:FacilitatorClient={getSupported:async()=>({kinds:[],extensions:[],signers:{}}),
  verify:async()=>{throw new Error('unexpected verification');},
  settle:async(payload:any)=>{calls.push(structuredClone(payload));if(payload.payload.type===failAt)throw new Error('ambiguous provider transport failure');
   return {success:true,transaction:'0x'+'aa'.repeat(32),network};}};
 return {calls,client};
}
async function accrue(scheme:BatchSettlementEvmScheme){const ctx=await request();await verify(scheme,ctx);await scheme.schemeHooks.onBeforeSettle!(ctx);}
test('provider claim failure leaves an accrued voucher unconfirmed and does not trigger payout',async()=>{
 const {scheme,storage}=await fixture();await accrue(scheme);const p=provider('claim');
 await assert.rejects(scheme.createChannelManager(p.client,network,config.token).claimAndSettle(),/ambiguous/);
 assert.deepEqual(p.calls.map(p=>p.payload.type),['claim']);
 assert.equal((await storage.get(id))!.chargedCumulativeAmount,'3000');
 assert.equal((await storage.get(id))!.totalClaimed,'0');
});
test('batch claim uses completed work amount, excludes an unfinished reservation and requires separate payout',async()=>{
 const {scheme,storage}=await fixture();await accrue(scheme);
 const unfinished=await request('6000');await verify(scheme,unfinished);
 const p=provider(),m=scheme.createChannelManager(p.client,network,config.token);
 const claims=await m.claim();assert.equal(claims.length,1);
 const raw=p.calls[0]!.payload as any;assert.equal(raw.type,'claim');
 assert.equal(raw.claims[0].totalClaimed,'3000');assert.equal(raw.claims[0].voucher.maxClaimableAmount,'6000');
 assert.equal((await storage.get(id))!.totalClaimed,'3000');
 assert.deepEqual(p.calls.map(p=>p.payload.type),['claim'],'claim alone does not transfer the receiver payout');
 await m.settle();assert.deepEqual(p.calls.map(p=>p.payload.type),['claim','settle']);
});
test('restarted SDK manager needs explicit payout recovery after a successful claim',async()=>{
 const {scheme,storage}=await fixture();await accrue(scheme);const p=provider();
 await scheme.createChannelManager(p.client,network,config.token).claim();
 const restarted=new BatchSettlementEvmScheme(config.receiver,{storage});
 const manager=restarted.createChannelManager(p.client,network,config.token);
 const retry=await manager.claimAndSettle();
 assert.equal(retry.claims.length,0);assert.equal(retry.settle,undefined);
 assert.equal(p.calls.length,1,'SDK does not persist pending payout intent');
 // A durable orchestration journal must recover this explicit action in production.
 await manager.settle();assert.equal(p.calls[1]!.payload.type,'settle');
});
