import {createHash} from 'node:crypto';
import {computeChannelId} from '@x402/evm/batch-settlement/client';
import type {PaymentPayload, PaymentRequirements} from '@x402/core/types';
import type {FacilitatorClient} from '@x402/core/server';
import type {PostgresBatchOperationJournal} from './batch-operation-journal.js';

type Journal=Pick<PostgresBatchOperationJournal,'plan'|'acquire'|'recordOutcome'|'get'>;
export type BatchOperationScope={network:string;receiver:string;token:string};
export type BatchOperationInput={cycleId:string;scope:BatchOperationScope;paymentPayload:PaymentPayload;requirements:PaymentRequirements};
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const hexAddress=(s:unknown):s is string=>typeof s==='string' && /^0x[0-9a-fA-F]{40}$/.test(s);
const uint=(s:unknown):bigint=>{if(typeof s!=='string'||!/^(0|[1-9][0-9]{0,77})$/.test(s))throw new Error('invalid amount');const n=BigInt(s);if(n>=2n**256n)throw new Error('invalid amount');return n;};
function canonical(value:unknown):string{
 if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
 if(typeof value==='number'&&Number.isSafeInteger(value))return String(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype)return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
 throw new Error('unsupported payment value');
}
/** Lab controller only. No automatic scheduling, signing, funding or retry. */
export function prepareBatchOperation(input:BatchOperationInput){
 if(!/^[a-zA-Z0-9_-]{8,128}$/.test(input.cycleId))throw new Error('stable cycle id required');
 const scope={network:input.scope.network,receiver:input.scope.receiver.toLowerCase(),token:input.scope.token.toLowerCase()};
 if(!/^eip155:[1-9][0-9]*$/.test(scope.network)||!hexAddress(scope.receiver)||!hexAddress(scope.token))throw new Error('invalid operation scope');
 // Freeze the JSON wire value before hashing or acquiring a send permit. Caller
 // mutation during an async database operation cannot change what gets sent.
 const wire=canonical({paymentPayload:input.paymentPayload,requirements:input.requirements});
 if(Buffer.byteLength(wire)>262144)throw new Error('operation too large');
 const {paymentPayload,requirements}=JSON.parse(wire) as Pick<BatchOperationInput,'paymentPayload'|'requirements'>;
 const r=requirements,p=paymentPayload.payload as any;
 if(paymentPayload.x402Version!==2 || r.scheme!=='batch-settlement'||r.network!==scope.network||r.amount!=='0'||!hexAddress(r.payTo)||r.payTo.toLowerCase()!==scope.receiver||!hexAddress(r.asset)||r.asset.toLowerCase()!==scope.token||canonical(paymentPayload.accepted)!==canonical(r))throw new Error('operation requirement mismatch');
 if(p.type==='settle'){
  if(!hexAddress(p.receiver)||p.receiver.toLowerCase()!==scope.receiver||!hexAddress(p.token)||p.token.toLowerCase()!==scope.token)throw new Error('payout scope mismatch');
 }else if(p.type==='claim'){
  if(!Array.isArray(p.claims)||p.claims.length<1||p.claims.length>100)throw new Error('bounded claim batch required');
  const seen=new Set<string>();
  for(const claim of p.claims){
   const c=claim?.voucher?.channel;
   if(!c||!hexAddress(c.receiver)||c.receiver.toLowerCase()!==scope.receiver||!hexAddress(c.token)||c.token.toLowerCase()!==scope.token)throw new Error('claim scope mismatch');
   const id=computeChannelId(c,scope.network);if(seen.has(id))throw new Error('duplicate claim channel');seen.add(id);
   if(uint(claim.totalClaimed)>uint(claim.voucher.maxClaimableAmount))throw new Error('claim exceeds signed cap');
   if(typeof claim.signature!=='string'||!/^0x[0-9a-fA-F]+$/.test(claim.signature)||claim.signature.length>8194)throw new Error('invalid claim signature encoding');
  }
 }else throw new Error('only claim and payout operations are supported');
 const kind=p.type as 'claim'|'settle';
 return {operationId:sha(canonical({cycleId:input.cycleId,scope,kind})),kind,scope,payloadDigest:sha(wire),paymentPayload,requirements};
}
/** Persist send ownership before the provider call; uncertain outcomes stay blocked.
 * A provider acknowledgement is not independently confirmed chain settlement.
 * Cross-cycle scheduling and chain reconciliation remain separate controller duties.
 */
export async function executeBatchOperation(journal:Journal,provider:Pick<FacilitatorClient,'settle'>,input:BatchOperationInput){
 const prepared=prepareBatchOperation(input);
 const {operationId,kind,scope,payloadDigest}=prepared;
 await journal.plan({operationId,kind,scope,payloadDigest});
 const permit=await journal.acquire(operationId);
 if(!permit)return {sent:false,operation:await journal.get(operationId)};
 try{
  const result=await provider.settle(prepared.paymentPayload,prepared.requirements);
  const acknowledged=result.success && result.network===scope.network && /^0x[0-9a-fA-F]{64}$/.test(result.transaction);
  const evidenceDigest=sha(canonical({success:result.success,network:result.network,transaction:result.transaction}));
  const operation=await journal.recordOutcome(operationId,permit.sendToken,{status:acknowledged?'provider_ack':'unknown',evidenceDigest,...(acknowledged?{transactionHash:result.transaction.toLowerCase()}: {})});
  return {sent:true,operation};
 }catch{
  // No provider error text or payload is persisted; it may contain sensitive data.
  // If this durable write also fails, inflight remains blocked after restart.
  const operation=await journal.recordOutcome(operationId,permit.sendToken,{status:'unknown',evidenceDigest:sha('provider call or acknowledgement persistence uncertain')});
  return {sent:true,operation};
 }
}
