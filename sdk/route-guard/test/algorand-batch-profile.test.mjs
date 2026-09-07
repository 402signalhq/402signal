import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {validateAlgorandBatchProfile as validate} from '../batch-profiles/algorand.mjs';
const v=JSON.parse(fs.readFileSync(new URL('../../../tests/fixtures/algorand-batch-profile.json',import.meta.url)));
test('independent AVM profile matches Python typed manifest',()=>assert.deepEqual(validate(v.envelope,v.context,v.limits),v.expected));
test('every declared manifest field and buyer pin is mandatory',()=>{
 for(const key of Object.keys(v.expected)){const x=structuredClone(v);delete x.envelope.extensions['402signal-atomic-batch'][key];assert.throws(()=>validate(x.envelope,x.context,x.limits));}
 for(const key of Object.keys(v.limits)){const x=structuredClone(v);delete x.limits[key];assert.throws(()=>validate(x.envelope,x.context,x.limits));}
});
test('budget and runtime pin mutations are rejected',()=>{
 for(const [key,value]of Object.entries({max_total_amount_atomic:'1999',max_sponsor_fee_micro_algo:'14999',recipient:v.limits.fee_payer,network:'algorand:testnet',asset:'1',fee_payer:v.limits.recipient,extra:'unknown'})){
  const x=structuredClone(v);x.limits[key]=value;assert.throws(()=>validate(x.envelope,x.context,x.limits));
 }
});
test('method, body, malformed query, checksum, extra protocol and manifest types fail closed',()=>{
 for(const change of [x=>x.context.method='POST',x=>x.context.body_sha256='00'.repeat(32),x=>x.context.url+='&left=duplicate',x=>x.context.url=x.context.url.replace('left=alpha','left=%ZZ'),x=>x.context.url=x.context.url.replace('left=alpha','left=%FF'),x=>x.envelope.extensions.other={},x=>x.envelope.extensions['402signal-atomic-batch'].version=true,x=>x.envelope.accepts[0].extra.other=true]){const x=structuredClone(v);change(x);assert.throws(()=>validate(x.envelope,x.context,x.limits));}
 const x=structuredClone(v),wrong='B'+v.limits.recipient.slice(1,-1)+'A';x.limits.recipient=wrong;x.envelope.accepts[0].payTo=wrong;x.envelope.extensions['402signal-atomic-batch'].recipient=wrong;assert.throws(()=>validate(x.envelope,x.context,x.limits));
});
