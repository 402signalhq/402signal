import test from 'node:test';
import assert from 'node:assert/strict';
import { Address } from '@algorandfoundation/algokit-utils';
import { Transaction, TransactionType, groupTransactions, encodeTransactionRaw } from '@algorandfoundation/algokit-utils/transact';
import type { PaymentRequirements } from '@x402/core/types';
import { computeChannelId, signVoucher } from '@x402/evm/batch-settlement/client';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress } from 'viem';
import { quoteValidationBatch, earnedValidationFee, checkAlgorandBatchGroup, type ValidationScope } from '../src/batch-policy.js';
import { ALGO_GENESIS } from '../src/mainnet-policy.js';
import { railInfo } from '../src/config.js';

const scope=(resource='https://api.example/weather'):ValidationScope=>({resource,requestHash:'ab'.repeat(32),network:'eip155:8453',asset:'USDC',payTo:'seller',merchantMaxAtomic:'1000',expiresAt:1060});
test('one validation reused 100 times earns one fee; multiple scopes earn separate fees',()=>{
  const q=quoteValidationBatch(Array.from({length:100},()=>scope()),'3000','3000',1000,100);
  assert.equal(q.scopes.length,1);assert.equal(q.maximumRouterAtomic,'3000');
  assert.equal(earnedValidationFee(q,[q.scopes[0]!.id],1001),'3000');
  const multi=quoteValidationBatch([scope(),scope('https://api.example/other')],'3000','6000',1000);
  assert.equal(multi.maximumRouterAtomic,'6000');
  assert.equal(earnedValidationFee(multi,[multi.scopes[0]!.id],1001),'3000');
  assert.equal(earnedValidationFee(multi,[],1001),'0');
});
test('changed payment terms or request content create distinct validation scopes',()=>{
  const a=scope(),b={...scope(),merchantMaxAtomic:'2000'},c={...scope(),requestHash:'cd'.repeat(32)};
  assert.equal(quoteValidationBatch([a,b,c],'3000','9000',1000).scopes.length,3);
});
test('quotes enforce caps, expiry and unique successful output billing',()=>{
  assert.throws(()=>quoteValidationBatch([scope()],'3000','2999',1000));
  const q=quoteValidationBatch([scope()],'3000','3000',1000);
  assert.throws(()=>earnedValidationFee(q,[q.scopes[0]!.id,q.scopes[0]!.id],1001));
  assert.throws(()=>earnedValidationFee(q,['unknown'],1001));
  assert.throws(()=>earnedValidationFee(q,[],1060));
  assert.throws(()=>quoteValidationBatch([{...scope(),resource:'https://user:secret@example.com'}],'3000','3000',1000));
});
test('Base SDK channel identity binds recipient and chain; voucher signature binds cumulative ceiling',async()=>{
  // Public synthetic key only. No RPC or real wallet is used by this test.
  const account=privateKeyToAccount(('0x'+'11'.repeat(32)) as `0x${string}`);
  const config={payer:account.address,payerAuthorizer:account.address,receiver:'0x2222222222222222222222222222222222222222' as `0x${string}`,
    receiverAuthorizer:'0x2222222222222222222222222222222222222222' as `0x${string}`,token:'0x3333333333333333333333333333333333333333' as `0x${string}`,withdrawDelay:900,salt:('0x'+'44'.repeat(32)) as `0x${string}`};
  const id=computeChannelId(config,'eip155:8453');
  assert.notEqual(id,computeChannelId(config,'eip155:84532'));
  assert.notEqual(id,computeChannelId({...config,receiver:account.address},'eip155:8453'));
  let typed:any;
  const voucher=await signVoucher({address:account.address,signTypedData:async(data:any)=>{typed=data;return account.signTypedData(data);}},id,'6000','eip155:8453');
  assert.equal(voucher.maxClaimableAmount,'6000');assert.equal(voucher.channelId,id);
  assert.equal((await recoverTypedDataAddress({...typed,signature:voucher.signature})).toLowerCase(),account.address.toLowerCase());
  const changed={...typed,message:{...typed.message,maxClaimableAmount:6001n},signature:voucher.signature};
  assert.notEqual((await recoverTypedDataAddress(changed)).toLowerCase(),account.address.toLowerCase());
});
const addr=(n:number)=>new Address(new Uint8Array(32).fill(n)).toString();
const buyer=addr(2),sponsor=addr(3);
function group(count=2){
  const info=railInfo('algorand','mainnet');
  const requirements:PaymentRequirements[]=Array.from({length:count},(_,i)=>({scheme:'exact',network:info.network,asset:info.asset,amount:'1000',payTo:addr(10+i),maxTimeoutSeconds:60,extra:{feePayer:sponsor}}));
  const shared={genesisHash:Buffer.from(ALGO_GENESIS,'base64'),genesisId:'mainnet-v1.0',firstValid:1000n,lastValid:1500n};
  const txs=groupTransactions([new Transaction({...shared,type:TransactionType.Payment,sender:Address.fromString(sponsor),fee:BigInt(count+1)*1000n,payment:{receiver:Address.fromString(sponsor),amount:0n}}),
    ...requirements.map(r=>new Transaction({...shared,type:TransactionType.AssetTransfer,sender:Address.fromString(buyer),fee:0n,assetTransfer:{receiver:Address.fromString(r.payTo),assetId:BigInt(r.asset),amount:1000n}}))]);
  return {requirements,txs,indexes:requirements.map((_,i)=>i+1)};
}
const check=(g:ReturnType<typeof group>,cap='100000')=>checkAlgorandBatchGroup(g.txs.map(t=>encodeTransactionRaw(t)),g.indexes,g.requirements,buyer,cap,20000n);
test('Algorand batch validates every transfer and returns indexed transaction identities',()=>{
  const g=group();const r=check(g);assert.equal(r.totalAtomic,'2000');assert.equal(r.transfers.length,2);
  assert.notEqual(r.transfers[0]!.transaction,r.transfers[1]!.transaction);
  assert.equal(check(group(15)).transfers.length,15);
});
test('Algorand batch refuses overspend, extra signer and unauthorized recipient',()=>{
  assert.throws(()=>check(group(),'1999'));
  const a=group();a.indexes.unshift(0);assert.throws(()=>check(a));
  const b=group();b.requirements[1]!.payTo=addr(40);assert.throws(()=>check(b));
});
test('Algorand batch refuses broken grouping, wrong network and forbidden side effects',()=>{
  const a=group();a.txs[1]!.group=new Uint8Array(32);assert.throws(()=>check(a));
  const b=group();b.requirements[0]!.network='algorand:wrong';assert.throws(()=>check(b));
  const c=group();c.txs[1]!.rekeyTo=Address.fromString(addr(50));assert.throws(()=>check(c));
  const d=group();d.txs[1]!.assetTransfer!.closeRemainderTo=Address.fromString(addr(50));assert.throws(()=>check(d));
});
test('Algorand batch refuses more than 16 top-level transactions including sponsor',()=>{
  const g=group();g.requirements=Array(16).fill(g.requirements[0]);
  assert.throws(()=>check(g));
});
