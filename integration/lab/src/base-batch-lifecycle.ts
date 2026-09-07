import {createBatchSettlementEIP3009DepositPayload,signVoucher,computeChannelId} from '@x402/evm/batch-settlement/client';
import {voucherTypes,BATCH_SETTLEMENT_DOMAIN,authorizationTypes} from '@x402/evm';
import {getAddress,keccak256,encodeAbiParameters,type Hex} from 'viem';
import type {PaymentRequirements,PaymentPayload} from '@x402/core/types';
import type {FacilitatorClient} from '@x402/core/server';
import {BaseBatchLedger,canonical,digest} from './base-batch-ledger.js';
import {BASE_BATCH,BASE_COLLECTOR,BASE_USDC,readBatchState,observeBaseBatch,type ReadRpc,type BatchConfig,type BatchEffect} from './base-batch-observer.js';
import {PostgresBatchOperationJournal} from './batch-operation-journal.js';
import {executeBatchOperation,prepareBatchOperation} from './batch-operation-runner.js';
const freeze=(x:any):any=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const check=(b:any,m:string)=>{if(!b)throw Error(m);};
const uint=(x:string)=>{check(typeof x==='string'&&/^[1-9][0-9]{0,38}$/.test(x)&&BigInt(x)<2n**128n,'invalid bounded amount');return BigInt(x);};
const eq=(a:string,b:string)=>getAddress(a)===getAddress(b);
export interface BaseBatchPlan {version:1;config:BatchConfig;resource:string;perCallAtomic:string;depositAtomic:string;maxCalls:number;expiresAt:number;maximumBuyerGasWei:string;contractCodeHash:Hex;collectorCodeHash:Hex;}
export interface BatchOwnerSigner {address:Hex;signTypedData(data:any):Promise<Hex>}
/** Explicit owner-operated qualification controller: one channel, one receiver,
 * one bounded cycle. It never schedules/retries, accepts new keys, or sends raw
 * transactions. Only the caller supplies a guarded signing capability/provider.
 */
export class BaseBatchController {
 readonly plan:BaseBatchPlan;readonly requirements:PaymentRequirements;
 constructor(readonly ledger:BaseBatchLedger,readonly journal:PostgresBatchOperationJournal,readonly rpc:ReadRpc,plan:BaseBatchPlan){
  this.plan=freeze(JSON.parse(canonical(plan)));const p=this.plan,c=p.config;
  check(p.version===1&&Number.isSafeInteger(p.maxCalls)&&p.maxCalls>=1&&p.maxCalls<=64,'invalid call bound');
  check(uint(p.depositAtomic)>=uint(p.perCallAtomic)*BigInt(p.maxCalls),'capital below call ceiling');
  check(eq(c.token,BASE_USDC)&&eq(c.payer,c.payerAuthorizer)&&!eq(c.payer,c.receiver),'unsupported owner profile');
  check(c.withdrawDelay>=900&&c.withdrawDelay<=86400&&Number.isInteger(c.withdrawDelay),'withdraw delay refused');
  check(/^0x[0-9a-fA-F]{64}$/.test(c.salt)&&c.salt!=='0x'+'0'.repeat(64),'fresh salt required');
  check(/^0x[0-9a-fA-F]{64}$/.test(p.contractCodeHash)&&/^0x[0-9a-fA-F]{64}$/.test(p.collectorCodeHash),'reviewed contract hashes required');
  const u=new URL(p.resource);check(u.protocol==='https:'&&!u.username&&!u.password&&!u.hash,'resource refused');
  check(Number.isSafeInteger(p.expiresAt)&&p.expiresAt>0,'campaign expiry refused');
  check(p.maximumBuyerGasWei==='0','initial provider-sponsored profile requires zero buyer gas');
  this.requirements=freeze({scheme:'batch-settlement',network:'eip155:8453',asset:c.token,payTo:c.receiver,amount:p.perCallAtomic,maxTimeoutSeconds:300,extra:{receiverAuthorizer:c.receiverAuthorizer,withdrawDelay:c.withdrawDelay,name:'USD Coin',version:'2',assetTransferMethod:'eip3009'}});
 }
 private fresh(){check(Date.now()<this.plan.expiresAt,'campaign expired; reconcile or close only');}
 async initialize(){
  await this.ledger.initialize();await this.journal.initialize();await this.ledger.bind(this.plan);
  if(await this.ledger.get('baseline'))return;
  check(this.plan.expiresAt>Date.now()&&this.plan.expiresAt<=Date.now()+86400000,'new campaign expiry refused');
  check(await this.rpc('eth_chainId',[])==='0x2105','wrong chain');
  const block=await this.rpc('eth_getBlockByNumber',['finalized',false]);
  const code=await this.rpc('eth_getCode',[BASE_BATCH,block.number]),collector=await this.rpc('eth_getCode',[BASE_COLLECTOR,block.number]);
  check(code!=='0x'&&collector!=='0x'&&keccak256(code)===this.plan.contractCodeHash&&keccak256(collector)===this.plan.collectorCodeHash,'contract deployment changed');
  const baseline=await readBatchState(this.rpc,this.plan.config,block.number);
  check(Object.values(baseline).every(v=>v==='0'),'isolated fresh channel and receiver required');
  await this.ledger.once('baseline',baseline);await this.ledger.once('progress',{state:'new'});
 }
 private account(owner:BatchOwnerSigner,stage:string,cap:string,deposit=false){
  check(eq(owner.address,this.plan.config.payer),'wrong owner');let calls=0;const bound=owner.signTypedData.bind(owner),p=this.plan,id=computeChannelId(p.config,'eip155:8453');
  return {address:owner.address,signTypedData:async(data:any)=>{
   this.fresh();calls++;const expected=deposit&&calls===1?'ReceiveWithAuthorization':'Voucher';check(data.primaryType===expected&&calls<=(deposit?2:1),'unexpected signing effect');
   if(expected==='Voucher')check(canonical(data.domain)===canonical({...BATCH_SETTLEMENT_DOMAIN,chainId:8453,verifyingContract:BASE_BATCH})&&canonical(data.types)===canonical(voucherTypes)&&data.message.channelId===id&&data.message.maxClaimableAmount===BigInt(cap),'voucher bound mismatch');
   else {const m=data.message;check(canonical(data.domain)===canonical({name:'USD Coin',version:'2',chainId:8453,verifyingContract:BASE_USDC})&&canonical(data.types)===canonical({ReceiveWithAuthorization:authorizationTypes.TransferWithAuthorization})&&eq(m.from,p.config.payer)&&eq(m.to,BASE_COLLECTOR)&&m.value===BigInt(p.depositAtomic)&&m.validAfter===0n&&m.validBefore>BigInt(Date.now()/1000|0)&&m.validBefore<=BigInt((Date.now()/1000|0)+300)&&/^0x[0-9a-f]{64}$/.test(m.nonce),'deposit bound mismatch');}
   check(await this.ledger.once(stage+':typed:'+calls,data),'typed intent already claimed');return bound(data);
  }};
 }
 async prepareDeposit(owner:BatchOwnerSigner){
  this.fresh();await this.ledger.transition('new','deposit-signing');
  const p=this.plan,result=await createBatchSettlementEIP3009DepositPayload(this.account(owner,'deposit',p.perCallAtomic,true),2,this.requirements,p.config,p.depositAtomic,p.perCallAtomic);
  const payload={...result,accepted:this.requirements,resource:{url:p.resource}} as PaymentPayload;
  const raw=payload.payload as any,auth=raw.deposit.authorization.erc3009Authorization,typed=await this.ledger.require('deposit:typed:1');
  check(typed.message.nonce===keccak256(encodeAbiParameters([{type:'bytes32'},{type:'uint256'}],[computeChannelId(p.config,'eip155:8453'),BigInt(auth.salt)])),'deposit nonce does not bind channel');
  check(await this.ledger.once('deposit:payload',payload),'deposit already prepared');await this.ledger.transition('deposit-signing','deposit-ready');return payload;
 }
 async sendDeposit(provider:Pick<FacilitatorClient,'verify'|'settle'>){
  this.fresh();await this.ledger.transition('deposit-ready','deposit-inflight');const payload=freeze(await this.ledger.require('deposit:payload'));
  try {const verified=await provider.verify(payload,this.requirements);check(verified.isValid,'deposit verification failed');const result=await provider.settle(payload,this.requirements);await this.recordAck('deposit',result);return result;}catch{await this.ledger.once('deposit:unknown',{state:'unknown'});return {state:'unknown',newPaymentAllowed:false};}
 }
 private async recordAck(stage:string,result:any){check(result.success&&result.network==='eip155:8453'&&/^0x[0-9a-fA-F]{64}$/.test(result.transaction),'provider outcome unknown');await this.ledger.once(stage+':ack',{transactionHash:result.transaction});}
 async confirm(kind:'deposit'|'claim'|'settle'|'refund',transactionHash?:Hex){
  const prior=await this.ledger.get(kind+':confirmed');if(prior){check(!transactionHash||transactionHash.toLowerCase()===prior.transactionHash.toLowerCase(),'confirmation conflicts');return prior;}
  check((await this.ledger.require('progress')).state===kind+'-inflight','operation was not sent');
  const ack=await this.ledger.get(kind+':ack'),hash=transactionHash??ack?.transactionHash;check(hash,'existing transaction hash required');
  const unusedRefund=kind==='refund'&&(await this.ledger.get('refund:mode'))?.kind==='unused-deposit';
  const p=this.plan,baseline=kind==='deposit'?await this.ledger.require('baseline'):(await this.ledger.require(kind==='claim'||unusedRefund?'deposit:confirmed':kind==='settle'?'claim:confirmed':'settle:confirmed')).after;
  const payload=(await this.ledger.require(kind+':payload')).payload;
  const amount=kind==='deposit'||unusedRefund?p.depositAtomic:kind==='refund'?(BigInt(p.depositAtomic)-BigInt((await this.ledger.require('closing')).charged)).toString():(await this.ledger.require('closing')).charged;
  const effect:BatchEffect={kind,config:p.config,amount,transactionHash:hash,payload,baseline,maxBuyerGasWei:p.maximumBuyerGasWei};
  const observed=await observeBaseBatch(this.rpc,effect);if(observed.state!=='chain_confirmed')return observed;
  if(kind==='claim'||kind==='settle'){const x=await this.operation(kind);await this.journal.reconcile(prepareBatchOperation(x).operationId,{status:'chain_confirmed',transactionHash:hash.toLowerCase(),blockHash:observed.blockHash.toLowerCase(),blockNumber:observed.blockNumber,evidenceDigest:observed.evidenceDigest});}
  await this.ledger.once(kind+':confirmed',observed);
  const next={deposit:['deposit-inflight','active:0'],claim:['claim-inflight','claimed'],settle:['settle-inflight','paid'],refund:['refund-inflight','closed']}[kind]!;
  const current=await this.ledger.require('progress');if(current.state!==next[1])await this.ledger.transition(next[0]!,next[1]!);
  return observed;
 }
 async deliver(owner:BatchOwnerSigner,sequence:number,requestDigest:string,send:(payload:PaymentPayload)=>Promise<{chargedAmount:string;chargedCumulativeAmount:string}>){
  this.fresh();check(Number.isInteger(sequence)&&sequence>=1&&sequence<=this.plan.maxCalls&&/^[0-9a-f]{64}$/.test(requestDigest),'delivery bounds refused');
  await this.ledger.transition('active:'+(sequence-1),'delivery-inflight:'+sequence);
  const cap=(BigInt(this.plan.perCallAtomic)*BigInt(sequence)).toString();let voucher:any;
  if(sequence===1)voucher=(await this.ledger.require('deposit:payload')).payload.voucher;
  else voucher=await signVoucher(this.account(owner,'delivery:'+sequence,cap),computeChannelId(this.plan.config,'eip155:8453'),cap,'eip155:8453');
  const payload:PaymentPayload={x402Version:2,accepted:this.requirements,resource:{url:this.plan.resource},payload:{type:'voucher',channelConfig:this.plan.config,voucher}};
  check(await this.ledger.once('delivery:'+sequence,{requestDigest,payload,cap}),'delivery already exists');
  try{const result=await send(payload);check(result.chargedAmount===this.plan.perCallAtomic&&result.chargedCumulativeAmount===cap,'unconfirmed merchant accounting');await this.ledger.once('delivery:'+sequence+':accepted',{cap});await this.ledger.transition('delivery-inflight:'+sequence,'active:'+sequence);return {state:'voucher_accepted',chainSettled:false};}
  catch{await this.ledger.once('delivery:'+sequence+':unknown',{state:'unknown'});return {state:'unknown',newPaymentAllowed:false};}
 }
 async close(sequence:number){check(sequence>=1&&sequence<=this.plan.maxCalls&&Number.isInteger(sequence),'invalid close sequence');await this.ledger.transition('active:'+sequence,'closing');const d=await this.ledger.require('delivery:'+sequence);await this.ledger.once('closing',{charged:d.cap,voucher:d.payload.payload.voucher});}
 private async operation(kind:'claim'|'settle'){
  const p=this.plan,closing=await this.ledger.require('closing'),r={...this.requirements,amount:'0',maxTimeoutSeconds:0};
  const payload=kind==='claim'?{type:'claim',claims:[{voucher:{channel:p.config,maxClaimableAmount:closing.voucher.maxClaimableAmount},signature:closing.voucher.signature,totalClaimed:closing.charged}]}:{type:'settle',receiver:p.config.receiver,token:p.config.token};
  return {cycleId:this.ledger.campaignId,scope:{network:'eip155:8453',receiver:p.config.receiver,token:p.config.token},requirements:r,paymentPayload:{x402Version:2,accepted:r,payload} as PaymentPayload};
 }
 async sendCloseOperation(kind:'claim'|'settle',provider:Pick<FacilitatorClient,'settle'>){
  await this.ledger.transition(kind==='claim'?'closing':'claimed',kind+'-inflight');const x=await this.operation(kind);await this.ledger.once(kind+':payload',x.paymentPayload);
  const result=await executeBatchOperation(this.journal,provider,x);const event=result.operation?.events.at(-1);if(event?.transactionHash)await this.ledger.once(kind+':ack',{transactionHash:event.transactionHash});return result;
 }
 async sendRefund(provider:Pick<FacilitatorClient,'settle'>){
  const closing=await this.ledger.require('closing'),after=(await this.ledger.require('settle:confirmed')).after;
  const amount=BigInt(this.plan.depositAtomic)-BigInt(closing.charged);check(amount>0n,'no refundable remainder; use closeEmpty');await this.ledger.transition('paid','refund-inflight');
  const r={...this.requirements,amount:'0',maxTimeoutSeconds:0};const paymentPayload:PaymentPayload={x402Version:2,accepted:r,payload:{type:'refund',channelConfig:this.plan.config,voucher:closing.voucher,amount:amount.toString(),refundNonce:after.refundNonce,claims:[]}};
  await this.ledger.once('refund:payload',paymentPayload);
  try{const result=await provider.settle(paymentPayload,r);await this.recordAck('refund',result);return result;}catch{return {state:'unknown',newPaymentAllowed:false};}
 }
 /** Cooperative full refund before any merchant delivery was attempted. The SDK
  * deposit already contains one known initial voucher; it is reused here, never
  * re-signed. Any delivery intent/send (including reuse of that initial voucher)
  * or a changed chain watermark blocks this path. Provider cooperation remains
  * necessary; a concurrent claim can make the refund fail and stays unknown.
  */
 async sendUnspentRefund(provider:Pick<FacilitatorClient,'settle'>){
  check((await this.ledger.require('progress')).state==='active:0','unspent refund requires no attempted delivery');
  const deposit=await this.ledger.require('deposit:confirmed');
  for(let i=1;i<=this.plan.maxCalls;i++)for(const suffix of ['',':typed:1',':unknown',':accepted'])
   check(!await this.ledger.get('delivery:'+i+suffix),'delivery authority already exists');
  check(await this.rpc('eth_chainId',[])==='0x2105','wrong chain');
  const block=await this.rpc('eth_getBlockByNumber',['finalized',false]);
  const current=await readBatchState(this.rpc,this.plan.config,block.number);
  check(canonical(current)===canonical(deposit.after)&&current.balance===this.plan.depositAtomic&&current.claimed==='0'&&current.receiverClaimed==='0'&&current.receiverSettled==='0'&&current.withdrawAmount==='0'&&current.withdrawAt==='0','unused deposit chain state changed');
  await this.ledger.transition('active:0','refund-inflight');
  check(await this.ledger.once('refund:mode',{kind:'unused-deposit',preflightBlockHash:block.hash,preflightBlockNumber:block.number,refundNonce:current.refundNonce}),'refund already claimed');
  const voucher=(await this.ledger.require('deposit:payload')).payload.voucher;
  const requirements={...this.requirements,amount:'0',maxTimeoutSeconds:0};
  const paymentPayload:PaymentPayload={x402Version:2,accepted:requirements,payload:{type:'refund',channelConfig:this.plan.config,voucher,amount:this.plan.depositAtomic,refundNonce:current.refundNonce,claims:[]}};
  check(await this.ledger.once('refund:payload',paymentPayload),'refund payload already exists');
  try{const result=await provider.settle(paymentPayload,requirements);await this.recordAck('refund',result);return result;}
  catch{return {state:'unknown',newPaymentAllowed:false};}
 }
 async closeEmpty(){const after=(await this.ledger.require('settle:confirmed')).after;check(BigInt(after.balance)===BigInt(after.claimed),'capital remains locked');await this.ledger.transition('paid','closed');}
}
