import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {PostgresBatchOperationJournal} from '../src/batch-operation-journal.js';
import {prepareBatchOperation,executeBatchOperation,type BatchOperationInput} from '../src/batch-operation-runner.js';
const scope={network:'eip155:8453',receiver:'0x'+'22'.repeat(20),token:'0x'+'33'.repeat(20)};
function input(cycleId='synthetic-cycle-01'):BatchOperationInput{
 const requirements={scheme:'batch-settlement',network:'eip155:8453' as const,amount:'0',asset:scope.token,payTo:scope.receiver,maxTimeoutSeconds:0,extra:{}};
 return {cycleId,scope:{...scope},requirements,paymentPayload:{x402Version:2,accepted:requirements,payload:{type:'settle',receiver:scope.receiver,token:scope.token}}};
}
test('operation identity binds one payload to a cycle, kind and normalized recipient scope',()=>{
 const a=input(),b=input();b.scope.receiver=b.scope.receiver.toUpperCase().replace('0X','0x');
 assert.equal(prepareBatchOperation(a).operationId,prepareBatchOperation(b).operationId);
 b.requirements.maxTimeoutSeconds=1;
 assert.equal(prepareBatchOperation(a).operationId,prepareBatchOperation(b).operationId);
 assert.notEqual(prepareBatchOperation(a).payloadDigest,prepareBatchOperation(b).payloadDigest);
 assert.notEqual(prepareBatchOperation(input('synthetic-cycle-02')).operationId,prepareBatchOperation(a).operationId);
});
test('operation rejects wrong payee, token, scheme and unsupported funding actions before admission',()=>{
 for(const modify of [(x:BatchOperationInput)=>{x.paymentPayload.payload.receiver='0x'+'44'.repeat(20);},(x:BatchOperationInput)=>{x.requirements.asset='0x'+'55'.repeat(20);},(x:BatchOperationInput)=>{x.requirements.scheme='exact';},(x:BatchOperationInput)=>{x.paymentPayload.payload.type='deposit';}]){
  const x=input();modify(x);assert.throws(()=>prepareBatchOperation(x));
 }
});
const database=process.env.LAB_BATCH_PG_DATABASE;
test('durable batch runner integration with synthetic provider', {skip:!database},async t=>{
 assert.match(database!,/^lab_batch_[a-z0-9_]+$/);
 const settings={host:process.env.LAB_BATCH_PG_HOST??'/var/run/postgresql',database,user:process.env.LAB_BATCH_PG_USER??'root',max:8,connectionTimeoutMillis:3000};
 const pool=new Pool(settings),peer=new Pool(settings),namespace='runner:'+randomUUID();
 const journal=new PostgresBatchOperationJournal(pool,namespace),other=new PostgresBatchOperationJournal(peer,namespace);await journal.initialize();
 try{
  await t.test('32 competing callers and two journals obtain one provider send',async()=>{
   let sends=0;const provider={settle:async()=>{sends++;return {success:true,transaction:'0x'+'aa'.repeat(32),network:'eip155:8453' as const};}};
   const results=await Promise.all(Array.from({length:32},(_,i)=>executeBatchOperation(i%2?journal:other,provider,input('concurrent-cycle'))));
   assert.equal(sends,1);assert.equal(results.filter(r=>r.sent).length,1);
   const row=await journal.get(prepareBatchOperation(input('concurrent-cycle')).operationId);assert.equal(row!.state,'provider_ack');
   assert.equal((await executeBatchOperation(other,provider,input('concurrent-cycle'))).sent,false);assert.equal(sends,1);
  });
  await t.test('uncertain provider result survives reopen and cannot send again',async()=>{
   let sends=0;const provider={settle:async()=>{sends++;throw new Error('connection lost after possible broadcast');}};
   const x=input('ambiguous-cycle');const r=await executeBatchOperation(journal,provider,x);assert.equal(r.operation!.state,'unknown');
   const reopened=new Pool(settings);try{
    const again=await executeBatchOperation(new PostgresBatchOperationJournal(reopened,namespace),provider,x);assert.equal(again.sent,false);
   }finally{await reopened.end();}
   assert.equal(sends,1);
  });
  await t.test('crash after durable send permit blocks blind recovery even without a provider acknowledgement',async()=>{
   const x=input('crash-after-permit'),prepared=prepareBatchOperation(x);await journal.plan(prepared);assert.ok(await journal.acquire(prepared.operationId));
   let sends=0;const provider={settle:async()=>{sends++;throw new Error('must not send');}};
   const r=await executeBatchOperation(other,provider,x);assert.equal(r.sent,false);assert.equal(r.operation!.state,'inflight');assert.equal(sends,0);
  });
  await t.test('caller mutation while awaiting the database cannot change the prepared wire payload',async()=>{
   const x=input('immutable-wire-cycle');let received:any;
   const wrapper={plan:journal.plan.bind(journal),get:journal.get.bind(journal),recordOutcome:journal.recordOutcome.bind(journal),acquire:async(id:string)=>{x.paymentPayload.payload.receiver='0x'+'77'.repeat(20);return journal.acquire(id);}};
   const provider={settle:async(p:any)=>{received=p;return {success:true,transaction:'0x'+'bb'.repeat(32),network:'eip155:8453' as const};}};
   await executeBatchOperation(wrapper,provider,x);assert.equal(received.payload.receiver,scope.receiver);
  });
  await t.test('changed payload under the same operation identity is refused before another send',async()=>{
   const x=input('conflicting-cycle');let sends=0;const provider={settle:async()=>{sends++;return {success:true,transaction:'0x'+'cc'.repeat(32),network:'eip155:8453' as const};}};
   await executeBatchOperation(journal,provider,x);x.requirements.maxTimeoutSeconds=1;
   await assert.rejects(executeBatchOperation(other,provider,x));assert.equal(sends,1);
  });
  await t.test('valid uppercase provider transaction hash is normalized without claiming finality',async()=>{
   const provider={settle:async()=>({success:true,transaction:'0x'+'AB'.repeat(32),network:'eip155:8453' as const})};
   const r=await executeBatchOperation(journal,provider,input('uppercase-transaction'));assert.equal(r.operation!.state,'provider_ack');
   assert.equal(r.operation!.events.at(-1)!.transactionHash,'0x'+'ab'.repeat(32));
  });
  await t.test('success without a matching chain and transaction remains unknown',async()=>{
   const provider={settle:async()=>({success:true,transaction:'',network:'eip155:8453' as const})};
   const r=await executeBatchOperation(journal,provider,input('empty-transaction'));assert.equal(r.operation!.state,'unknown');
  });
 }finally{await pool.end();await peer.end();}
});
