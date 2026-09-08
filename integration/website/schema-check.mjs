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
const baseRequest = fixture('batch-observation-wire.json')[0].request;
const algoRequest = fixture('algorand-generic-v5.json').request;
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
  ['14999', false], ['15000', true], ['15001', true],
  ['18446744073709551615', true], ['18446744073709551616', false],
  [15000, false], [true, false], ['015000', false], ['+15000', false],
  ['1.5e4', false], ['15000 ', false], ['0', false],
]) {
  cases.push({name: 'algorand-sponsor-' + JSON.stringify(value), valid,
    request: {...algoRequest, buyer_limits: {...algoRequest.buyer_limits,
      max_sponsor_fee_micro_algo: value}}});
}
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
