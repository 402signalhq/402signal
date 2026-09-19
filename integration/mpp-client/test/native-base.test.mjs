import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Challenge,Credential} from 'mppx';
import {privateKeyToAccount} from 'viem/accounts';
import fs from 'node:fs';
import {prepareNativeBaseMpp,prepareVerifiedNativeBaseMpp} from '../native-base.mjs';
const usdc='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',recipient='0x1111111111111111111111111111111111111111';
const account=privateKeyToAccount('0x'+'01'.repeat(32));
const fixture=(change={})=>{
 const timestamp=Date.parse('2026-09-08T17:00:00Z');
 const c={id:'synthetic-native-base',realm:'merchant.example',method:'evm',intent:'charge',expires:'2026-09-08T17:01:00Z',request:{amount:'1000',currency:usdc,recipient,methodDetails:{chainId:8453,credentialTypes:['authorization'],decimals:6}},...change};
 return {request:{url:'https://merchant.example?contact=a@b',method:'GET',body:new Uint8Array()},challenge:{status:402,wwwAuthenticate:Challenge.serialize(c)},policy:{network:'eip155:8453',asset:usdc,recipient,payer:account.address,maxAmountAtomic:'1000'},now:()=>timestamp};
};
test('actual pinned native MPP SDK authorizes once with no network or automatic transmission',async()=>{
 const f=fixture();let signed=0,claimed=0,network=0;const original=globalThis.fetch;
 globalThis.fetch=async()=>{network++;throw new Error('network forbidden');};
 try{
  const p=prepareNativeBaseMpp(f);assert.equal(signed,0);assert.equal(p.inspection.request.url,f.request.url);
  const result=await p.createCredential({authorize:async()=>{claimed++;return {...account,signTypedData:async d=>{signed++;return account.signTypedData(d);}};}});
  assert.equal(Credential.deserialize(result.headerValue).payload.value,'1000');assert.equal(claimed,1);assert.equal(signed,1);assert.equal(network,0);
  await assert.rejects(p.createCredential({authorize:async()=>account}),/already_claimed/);
 }finally{globalThis.fetch=original;}
});
for(const [name,change] of Object.entries({chain:f=>f.request.methodDetails.chainId=1,asset:f=>f.request.currency=recipient,recipient:f=>f.request.recipient='0x2222222222222222222222222222222222222222',split:f=>f.request.methodDetails.splits=[{amount:'1',recipient}],zero:f=>f.request.amount='0',noncanonical:f=>f.request.amount='01000',over_budget:f=>f.request.amount='1001',wrong_method:f=>f.method='tempo',wrong_realm:f=>f.realm='other.example'})){
 test('rejects '+name+' before signing',()=>{const f=fixture();const c=Challenge.deserialize(f.challenge.wwwAuthenticate);change(c);f.challenge.wwwAuthenticate=Challenge.serialize(c);assert.throws(()=>prepareNativeBaseMpp(f));});
}
test('duplicate and trailing schemes reject',()=>{for(const suffix of [', id="again"',', Basic realm="x"']){const f=fixture();f.challenge.wwwAuthenticate+=suffix;assert.throws(()=>prepareNativeBaseMpp(f));}});
test('expired during approval cannot sign',async()=>{const f=fixture();let time=f.now();f.now=()=>time;const p=prepareNativeBaseMpp(f);await assert.rejects(p.createCredential({authorize:async()=>{time+=61000;return account;}}),/expired/);});
test('ambiguous failed approval remains consumed',async()=>{const p=prepareNativeBaseMpp(fixture());await assert.rejects(p.createCredential({authorize:async()=>{throw new Error('unknown');}}),/unknown/);await assert.rejects(p.createCredential({authorize:async()=>account}),/already_claimed/);});
test('POST needs matching body digest',()=>{const f=fixture();f.request.method='POST';f.request.body=new TextEncoder().encode('{}');assert.throws(()=>prepareNativeBaseMpp(f),/body_digest/);});

test('explicit empty payment header is refused before durable authority or signing',async()=>{
 const f=fixture();f.challenge.wwwAuthenticate+=', header=""';let claims=0,signs=0;
 await assert.rejects(async()=>prepareNativeBaseMpp(f).createCredential({authorize:async()=>{claims++;return {...account,signTypedData:async d=>{signs++;return account.signTypedData(d);}};}}));
 assert.equal(claims,0);assert.equal(signs,0);
});

test('multi-offer original selection preserves economic nonce and never falls back after signing failure',async()=>{
 const f=fixture(), chosen=f.challenge.wwwAuthenticate;
 const c=Challenge.deserialize(chosen);
 const other=Challenge.serialize({...c,id:'celo',request:{...c.request,methodDetails:{...c.request.methodDetails,chainId:42220}}});
 const tempo=Challenge.serialize({...c,id:'tempo',method:'tempo',description:'commas, and quotes'});
 const single=prepareNativeBaseMpp(f);
 f.challenge={...f.challenge,bodyText:'{"altPayment":{"type":"proof-of-work"}}',paymentRequired:'e30=',wwwAuthenticate:[tempo,other,chosen].join(', ')};
 const multi=prepareNativeBaseMpp(f);
 assert.equal(multi.authorizationId,single.authorizationId);
 assert.notEqual(multi.inspection.responseSha256,single.inspection.responseSha256);
 assert.equal(multi.inspection.selectedChallengeId,c.id);
 const result=await multi.createCredential({authorize:async()=>account});
 assert.equal(Credential.deserialize(result.headerValue).challenge.id,c.id);
 let attempts=0;
 const failing=prepareNativeBaseMpp(f);
 await assert.rejects(failing.createCredential({authorize:async()=>({...account,signTypedData:async()=>{attempts++;throw Error('synthetic signer failure');}})}),/synthetic signer failure/);
 assert.equal(attempts,1);
 await assert.rejects(failing.createCredential({authorize:async()=>account}),/already_claimed/);
 for(const wwwAuthenticate of [[chosen,other,tempo].join(', '),[other,chosen,tempo].join(', ')]){
  assert.equal(prepareNativeBaseMpp({...f,challenge:{...f.challenge,wwwAuthenticate}}).authorizationId,single.authorizationId);
 }
 for(const wwwAuthenticate of [chosen+', '+chosen,other+', '+chosen+', '+chosen]){
  assert.throws(()=>prepareNativeBaseMpp({...f,challenge:{...f.challenge,wwwAuthenticate}}));
 }
});

test('signed multi-offer proof pins selected identity, not only equal price and recipient',()=>{
 const v=JSON.parse(fs.readFileSync(new URL('../../../tests/fixtures/base-native-mpp-multi-v5.json',import.meta.url)));
 const routeEvidence={routeRequestJson:JSON.stringify(v.request),routeResponseJson:JSON.stringify(v.response),challenge:v.challenge,trustedLogVkey:v.trusted_vkey,now:v.now};
 const limits=v.request.buyer_limits;
 const options={routeEvidence,request:{url:v.request.url,method:'GET',body:new Uint8Array()},challenge:v.challenge,policy:{network:limits.network,asset:limits.asset,recipient:limits.recipient,payer:account.address,realm:limits.realm,maxAmountAtomic:limits.max_call_amount_atomic},now:()=>v.now*1000};
 assert.equal(prepareVerifiedNativeBaseMpp(options).inspection.selectedChallengeId,'base-native-synthetic');
 assert.throws(()=>prepareVerifiedNativeBaseMpp({...options,policy:{...options.policy,realm:'other.example'}}),/native_observation_selection_mismatch/);
 for(const key of ['bodyText','paymentRequired','wwwAuthenticate']){
   assert.throws(()=>prepareVerifiedNativeBaseMpp({...options,challenge:{...v.challenge,[key]:v.challenge[key]+' '}}));
 }
});
