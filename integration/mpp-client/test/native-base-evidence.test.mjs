import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {prepareNativeBaseMpp,prepareVerifiedNativeBaseMpp} from '../native-base.mjs';import {verifyBatchRoute} from '../../../sdk/route-guard/batch.mjs';import {privateKeyToAccount} from 'viem/accounts';
const v=JSON.parse(fs.readFileSync(new URL('../../../tests/fixtures/base-native-mpp-v5.json',import.meta.url)));
const account=privateKeyToAccount('0x'+'01'.repeat(32));
const options=()=>({request:{url:v.request.url,method:'GET',body:new Uint8Array()},challenge:v.challenge,policy:{network:v.request.buyer_limits.network,asset:v.request.buyer_limits.asset,recipient:v.request.buyer_limits.recipient,payer:account.address,maxAmountAtomic:'1000'},now:()=>v.now*1000,routeEvidence:{routeResponseJson:JSON.stringify(v.response),routeRequestJson:JSON.stringify(v.request),trustedLogVkey:v.trusted_vkey,challenge:v.challenge}});
test('actual mppx challenge -> Python signed v5 -> offline verifier -> guarded native credential',async()=>{const p=prepareVerifiedNativeBaseMpp(options());let claims=0;await p.createCredential({authorize:async()=>{claims++;return account;}});assert.equal(claims,1);});
test('signing stops when the routing evidence expires, even inside the merchant expiry (S3)',async()=>{
 // The verified wrapper hands the evidence deadline to the deferred credential.
 const o=options();const p=prepareVerifiedNativeBaseMpp(o);
 assert.equal(p.inspection.evidenceExpiresAt,verifyBatchRoute({...o.routeEvidence,now:v.now}).expires_at*1000);
 // The unit under test: an evidence deadline that falls before the merchant's.
 const {routeEvidence,...plain}=options();let t=v.now*1000;const signer=()=>({address:account.address,signTypedData:async d=>{signs++;return account.signTypedData(d);}});let claims=0,signs=0;
 const q=prepareNativeBaseMpp({...plain,now:()=>t,evidenceExpiresAt:v.now*1000+5000});
 assert.ok(q.inspection.expiresAt>q.inspection.evidenceExpiresAt);
 t=v.now*1000+6000;
 await assert.rejects(()=>q.createCredential({authorize:async()=>{claims++;return signer();}}),/expired_route_evidence/);
 assert.equal(claims,0);assert.equal(signs,0);
 // A delay inside authorize past the evidence deadline also stops before the signer.
 t=v.now*1000;const r=prepareNativeBaseMpp({...plain,now:()=>t,evidenceExpiresAt:v.now*1000+5000});
 await assert.rejects(()=>r.createCredential({authorize:async()=>{t=v.now*1000+5001;return signer();}}),/expired_route_evidence/);
 assert.equal(signs,0);
 // Evidence already expired at preparation is refused outright; fresh evidence still signs once.
 assert.throws(()=>prepareNativeBaseMpp({...plain,now:()=>v.now*1000,evidenceExpiresAt:v.now*1000}),/expired_route_evidence/);
 t=v.now*1000;const s=prepareNativeBaseMpp({...plain,now:()=>t,evidenceExpiresAt:v.now*1000+5000});
 await s.createCredential({authorize:async()=>signer()});assert.equal(signs,1);
});
test('evidence and caller request mutations stop before durable authorization',()=>{for(const change of [o=>o.request.url+='&changed=1',o=>o.request.method='POST',o=>o.routeEvidence.trustedLogVkey+='wrong',o=>o.challenge={...o.challenge,wwwAuthenticate:o.challenge.wwwAuthenticate.replace('base-native-synthetic','other')}]){const o=options();change(o);assert.throws(()=>prepareVerifiedNativeBaseMpp(o));}});
