import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
const root = resolve(import.meta.dirname, '../..', 'website-evidence');
const read = name => JSON.parse(readFileSync(resolve(root, name), 'utf8'));
const spec = read('openapi.json');
const schema = spec.paths['/route'].post.requestBody.content['application/json'].schema;
const ajv = new Ajv2020({strict: false, validateFormats: false, allErrors: true, coerceTypes: false});
const validate = ajv.compile(schema);
let passed = 0;
const cases = read('schema-cases.json');
const fixture = name => JSON.parse(readFileSync(resolve(root, '../tests/fixtures', name), 'utf8'));
const buyer = (request) => {
  const {merchant_profile, lab_test, ...rest} = request;
  return rest;
};
const baseRequest = buyer(fixture('batch-observation-wire.json')[0].request);
const algoRequest = buyer(fixture('algorand-generic-v5.json').request);
for (const [url, valid] of [
  ['https://merchant.example?contact=a@b', true],
  ['https://merchant.example/?contact=a@b', true],
  ['https://merchant.example/path@name?first=a%2Bb&next=x@y', true],
  ['https://user@merchant.example/path', false],
  ['https://user:pass@merchant.example?contact=a@b', false],
]) {
  cases.push({name: 'exact-url-' + url, request: {...baseRequest, url}, valid});
}
for (const [recipient, valid] of [
  ['0x' + '0'.repeat(40), false],
  ['0x' + '0'.repeat(39) + '1', true],
  [baseRequest.buyer_limits.recipient, true],
]) {
  cases.push({name: 'base-recipient-' + recipient, valid,
    request: {...baseRequest, buyer_limits: {...baseRequest.buyer_limits, recipient}}});
}
for (const [value, valid] of [
  // 14999 fails the two-item lab floor at runtime when that profile is named.
  // Public caps may also match multi-item, so OpenAPI anyOf accepts it.
  ['14999', true], ['15000', true], ['15001', true],
  ['18446744073709551615', true], ['18446744073709551616', false],
  [15000, false], [true, false], ['015000', false], ['+15000', false],
  ['1.5e4', false], ['15000 ', false], ['0', false],
]) {
  cases.push({name: 'algorand-sponsor-' + JSON.stringify(value), valid,
    request: {...algoRequest, buyer_limits: {...algoRequest.buyer_limits,
      max_sponsor_fee_micro_algo: value}}});
}
const nativeBaseRequest = buyer(fixture('base-native-mpp-v5.json').request);
for (const [value, valid] of [['1', true], ['1000', true], ['18446744073709551615', true], ['18446744073709551616', false], [1000, false], ['01000', false], ['0', false]]) {
  cases.push({name:'native-base-amount-'+JSON.stringify(value),valid,request:{...nativeBaseRequest,buyer_limits:{...nativeBaseRequest.buyer_limits,max_call_amount_atomic:value}}});
}
cases.push({name:'native-base-zero-recipient',valid:false,request:{...nativeBaseRequest,buyer_limits:{...nativeBaseRequest.buyer_limits,recipient:'0x'+'0'.repeat(40)}}});
// Public buyers send caps, not a profile. 2–15 hashes with an item cap are atom.
for (const [name, count, dropItemCap, valid] of [
  ['atom-jobs', 2, false, true],
  ['atom-jobs', 3, false, true],
  ['atom-jobs', 15, false, true],
  ['atom-jobs', 16, false, false],
  ['invoice-jobs', 2, true, true],
  ['invoice-jobs', 64, true, true],
  ['invoice-jobs', 65, true, false],
]) {
  const request = structuredClone(algoRequest);
  request.buyer_limits.job_hashes = Array.from({length: count}, (_, i) => i.toString(16).padStart(64, '0'));
  if (dropItemCap) delete request.buyer_limits.max_item_amount_atomic;
  cases.push({name: name + '-' + count, request, valid});
  if (dropItemCap && valid) {
    const withItemCap = structuredClone(request);
    withItemCap.buyer_limits.max_item_amount_atomic = '1000';
    cases.push({name: 'invoice-item-cap-' + count, request: withItemCap, valid: count <= 15});
  }
}

const nativeAlgoRequest = buyer(fixture('algorand-mpp-charge.json')[0].request);
cases.push({name:'native-algo-buyer-fees',request:nativeAlgoRequest,valid:true});
for (const [key,value] of [['fee_payer',false],['recipient','AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ'],['max_amount_atomic','0'],['max_network_fee_micro_algo','18446744073709551616']]) {
  cases.push({name:'native-algo-invalid-'+key,valid:false,request:{...nativeAlgoRequest,buyer_limits:{...nativeAlgoRequest.buyer_limits,[key]:value}}});
}
cases.push({name:'buyer-must-not-send-profile',request:{...nativeAlgoRequest,merchant_profile:'base-mpp-charge-v1'},valid:false});
cases.push({name:'buyer-must-not-send-other-profile',request:{...nativeBaseRequest,merchant_profile:'algorand-mpp-charge-v1'},valid:false});
for (const item of cases) {
  const result = validate(item.request);
  assert.equal(result, item.valid, item.name + ': ' + JSON.stringify(validate.errors));
  passed++;
}
const mcp = read('mcp-input.json');
const validateMcp = ajv.compile(mcp);
assert.equal(validateMcp({need: 'weather', require_route_binding: true}), true);
for (const key of ['probe_request', 'merchant_profile', 'buyer_limits']) {
  assert.equal(validateMcp({need: 'weather', [key]: {}}), false, 'MCP remains unchanged');
}
const bodySchema = schema.properties.probe_request.properties.body.contentSchema;
const body = ajv.compile(bodySchema);
assert.equal(body({query: 'weather', mode: 'one-shot'}), true);
assert.equal(body({query: ' ', mode: 'one-shot'}), false);
assert.equal(body({query: 'x'.repeat(301), mode: 'one-shot'}), false);
assert.equal(body({query: 'weather', mode: 'stream'}), false);
console.log(`PASS ${passed} actual OpenAPI examples/negative cases; unchanged MCP and embedded JSON-body schemas.`);
