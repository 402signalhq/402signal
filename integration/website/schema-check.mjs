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
for (const item of read('schema-cases.json')) {
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
