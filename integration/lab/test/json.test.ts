import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJson, canonical, atomic, decode64 } from '../src/json.js';
import { utility } from '../src/utilities.js';
for (const raw of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"__proto__":{}}', '{"constructor":1}',
  '{"a":NaN}', '[1,]', '{"a":1,}', '01', '9007199254740992', '1e999', '"\\ud800"', '{}{}', '', '['.repeat(26) + ']'.repeat(26)]) {
  test(`strict JSON rejects ${raw.slice(0, 50)}`, () => assert.throws(() => parseJson(raw)));
}
test('strict JSON and canonical output round trip', () => {
  assert.equal(canonical(parseJson('{"z":[true,null,2.5],"a":"🤖"}')), '{"a":"🤖","z":[true,null,2.5]}');
});
test('body byte limit and array limit', () => {
  assert.throws(() => parseJson('"' + 'x'.repeat(65536) + '"'));
  assert.throws(() => parseJson('[' + Array(4097).fill('0').join(',') + ']'));
});
test('base64 accepts optional padding but rejects ambiguous pad bits', () => {
  assert.equal(decode64('YQ').toString(), 'a'); assert.equal(decode64('YQ==').toString(), 'a');
  for (const s of ['YR==', 'a', 'a*', 'YQ==\n']) assert.throws(() => decode64(s));
});
test('atomic amounts cannot coerce floats, numbers, signs, or leading zero', () => {
  for (const n of [1000, '01000', '+1', '-1', '1.5', true]) assert.throws(() => atomic(n));
  assert.equal(atomic('3000'), 3000n);
});
test('utilities deliver useful deterministic results without HTML rendering', () => {
  assert.equal(utility('json/canonicalize', { value: { b: 2, a: 1 } }).canonical, '{"a":1,"b":2}');
  const t = utility('text/statistics', { text: '🤖 hi\nthere' });
  assert.equal(t.whitespace_delimited_words, 3); assert.equal(t.lines, 2); assert.equal(t.unicode_code_points, 10);
  assert.equal(utility('payload/sha256', { text: 'abc' }).sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('base64 padding is bounded for long malformed and canonical inputs', () => {
  for (const s of ['A'+'='.repeat(32000)+'!', 'A'.repeat(32000)+'===', '='.repeat(32000)])
    assert.throws(() => decode64(s), /invalid_base64/);
  const bytes=Buffer.alloc(16384,7), encoded=bytes.toString('base64');
  assert.deepEqual(decode64(encoded),bytes);
  assert.deepEqual(decode64(encoded.slice(0,-2)),bytes);
});
