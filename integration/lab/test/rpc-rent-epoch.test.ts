import test from 'node:test';
import assert from 'node:assert/strict';
import {parseJson} from '../src/json.js';
test('only RPC rentEpoch metadata may preserve an unsigned 64-bit integer as exact text',()=>{
 const raw='{"result":{"value":{"rentEpoch":18446744073709551615,"lamports":100}}}';
 assert.throws(()=>parseJson(raw),/unsafe_number/);
 const r=parseJson(raw,65536,true);
 assert.equal(r.result.value.rentEpoch,'18446744073709551615');
 assert.equal(r.result.value.lamports,100);
 for(const bad of [
  '{"result":{"value":{"lamports":18446744073709551615}}}',
  '{"result":{"value":{"rentEpoch":18446744073709551616}}}',
  '{"result":{"value":{"rentEpoch":18446744073709551615,"rentEpoch":0}}}',
  '{"amount":18446744073709551615}'
 ])assert.throws(()=>parseJson(bad,65536,true));
});
