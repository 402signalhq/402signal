import {BaseSessionClient} from '../src/base.mjs';
import {setup as proofFixture} from './fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {privateKeyToAccount} from 'viem/accounts';
import {encodeFunctionData,encodeFunctionResult,decodeFunctionData,encodeEventTopics,encodeAbiParameters,parseAbi,keccak256} from 'viem';
import {computeChannelId} from '@x402/evm/batch-settlement/client';
import {BaseBatchController} from '../internal/base-batch-lifecycle.js';
import {LocalBatchLedger,LocalOperationJournal} from '../internal/local-ledger.mjs';
import {BASE_BATCH,BASE_COLLECTOR,BASE_USDC,BASE_BATCH_ABI} from '../internal/base-batch-observer.js';
// ABI-encoded fixture derived from the existing lab lifecycle test. Receiver
// counters are cumulative across channels; this fixture models that history.
const wallet = privateKeyToAccount(('0x' + '11'.repeat(32))), receiver = ('0x' + '22'.repeat(20)), authorizer = ('0x' + '33'.repeat(20));
const code = '0x6000', zero = { balance: '0', claimed: '0', receiverClaimed: '0', receiverSettled: '0', withdrawAmount: '0', withdrawAt: '0', refundNonce: '0' };
const tokenAbi = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)', 'event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)']);
const hex = (n) => ('0x' + n.toString(16)), hash = (n) => ('0x' + n.toString(16).padStart(64, '0'));
function plan() { return { version: 1, config: { payer: wallet.address, payerAuthorizer: wallet.address, receiver, receiverAuthorizer: authorizer, token: BASE_USDC, withdrawDelay: 900, salt: ('0x' + '44'.repeat(32)) }, resource: 'https://merchant.example/batch', perCallAtomic: '1000', depositAtomic: '4000', maxCalls: 3, expiresAt: Date.now() + 3600000, maximumBuyerGasWei: '0', contractCodeHash: keccak256(code), collectorCodeHash: keccak256(code) }; }
function chain(p, initial = { ...zero }) {
    const states = new Map([[100, { ...initial }]]), receipts = new Map(), transactions = new Map();
    let height = 100;
    const transfer = (from, to, value) => ({ address: BASE_USDC, topics: encodeEventTopics({ abi: tokenAbi, eventName: 'Transfer', args: { from: from, to: to } }), data: encodeAbiParameters([{ type: 'uint256' }], [value]) });
    function append(payload) {
        const prev = states.get(height);
        height++;
        const state = { ...prev }, txHash = hash(height), blockHash = hash(height + 1000), logs = [];
        let input;
        if (payload.type === 'deposit') {
            state.balance = payload.deposit.amount;
            const auth = payload.deposit.authorization.erc3009Authorization;
            input = encodeFunctionData({ abi: BASE_BATCH_ABI, functionName: 'deposit', args: [p.config, BigInt(payload.deposit.amount), BASE_COLLECTOR, '0x'] });
            const nonce = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [computeChannelId(p.config, 'eip155:8453'), BigInt(auth.salt)]));
            logs.push(transfer(wallet.address, BASE_COLLECTOR, BigInt(payload.deposit.amount)), transfer(BASE_COLLECTOR, BASE_BATCH, BigInt(payload.deposit.amount)), { address: BASE_USDC, topics: encodeEventTopics({ abi: tokenAbi, eventName: 'AuthorizationUsed', args: { authorizer: wallet.address, nonce } }), data: '0x' });
        }
        else if (payload.type === 'claim') {
            const c = payload.claims[0];
            state.receiverClaimed = (BigInt(state.receiverClaimed) + BigInt(c.totalClaimed) - BigInt(state.claimed)).toString();
            state.claimed = c.totalClaimed;
            input = encodeFunctionData({ abi: BASE_BATCH_ABI, functionName: 'claimWithSignature', args: [[{ voucher: { channel: p.config, maxClaimableAmount: BigInt(c.voucher.maxClaimableAmount) }, signature: c.signature, totalClaimed: BigInt(c.totalClaimed) }], '0x'] });
        }
        else if (payload.type === 'settle') {
            const amount = BigInt(state.receiverClaimed) - BigInt(state.receiverSettled);
            state.receiverSettled = state.receiverClaimed;
            input = encodeFunctionData({ abi: BASE_BATCH_ABI, functionName: 'settle', args: [p.config.receiver, p.config.token] });
            logs.push(transfer(BASE_BATCH, p.config.receiver, amount), { address: BASE_BATCH, topics: encodeEventTopics({ abi: BASE_BATCH_ABI, eventName: 'Settled', args: { receiver: p.config.receiver, token: p.config.token, sender: authorizer } }), data: encodeAbiParameters([{ type: 'uint128' }], [amount]) });
        }
        else {
            const amount = BigInt(payload.amount);
            state.balance = (BigInt(state.balance) - amount).toString();
            state.refundNonce = (BigInt(state.refundNonce) + 1n).toString();
            input = encodeFunctionData({ abi: BASE_BATCH_ABI, functionName: 'refundWithSignature', args: [p.config, amount, BigInt(payload.refundNonce), '0x'] });
            logs.push(transfer(BASE_BATCH, wallet.address, amount));
        }
        states.set(height, state);
        receipts.set(txHash, { transactionHash: txHash, blockHash, blockNumber: hex(height), status: '0x1', to: BASE_BATCH, from: authorizer, gasUsed: '0x100', effectiveGasPrice: '0x1', logs });
        transactions.set(txHash, { hash: txHash, blockHash, blockNumber: hex(height), to: BASE_BATCH, from: authorizer, value: '0x0', input });
        return txHash;
    }
    const rpc = async (method, args) => {
        if (method === 'eth_chainId')
            return '0x2105';
        if (method === 'eth_getCode')
            return code;
        if (method === 'eth_getBlockByNumber') {
            const n = args[0] === 'finalized' ? height : Number(BigInt(args[0]));
            return { number: hex(n), hash: hash(n + 1000) };
        }
        if (method === 'eth_getTransactionReceipt')
            return structuredClone(receipts.get(args[0]));
        if (method === 'eth_getTransactionByHash')
            return structuredClone(transactions.get(args[0]));
        if (method === 'eth_call') {
            const d = decodeFunctionData({ abi: BASE_BATCH_ABI, data: args[0].data }), s = states.get(Number(BigInt(args[1])));
            let result;
            if (d.functionName === 'channels')
                result = [BigInt(s.balance), BigInt(s.claimed)];
            else if (d.functionName === 'receivers')
                result = [BigInt(s.receiverClaimed), BigInt(s.receiverSettled)];
            else if (d.functionName === 'pendingWithdrawals')
                result = [BigInt(s.withdrawAmount), Number(s.withdrawAt)];
            else
                result = BigInt(s.refundNonce);
            return encodeFunctionResult({ abi: BASE_BATCH_ABI, functionName: d.functionName, result });
        }
        throw Error('unexpected RPC write or method');
    };
    const other = (sameBlock = false) => { const s = { ...states.get(height) }; s.receiverClaimed = (BigInt(s.receiverClaimed) + 7n).toString(); s.receiverSettled = (BigInt(s.receiverSettled) + 7n).toString(); if (!sameBlock)
        height++; states.set(height, s); };
    return { rpc, append, receipts, transactions, states, other };
}

const reused={...zero,receiverClaimed:'2000',receiverSettled:'2000'};
async function setup(initial=reused){
 const directory=mkdtempSync(join(tmpdir(),'base-receiver-')),p=plan(),c=chain(p,initial),ledger=new LocalBatchLedger(directory,'receiver-regression');
 const reopen=()=>new BaseBatchController(ledger,new LocalOperationJournal(ledger),c.rpc,p);
 const controller=reopen();let sends=0,signs=0,verifies=0;
 const owner={address:wallet.address,signTypedData:async d=>{signs++;return wallet.signTypedData(d);}};
 const provider={verify:async()=>{verifies++;return {isValid:true};},settle:async payload=>{sends++;return {success:true,network:'eip155:8453',transaction:c.append(payload.payload)};}};
 return {directory,p,c,ledger,controller,reopen,owner,provider,counts:()=>({sends,signs,verifies}),cleanup:()=>{ledger.close();rmSync(directory,{recursive:true,force:true});}};
}
async function fund(s){await s.controller.initialize();await s.controller.prepareDeposit(s.owner);await s.controller.sendDeposit(s.provider);assert.equal((await s.reopen().confirm('deposit')).state,'chain_confirmed');}
async function delivered(s){await fund(s);for(let i=1;i<=3;i++)assert.equal((await s.controller.deliver(s.owner,i,'a'.repeat(64),async()=>({chargedAmount:'1000',chargedCumulativeAmount:String(i*1000)}))).state,'voucher_accepted');await s.controller.close(3);}
test('fresh channel reuses a fully paid receiver: finalized deposit, three calls, claim, payout and refund',async()=>{
 const s=await setup();try{await delivered(s);assert.deepEqual(await s.ledger.require('baseline'),reused);
  await s.controller.sendCloseOperation('claim',s.provider);assert.equal((await s.reopen().confirm('claim')).state,'chain_confirmed');
  await s.controller.sendCloseOperation('settle',s.provider);assert.equal((await s.reopen().confirm('settle')).state,'chain_confirmed');
  await s.controller.sendRefund(s.provider);assert.equal((await s.reopen().confirm('refund')).state,'chain_confirmed');
  const after=(await s.ledger.require('refund:confirmed')).after;assert.equal(after.receiverClaimed,'5000');assert.equal(after.receiverSettled,'5000');assert.equal(after.balance,after.claimed);assert.equal((await s.ledger.require('progress')).state,'closed');assert.deepEqual(s.counts(),{sends:4,signs:4,verifies:1});
 }finally{s.cleanup();}
});
test('reused receiver permits expired unused-deposit refund without signing again',async()=>{
 const s=await setup();const clock=Date.now;try{await fund(s);Date.now=()=>s.p.expiresAt+1;await s.reopen().sendUnspentRefund(s.provider);assert.equal((await s.reopen().confirm('refund')).state,'chain_confirmed');const a=(await s.ledger.require('refund:confirmed')).after;assert.equal(a.balance,'0');assert.equal(a.receiverClaimed,'2000');assert.equal(a.receiverSettled,'2000');assert.deepEqual(s.counts(),{sends:2,signs:2,verifies:1});await assert.rejects(s.reopen().sendUnspentRefund(s.provider));}finally{Date.now=clock;s.cleanup();}
});
test('nonfresh own channel and unrelated unpaid receiver balance refuse before authority',async()=>{
 for(const key of ['balance','claimed','withdrawAmount','withdrawAt','refundNonce','receiverClaimed','receiverSettled']){
  const s=await setup({...reused,[key]:key.startsWith('receiver')?'2001':'1'});try{await assert.rejects(s.controller.initialize());assert.equal(await s.ledger.get('baseline'),undefined);assert.deepEqual(s.counts(),{sends:0,signs:0,verifies:0});}finally{s.cleanup();}
 }
});
test('other-channel receiver activity before or inside each operation block remains unknown and never resends',async()=>{
 for(const kind of ['deposit','claim','settle','refund'])for(const timing of ['before','same-block']){
  const s=await setup();try{
   if(kind==='deposit'){await s.controller.initialize();await s.controller.prepareDeposit(s.owner);}
   else {await delivered(s);if(kind==='settle'||kind==='refund'){await s.controller.sendCloseOperation('claim',s.provider);assert.equal((await s.controller.confirm('claim')).state,'chain_confirmed');}if(kind==='refund'){await s.controller.sendCloseOperation('settle',s.provider);assert.equal((await s.controller.confirm('settle')).state,'chain_confirmed');}}
   if(timing==='before')s.c.other();
   const send=()=>kind==='deposit'?s.controller.sendDeposit(s.provider):kind==='refund'?s.controller.sendRefund(s.provider):s.controller.sendCloseOperation(kind,s.provider);
   await send();if(timing==='same-block')s.c.other(true);const count=s.counts().sends;
   assert.equal((await s.reopen().confirm(kind)).state,'unknown',kind+':'+timing);assert.equal(await s.ledger.get(kind+':confirmed'),undefined);assert.equal((await s.ledger.require('progress')).state,kind+'-inflight');await assert.rejects(send());assert.equal(s.counts().sends,count);
  }finally{s.cleanup();}
 }
});
test('unrelated receiver movement before unused refund refuses provider call and any refund intent',async()=>{
 const s=await setup();try{await fund(s);s.c.other();await assert.rejects(s.reopen().sendUnspentRefund(s.provider));assert.equal(await s.ledger.get('refund:payload'),undefined);assert.equal(s.counts().sends,1);}finally{s.cleanup();}
});

test('public BaseSessionClient inherits receiver reuse while validating its original signed observation',async()=>{
 const original=await proofFixture('base');const directory=mkdtempSync(join(tmpdir(),'base-public-receiver-'));const ledger=new LocalBatchLedger(directory,'public-receiver-regression');
 try{const c=chain(original.plan,reused),client=new BaseSessionClient(ledger,new LocalOperationJournal(ledger),c.rpc,original.plan,{policy:original.policy,initialObservation:original.proof});await client.initialize();assert.deepEqual(await ledger.require('baseline'),reused);await client.prepareDeposit(original.owner);assert.equal((await ledger.require('progress')).state,'deposit-ready');assert.equal((await ledger.require('deposit:payload')).payload.deposit.amount,'4000');}
 finally{ledger.close();original.ledger.close();rmSync(directory,{recursive:true,force:true});rmSync(original.directory,{recursive:true,force:true});}
});
