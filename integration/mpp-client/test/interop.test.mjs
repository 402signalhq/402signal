import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {privateKeyToAccount} from 'viem/accounts';
import {recoverTypedDataAddress} from 'viem';
import {FileAttemptStore} from '../../../sdk/route-guard/file-store.mjs';
import {prepareBaseX402,BASE_NETWORK,BASE_USDC} from '../index.mjs';

// Published synthetic key, never funded or used outside this test process.
const wallet=privateKeyToAccount('0x'+'11'.repeat(32));
const recipient='0x2222222222222222222222222222222222222222';
const jsonCopy=value=>JSON.parse(JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v));
function fixture(change={}) {
  const request={url:'https://merchant.example/search?query=one',method:'POST',body:new TextEncoder().encode('{"query":"one"}')};
  const accept={scheme:'exact',network:BASE_NETWORK,asset:BASE_USDC,currency:BASE_USDC,amount:'1000',payTo:recipient,maxTimeoutSeconds:60,extra:{name:'USD Coin',version:'2'}};
  const envelope={x402Version:2,resource:{url:request.url,mimeType:'application/json'},accepts:[accept]};
  change.request?.(request);change.envelope?.(envelope);
  const text=JSON.stringify(envelope);
  return {request,challenge:{status:402,bodyText:text,paymentRequired:Buffer.from(text).toString('base64')},expected:{amountAtomic:'1000',recipient,payer:wallet.address},envelope};
}
async function prepared(value=fixture()) {return prepareBaseX402(value);}
function signer(calls) {return {address:wallet.address,async signTypedData(data){calls.push(jsonCopy(data));return wallet.signTypedData(data);}};}

async function durableGate(directory,calls,events,job='job') {
  const store=new FileAttemptStore(directory);
  return {store,authorize:async inspection=>{
    if(!await store.putOnce(job,'submission',{intentDigest:inspection.intentDigest}))return false;
    events.push('durable_claim');
    return {account:{address:wallet.address,async signTypedData(data){
      assert(await store.get(job,'submission'));
      assert(await store.putOnce(job+'-typed','intent',jsonCopy(data)));
      events.push('durable_typed_data');calls.push(jsonCopy(data));
      const signature=await wallet.signTypedData(data);events.push('signature');return signature;
    }}};
  }};
}

test('pure preparation uses pinned mppx without signing, transport or global Fetch mutation',async()=>{
  const before=globalThis.fetch;
  const p=await prepared();
  assert.equal(globalThis.fetch,before);
  assert.equal(p.inspection.protocol,'x402-v2');assert.equal(p.inspection.network,BASE_NETWORK);
  assert.equal(p.inspection.asset,BASE_USDC);assert.equal(p.inspection.expected.amountAtomic,'1000');
  assert.equal(p.fetch,undefined);assert.equal(p.rawFetch,undefined);
  assert(Object.isFrozen(p.inspection.challenge.accepts[0]));
});

test('credential follows durable claim and typed-data record, signs exact Base EIP3009 and attaches only PAYMENT-SIGNATURE',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mpp-explicit-'));
  try {
    const calls=[],events=[];const gate=await durableGate(directory,calls,events);
    const before=globalThis.fetch;const p=await prepared();
    const result=await p.createPaymentPayload(gate);
    assert.equal(result.status,'credential_created');assert.equal(result.header.name,'PAYMENT-SIGNATURE');
    assert.equal(result.chainConfirmation,'not_checked');assert.equal(result.newPaymentAllowed,false);
    assert.deepEqual(events,['durable_claim','durable_typed_data','signature']);assert.equal(calls.length,1);
    const data=calls[0];assert.equal(data.primaryType,'TransferWithAuthorization');
    assert.equal(data.domain.chainId,8453);assert.equal(data.domain.verifyingContract,BASE_USDC);
    assert.equal(data.message.to,recipient);assert.equal(data.message.value,'1000');
    assert.equal(BigInt(data.message.validBefore)-BigInt(data.message.validAfter),660n);
    assert.equal(await recoverTypedDataAddress({...data,signature:result.paymentPayload.payload.signature}),wallet.address);
    assert.equal(result.paymentPayload.payload.authorization.nonce,data.message.nonce);
    assert.equal(globalThis.fetch,before);
    assert(await gate.store.putOnce('job','authorization',result));
    await assert.rejects(p.createPaymentPayload(gate),/credential_attempt_consumed/);
    assert.equal(calls.length,1);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('explicit decline and missing durable gate never create a credential',async()=>{
  const p=await prepared();assert.deepEqual(await p.createPaymentPayload({authorize:()=>false}),{status:'declined',newPaymentAllowed:false});
  await assert.rejects(p.createPaymentPayload({authorize:()=>true}),/credential_attempt_consumed/);
  await assert.rejects((await prepared()).createPaymentPayload({}),/durable_authorization_gate_required/);
});

test('concurrent callers issue only one credential from the prepared snapshot',async()=>{
  const p=await prepared(),calls=[];
  const results=await Promise.allSettled(Array.from({length:12},()=>p.createPaymentPayload({authorize:()=>({account:signer(calls)})})));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(calls.length,1);
});

test('lost response and reconstruction cannot issue another credential under the same durable job',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mpp-restart-'));
  try {
    const calls=[],events=[];let gate=await durableGate(directory,calls,events);
    const result=await (await prepared()).createPaymentPayload(gate);
    assert(await gate.store.putOnce('job','authorization',result));
    let sends=0;
    const explicitTransport=async()=>{sends++;throw new Error('lost_response');};
    await assert.rejects(explicitTransport(result.header),/lost_response/);
    gate=await durableGate(directory,calls,events);
    const later=await (await prepared()).createPaymentPayload(gate);
    assert.equal(later.status,'declined');assert.equal(calls.length,1);assert.equal(sends,1);
    assert.deepEqual(jsonCopy(await gate.store.get('job','authorization')),jsonCopy(result));
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('unknown signer result is consumed and durable reconstruction refuses another signature',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mpp-unknown-'));
  try {
    const store=new FileAttemptStore(directory);let calls=0;
    const authorize=async inspection=>{
      if(!await store.putOnce('job','submission',{intentDigest:inspection.intentDigest}))return false;
      return {account:{address:wallet.address,signTypedData:async()=>{calls++;throw new Error('wallet outcome unknown');}}};
    };
    const p=await prepared();await assert.rejects(p.createPaymentPayload({authorize}),/credential_outcome_unknown/);
    assert.equal((await (await prepared()).createPaymentPayload({authorize})).status,'declined');assert.equal(calls,1);
  } finally {await rm(directory,{recursive:true,force:true});}
});

for(const [label,mutate] of [
  ['amount',v=>v.accepts[0].amount='1001'],['recipient',v=>v.accepts[0].payTo='0x3333333333333333333333333333333333333333'],
  ['asset',v=>v.accepts[0].asset='0x4444444444444444444444444444444444444444'],
  ['chain',v=>v.accepts[0].network='eip155:1'],['scheme',v=>v.accepts[0].scheme='batch-settlement'],
  ['permit2',v=>v.accepts[0].extra.assetTransferMethod='permit2'],['token domain',v=>v.accepts[0].extra.name='Fake USDC'],
  ['resource',v=>v.resource.url+='&changed=1'],['duplicate offer',v=>v.accepts.push({...v.accepts[0]})],
])test(label+' cannot bypass explicit expected terms',async()=>{await assert.rejects(prepared(fixture({envelope:mutate})));});

test('raw duplicate JSON keys and header/body disagreement fail before mppx normalization',async()=>{
  const v=fixture();v.challenge.bodyText=v.challenge.bodyText.replace('"x402Version":2','"x402Version":2,"x402Version":2');
  v.challenge.paymentRequired=Buffer.from(v.challenge.bodyText).toString('base64');await assert.rejects(prepared(v),/invalid_challenge_json/);
  const changed=fixture();changed.challenge.bodyText=changed.challenge.bodyText.replace('"1000"','"1001"');
  await assert.rejects(prepared(changed),/challenge_channels_disagree/);
});

test('native MPP and normalization that silently drops resource/extension terms are rejected',async()=>{
  const native=fixture();native.challenge.wwwAuthenticate='Payment realm="merchant"';await assert.rejects(prepared(native),/native_mpp_unsupported/);
  await assert.rejects(prepared(fixture({envelope:v=>v.resource.opaque='not in reviewed schema'})),/normalization_changed_offer/);
  await assert.rejects(prepared(fixture({envelope:v=>v.extensions={mppx:{info:{},schema:{}}}})),/mppx_nonce_extension_unsupported/);
  await assert.rejects(prepared(fixture({envelope:v=>v.extensions={other:{info:{},schema:{},opaque:true}}})),/normalization_changed_offer/);
});

test('full exact URL/method/body are snapshotted and guarded before credential issuance',async()=>{
  const original=fixture(),p=await prepared(original);const approved=p.inspection;
  original.request.body.fill(0);original.request.url='https://changed.example/';original.expected.amountAtomic='1';
  assert.equal(approved.request.url,'https://merchant.example/search?query=one');
  assert.equal(Buffer.from(approved.request.bodyBase64,'base64').toString(),'{"query":"one"}');
  for(const make of [v=>{v.request.body=new TextEncoder().encode('{"query":"two"}');},v=>{v.request.method='GET';v.request.body=new Uint8Array();}]) {
    const other=fixture();make(other);const changed=await prepared(other);let calls=0;
    const outcome=await changed.createPaymentPayload({authorize:inspection=>{
      if(inspection.intentDigest!==approved.intentDigest)return false;
      calls++;return {account:wallet};
    }});
    assert.equal(outcome.status,'declined');assert.equal(calls,0);
  }
});

test('expired offer and wrong payer never reach signer',async()=>{
  const p=await prepared();const savedNow=Date.now;
  try {Date.now=()=>p.inspection.expiresAt;await assert.rejects(p.createPaymentPayload({authorize:()=>({account:wallet})}),/offer_expired/);}
  finally {Date.now=savedNow;}
  await assert.rejects((await prepared()).createPaymentPayload({authorize:()=>({account:{address:recipient,signTypedData:()=>assert.fail('wrong signer')}})}),/guarded_account_required/);
});

test('unsupported request shape, credentials in URLs and oversized challenge are bounded',async()=>{
  await assert.rejects(prepared(fixture({request:r=>r.url='https://name:password@merchant.example/'})),/invalid_request/);
  await assert.rejects(prepared(fixture({request:r=>r.method='DELETE'})),/invalid_request/);
  const large=fixture();large.challenge.paymentRequired='A'.repeat(32769);await assert.rejects(prepared(large),/invalid_payment_required/);
});

test('Base selection works among existing router multi-rail offers',async()=>{
  const p=await prepared(fixture({envelope:v=>v.accepts.unshift({scheme:'exact',network:'solana:any',asset:'other'})}));
  assert.equal(p.inspection.selectedIndex,1);const calls=[];
  assert.equal((await p.createPaymentPayload({authorize:()=>({account:signer(calls)})})).paymentPayload.accepted.network,BASE_NETWORK);
  assert.equal(calls.length,1);
});


test('reviewed 300-second seller offers preserve validity and 60-second preparation freshness',async()=>{
  const p=await prepared(fixture({envelope:v=>v.accepts[0].maxTimeoutSeconds=300})),calls=[];
  const out=await p.createPaymentPayload({authorize:()=>({account:signer(calls)})});
  assert.equal(out.paymentPayload.accepted.maxTimeoutSeconds,300);
  assert.equal(p.inspection.expiresAt-p.inspection.observedAt,60000);
  assert.equal(BigInt(calls[0].message.validBefore)-BigInt(calls[0].message.validAfter),900n);
  await assert.rejects(prepared(fixture({envelope:v=>v.accepts[0].maxTimeoutSeconds=301})),/unsupported_timeout/);
});

test('queryless resource metadata only permits exact-base GET with nonempty query and empty body',async()=>{
  const make=()=>fixture({request:r=>{r.method='GET';r.body=new Uint8Array();},envelope:v=>{v.resource.url='https://merchant.example/search';v.accepts[0].maxTimeoutSeconds=300;}});
  const v=make(),p=await prepared(v),calls=[];
  assert.equal(p.inspection.request.url,'https://merchant.example/search?query=one');
  assert.equal((await p.createPaymentPayload({authorize:()=>({account:signer(calls)})})).paymentPayload.resource.url,'https://merchant.example/search');
  const post=make();post.request.method='POST';await assert.rejects(prepared(post),/invalid_challenge/);
  const path=make();path.request.url='https://merchant.example/other?query=one';await assert.rejects(prepared(path),/invalid_challenge/);
  const empty=make();empty.request.url='https://merchant.example/search?';await assert.rejects(prepared(empty),/invalid_challenge/);
});

test('alternate challenge channel conflicts and unreviewed raw header containers fail closed',async()=>{
  const okay=fixture();okay.challenge.xPaymentRequired=okay.challenge.paymentRequired;await prepared(okay);
  const bad=fixture();bad.challenge.xPaymentRequired=fixture({envelope:v=>v.accepts[0].amount='9'}).challenge.paymentRequired;
  await assert.rejects(prepared(bad),/challenge_channels_disagree/);
  const raw=fixture();raw.challenge.headers={'WWW-Authenticate':'Payment native'};
  await assert.rejects(prepared(raw),/unsupported_challenge_fields/);
});


test('empty discovery extension marker is explicitly restored without discarding nonempty terms',async()=>{
  const p=await prepared(fixture({envelope:v=>v.extensions={bazaar:{}}})),calls=[];
  const made=await p.createPaymentPayload({authorize:()=>({account:signer(calls)})});
  assert.deepEqual(jsonCopy(made.paymentPayload.extensions),{bazaar:{}});
  assert.deepEqual(JSON.parse(Buffer.from(made.header.value,'base64')).extensions,{bazaar:{}});
  assert.equal(calls.length,1);
});
