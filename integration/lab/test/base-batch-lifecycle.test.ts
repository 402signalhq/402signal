import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {Pool} from 'pg';
import {privateKeyToAccount} from 'viem/accounts';
import {encodeFunctionData,encodeFunctionResult,decodeFunctionData,encodeEventTopics,encodeAbiParameters,parseAbi,keccak256,type Hex} from 'viem';
import {computeChannelId} from '@x402/evm/batch-settlement/client';
import {BaseBatchController,type BaseBatchPlan} from '../src/base-batch-lifecycle.js';
import {BaseBatchLedger} from '../src/base-batch-ledger.js';import {PostgresBatchOperationJournal} from '../src/batch-operation-journal.js';
import {BASE_BATCH,BASE_COLLECTOR,BASE_USDC,BASE_BATCH_ABI,observeBaseBatch} from '../src/base-batch-observer.js';
const wallet=privateKeyToAccount(('0x'+'11'.repeat(32)) as Hex),receiver=('0x'+'22'.repeat(20)) as Hex,authorizer=('0x'+'33'.repeat(20)) as Hex;
const code='0x6000' as Hex,zero={balance:'0',claimed:'0',receiverClaimed:'0',receiverSettled:'0',withdrawAmount:'0',withdrawAt:'0',refundNonce:'0'};
const tokenAbi=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)','event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)']);
const hex=(n:number)=>('0x'+n.toString(16)) as Hex,hash=(n:number)=>('0x'+n.toString(16).padStart(64,'0')) as Hex;
function plan():BaseBatchPlan{return {version:1,config:{payer:wallet.address,payerAuthorizer:wallet.address,receiver,receiverAuthorizer:authorizer,token:BASE_USDC,withdrawDelay:900,salt:('0x'+'44'.repeat(32)) as Hex},resource:'https://merchant.example/batch',perCallAtomic:'1000',depositAtomic:'4000',maxCalls:3,expiresAt:Date.now()+3600000,maximumBuyerGasWei:'0',contractCodeHash:keccak256(code),collectorCodeHash:keccak256(code)};}
function chain(p:BaseBatchPlan){
 const states=new Map<number,typeof zero>([[100,{...zero}]]),receipts=new Map<string,any>(),transactions=new Map<string,any>();let height=100;
 const transfer=(from:string,to:string,value:bigint)=>({address:BASE_USDC,topics:encodeEventTopics({abi:tokenAbi,eventName:'Transfer',args:{from:from as Hex,to:to as Hex}}),data:encodeAbiParameters([{type:'uint256'}],[value])});
 function append(payload:any){const prev=states.get(height)!;height++;const state={...prev},txHash=hash(height),blockHash=hash(height+1000),logs:any[]=[];let input:Hex;
  if(payload.type==='deposit'){
   state.balance=payload.deposit.amount;const auth=payload.deposit.authorization.erc3009Authorization;
   input=encodeFunctionData({abi:BASE_BATCH_ABI,functionName:'deposit',args:[p.config,BigInt(payload.deposit.amount),BASE_COLLECTOR,'0x']});
   const nonce=keccak256(encodeAbiParameters([{type:'bytes32'},{type:'uint256'}],[computeChannelId(p.config,'eip155:8453'),BigInt(auth.salt)]));
   logs.push(transfer(wallet.address,BASE_COLLECTOR,BigInt(payload.deposit.amount)),transfer(BASE_COLLECTOR,BASE_BATCH,BigInt(payload.deposit.amount)),{address:BASE_USDC,topics:encodeEventTopics({abi:tokenAbi,eventName:'AuthorizationUsed',args:{authorizer:wallet.address,nonce}}),data:'0x'});
  }else if(payload.type==='claim'){
   const c=payload.claims[0];state.claimed=c.totalClaimed;state.receiverClaimed=c.totalClaimed;
   input=encodeFunctionData({abi:BASE_BATCH_ABI,functionName:'claimWithSignature',args:[[{voucher:{channel:p.config,maxClaimableAmount:BigInt(c.voucher.maxClaimableAmount)},signature:c.signature,totalClaimed:BigInt(c.totalClaimed)}],'0x']});
  }else if(payload.type==='settle'){
   const amount=BigInt(state.receiverClaimed)-BigInt(state.receiverSettled);state.receiverSettled=state.receiverClaimed;
   input=encodeFunctionData({abi:BASE_BATCH_ABI,functionName:'settle',args:[p.config.receiver,p.config.token]});logs.push(transfer(BASE_BATCH,p.config.receiver,amount),{address:BASE_BATCH,topics:encodeEventTopics({abi:BASE_BATCH_ABI,eventName:'Settled',args:{receiver:p.config.receiver,token:p.config.token,sender:authorizer}}),data:encodeAbiParameters([{type:'uint128'}],[amount])});
  }else{
   const amount=BigInt(payload.amount);state.balance=(BigInt(state.balance)-amount).toString();state.refundNonce=(BigInt(state.refundNonce)+1n).toString();
   input=encodeFunctionData({abi:BASE_BATCH_ABI,functionName:'refundWithSignature',args:[p.config,amount,BigInt(payload.refundNonce),'0x']});logs.push(transfer(BASE_BATCH,wallet.address,amount));
  }
  states.set(height,state);receipts.set(txHash,{transactionHash:txHash,blockHash,blockNumber:hex(height),status:'0x1',to:BASE_BATCH,from:authorizer,gasUsed:'0x100',effectiveGasPrice:'0x1',logs});transactions.set(txHash,{hash:txHash,blockHash,blockNumber:hex(height),to:BASE_BATCH,from:authorizer,value:'0x0',input});return txHash;
 }
 const rpc=async(method:string,args:any[])=>{
  if(method==='eth_chainId')return '0x2105';if(method==='eth_getCode')return code;
  if(method==='eth_getBlockByNumber'){const n=args[0]==='finalized'?height:Number(BigInt(args[0]));return {number:hex(n),hash:hash(n+1000)};}
  if(method==='eth_getTransactionReceipt')return structuredClone(receipts.get(args[0]));if(method==='eth_getTransactionByHash')return structuredClone(transactions.get(args[0]));
  if(method==='eth_call'){const d=decodeFunctionData({abi:BASE_BATCH_ABI,data:args[0].data}),s=states.get(Number(BigInt(args[1])))!;let result:any;
   if(d.functionName==='channels')result=[BigInt(s.balance),BigInt(s.claimed)];else if(d.functionName==='receivers')result=[BigInt(s.receiverClaimed),BigInt(s.receiverSettled)];else if(d.functionName==='pendingWithdrawals')result=[BigInt(s.withdrawAmount),Number(s.withdrawAt)];else result=BigInt(s.refundNonce);
   return encodeFunctionResult({abi:BASE_BATCH_ABI,functionName:d.functionName,result} as any);
  }throw Error('unexpected RPC write or method');
 };
 return {rpc,append,receipts,transactions,states};
}
const database=process.env.LAB_BATCH_PG_DATABASE;
test('Base funded lifecycle with actual SDK signing and synthetic chain/provider',{skip:!database},async t=>{
 assert.match(database!,/^lab_batch_[a-z0-9_]+$/);const config={database,host:process.env.LAB_BATCH_PG_HOST??'/var/run/postgresql',port:Number(process.env.LAB_BATCH_PG_PORT??5432),user:process.env.LAB_BATCH_PG_USER??'postgres',max:8};const pool=new Pool(config),peer=new Pool(config);
 async function setup(){const id='base-'+randomUUID(),p=plan(),c=chain(p),ledger=new BaseBatchLedger(pool,id),journal=new PostgresBatchOperationJournal(pool,id),controller=new BaseBatchController(ledger,journal,c.rpc,p);await controller.initialize();return {id,p,c,ledger,journal,controller,reopen:()=>new BaseBatchController(new BaseBatchLedger(peer,id),new PostgresBatchOperationJournal(peer,id),c.rpc,p)};}
 try{
  await t.test('deposit, three deliveries, claim, payout and remainder refund reconcile independently',async()=>{
   const s=await setup();let verifies=0,sends=0,signs=0,deliveries=0;
   const owner={address:wallet.address,signTypedData:async(d:any)=>{signs++;assert(await s.ledger.get(d.primaryType==='ReceiveWithAuthorization'?'deposit:typed:1':signs===2?'deposit:typed:2':'delivery:'+(signs-1)+':typed:1'));return wallet.signTypedData(d);}};
   const provider={verify:async()=>{verifies++;return {isValid:true,payer:wallet.address};},settle:async(p:any)=>{sends++;return {success:true,network:'eip155:8453' as const,transaction:s.c.append(p.payload)};}};
   const deposit=await s.controller.prepareDeposit(owner);assert.equal((deposit.payload as any).deposit.amount,'4000');assert.equal(signs,2);
   await s.controller.sendDeposit(provider);assert.equal((await s.ledger.require('progress')).state,'deposit-inflight');
   assert.equal((await s.controller.confirm('deposit')).state,'chain_confirmed');
   const reopened=s.reopen();await reopened.initialize();
   for(let i=1;i<=3;i++){const r=await reopened.deliver(owner,i,'a'.repeat(64),async()=>{deliveries++;return {chargedAmount:'1000',chargedCumulativeAmount:String(i*1000)};});assert.equal(r.state,'voucher_accepted');}
   assert.equal(signs,4);assert.equal(deliveries,3);await reopened.close(3);
   await reopened.sendCloseOperation('claim',provider);assert.equal((await reopened.confirm('claim')).state,'chain_confirmed');
   await reopened.sendCloseOperation('settle',provider);assert.equal((await reopened.confirm('settle')).state,'chain_confirmed');
   await reopened.sendRefund(provider);assert.equal((await reopened.confirm('refund')).state,'chain_confirmed');
   assert.equal((await s.ledger.require('progress')).state,'closed');assert.equal(sends,4);assert.equal(verifies,1);
   const after=(await s.ledger.require('refund:confirmed')).after;assert.equal(after.balance,after.claimed);assert.equal(after.receiverSettled,'3000');
   await assert.rejects(reopened.prepareDeposit(owner));await assert.rejects(reopened.sendRefund(provider));assert.equal(sends,4);
  });
  await t.test('unused confirmed deposit refunds in full without delivery or another voucher signature',async()=>{
   const s=await setup();let signs=0,sends=0;const owner={address:wallet.address,signTypedData:async(d:any)=>{signs++;return wallet.signTypedData(d);}};
   const provider={verify:async()=>({isValid:true}),settle:async(p:any)=>{sends++;return {success:true,network:'eip155:8453' as const,transaction:s.c.append(p.payload)};}};
   await s.controller.prepareDeposit(owner);await s.controller.sendDeposit(provider);await s.controller.confirm('deposit');assert.equal(signs,2);
   const competing=await Promise.allSettled([s.controller.sendUnspentRefund(provider),s.reopen().sendUnspentRefund(provider)]);assert.equal(competing.filter(x=>x.status==='fulfilled').length,1);
   const payload=(await s.ledger.require('refund:payload')).payload;assert.equal(payload.amount,'4000');assert.deepEqual(payload.claims,[]);assert.deepEqual(payload.voucher,(await s.ledger.require('deposit:payload')).payload.voucher);
   assert.equal((await s.reopen().confirm('refund')).state,'chain_confirmed');const after=(await s.ledger.require('refund:confirmed')).after;assert.equal(after.balance,'0');assert.equal(after.claimed,'0');assert.equal(after.receiverSettled,'0');assert.equal((await s.ledger.require('progress')).state,'closed');assert.equal(signs,2);assert.equal(sends,2);
   await assert.rejects(s.reopen().sendUnspentRefund(provider));assert.equal(sends,2);
  });
  await t.test('unknown delivery or changed claimed state cannot use the unused-deposit refund',async()=>{
   for(const mode of ['delivery','claim','nonce']){const s=await setup();const provider={verify:async()=>({isValid:true}),settle:async(p:any)=>({success:true,network:'eip155:8453' as const,transaction:s.c.append(p.payload)})};await s.controller.prepareDeposit(wallet);await s.controller.sendDeposit(provider);await s.controller.confirm('deposit');
    if(mode==='delivery')await s.controller.deliver(wallet,1,'a'.repeat(64),async()=>{throw Error('unknown merchant');});
    else {const latest=[...s.c.states.keys()].at(-1)!;const state=s.c.states.get(latest)!;if(mode==='claim')state.claimed='1';else state.refundNonce='1';}
    let sends=0;await assert.rejects(s.reopen().sendUnspentRefund({settle:async()=>{sends++;throw Error('must not send');}}));assert.equal(sends,0);assert.equal(await s.ledger.get('refund:payload'),undefined);
   }
  });
  await t.test('lost unused-refund acknowledgement stays fenced and exact existing transaction reconciles',async()=>{
   const s=await setup();const provider={verify:async()=>({isValid:true}),settle:async(p:any)=>({success:true,network:'eip155:8453' as const,transaction:s.c.append(p.payload)})};await s.controller.prepareDeposit(wallet);await s.controller.sendDeposit(provider);await s.controller.confirm('deposit');let sends=0,hash:Hex;
   assert.equal((await s.controller.sendUnspentRefund({settle:async(p:any)=>{sends++;hash=s.c.append(p.payload);throw Error('lost');}}) as any).state,'unknown');await assert.rejects(s.reopen().sendUnspentRefund(provider));assert.equal((await s.reopen().confirm('refund',hash!)).state,'chain_confirmed');assert.equal(sends,1);
  });
  await t.test('refund amount/calldata evidence and a concurrent claim never falsely close the reservation',async()=>{
   for(const mode of ['amount','nonce','concurrent-claim']){const s=await setup();const provider={verify:async()=>({isValid:true}),settle:async(p:any)=>({success:true,network:'eip155:8453' as const,transaction:s.c.append(p.payload)})};await s.controller.prepareDeposit(wallet);await s.controller.sendDeposit(provider);await s.controller.confirm('deposit');let hash:Hex,sends=0;
    await s.controller.sendUnspentRefund({settle:async(p:any)=>{sends++;if(mode==='concurrent-claim'){const latest=[...s.c.states.keys()].at(-1)!;s.c.states.get(latest)!.claimed='1';}hash=s.c.append(p.payload);return {success:true,network:'eip155:8453' as const,transaction:hash};}});
    if(mode==='amount')s.c.receipts.get(hash!)!.logs[0].data=encodeAbiParameters([{type:'uint256'}],[3999n]);
    if(mode==='nonce')s.c.transactions.get(hash!)!.input=encodeFunctionData({abi:BASE_BATCH_ABI,functionName:'refundWithSignature',args:[s.p.config,4000n,1n,'0x']});
    assert.equal((await s.reopen().confirm('refund')).state,'unknown');assert.equal((await s.ledger.require('progress')).state,'refund-inflight');assert.equal(await s.ledger.get('refund:confirmed'),undefined);await assert.rejects(s.reopen().sendUnspentRefund(provider));assert.equal(sends,1);
   }
  });
  await t.test('two connections competing for deposit signing get only one durable permit',async()=>{
   const s=await setup();let signs=0;const owner={address:wallet.address,signTypedData:async(d:any)=>{signs++;return wallet.signTypedData(d);}};
   const results=await Promise.allSettled(Array.from({length:12},(_,i)=>(i%2?s.reopen():s.controller).prepareDeposit(owner)));
   assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(signs,2);
  });
  await t.test('uncertain signer result cannot sign again after reopening',async()=>{
   const s=await setup();let signs=0;const owner={address:wallet.address,signTypedData:async()=>{signs++;throw Error('unknown wallet outcome');}};
   await assert.rejects(s.controller.prepareDeposit(owner));await assert.rejects(s.reopen().prepareDeposit(owner));assert.equal(signs,1);
  });
  await t.test('lost deposit provider response blocks resend but permits existing chain reconciliation',async()=>{
   const s=await setup();await s.controller.prepareDeposit(wallet);let sends=0,tx:Hex;
   const provider={verify:async()=>({isValid:true}),settle:async(p:any)=>{sends++;tx=s.c.append(p.payload);throw Error('response lost');}};
   assert.equal((await s.controller.sendDeposit(provider) as any).state,'unknown');await assert.rejects(s.reopen().sendDeposit(provider));
   assert.equal((await s.reopen().confirm('deposit',tx!)).state,'chain_confirmed');assert.equal(sends,1);
  });
  await t.test('merchant uncertainty fences later vouchers and closing across restart',async()=>{
   const s=await setup();await s.controller.prepareDeposit(wallet);const provider={verify:async()=>({isValid:true}),settle:async(p:any)=>({success:true,network:'eip155:8453' as const,transaction:s.c.append(p.payload)})};await s.controller.sendDeposit(provider);await s.controller.confirm('deposit');let sends=0;
   assert.equal((await s.controller.deliver(wallet,1,'b'.repeat(64),async()=>{sends++;throw Error('lost');})).state,'unknown');
   await assert.rejects(s.reopen().deliver(wallet,2,'b'.repeat(64),async()=>{sends++;return {chargedAmount:'1000',chargedCumulativeAmount:'2000'};}));await assert.rejects(s.reopen().close(1));assert.equal(sends,1);
  });
  await t.test('expired campaign cannot authorize but permits reopening and existing deposit reconciliation',async()=>{
   const s=await setup();await s.controller.prepareDeposit(wallet);const tx=s.c.append((await s.ledger.require('deposit:payload')).payload);
   await s.ledger.transition('deposit-ready','deposit-inflight');const real=Date.now;
   try{Date.now=()=>s.p.expiresAt+1;const reopened=s.reopen();await reopened.initialize();await assert.rejects(reopened.deliver(wallet,1,'d'.repeat(64),async()=>{throw Error('no send');}),/expired/);assert.equal((await reopened.confirm('deposit',tx)).state,'chain_confirmed');}finally{Date.now=real;}
  });
  await t.test('policy changes, exhausted capital and nonzero buyer gas fail closed',async()=>{
   const s=await setup();const changed={...s.p,depositAtomic:'5000'};const peerController=new BaseBatchController(new BaseBatchLedger(peer,s.id),new PostgresBatchOperationJournal(peer,s.id),s.c.rpc,changed);await assert.rejects(peerController.initialize(),/immutable campaign conflict/);
   assert.throws(()=>new BaseBatchController(s.ledger,s.journal,s.c.rpc,{...s.p,depositAtomic:'2000'}),/capital below/);
   assert.throws(()=>new BaseBatchController(s.ledger,s.journal,s.c.rpc,{...s.p,maximumBuyerGasWei:'1'}),/zero buyer gas/);
  });
  await t.test('wrong nonce, extra debit, wrong calldata recipient and unfinalized receipts stay unknown',async()=>{
   const s=await setup(),payload=await s.controller.prepareDeposit(wallet);const tx=s.c.append(payload.payload),baseline=await s.ledger.require('baseline');
   const effect={kind:'deposit' as const,config:s.p.config,amount:s.p.depositAtomic,transactionHash:tx,payload:payload.payload,baseline,maxBuyerGasWei:'0'};
   assert.equal((await observeBaseBatch(s.c.rpc,effect)).state,'chain_confirmed');
   for(const mode of ['nonce','debit','calldata','finality','block']){
    const rpc=async(m:string,a:any[])=>{const r=await s.c.rpc(m,a);if(m==='eth_getTransactionReceipt'&&mode==='nonce')r.logs=r.logs.filter((x:any)=>x.data!=='0x');if(m==='eth_getTransactionReceipt'&&mode==='debit')r.logs.push({address:BASE_USDC,topics:encodeEventTopics({abi:tokenAbi,eventName:'Transfer',args:{from:wallet.address,to:receiver}}),data:encodeAbiParameters([{type:'uint256'}],[1n])});if(m==='eth_getTransactionByHash'&&mode==='calldata')r.to=receiver;if(m==='eth_getBlockByNumber'&&a[0]==='finalized'&&mode==='finality')r.number='0x1';if(m==='eth_getTransactionByHash'&&mode==='block')r.blockHash=hash(9999);return r;};assert.equal((await observeBaseBatch(rpc,effect)).state,'unknown',mode);
   }
  });
 }finally{await Promise.all([pool.end(),peer.end()]);}
});
