import { assert, canonical, digest, object, text } from './json.js';
export const UTILITIES = ['json/canonicalize', 'text/statistics', 'payload/sha256'] as const;
export type Utility = typeof UTILITIES[number];
export function utility(name: Utility, input: unknown) {
  const x = object(input);
  if (name === 'json/canonicalize') {
    assert('value' in x && Object.keys(x).length === 1, 'expected_value');
    const normalized = canonical(x.value);
    return { canonical: normalized, sha256: digest(normalized), utf8_bytes: Buffer.byteLength(normalized) };
  }
  if (name === 'text/statistics') {
    assert(Object.keys(x).length === 1, 'expected_text'); const value = text(x.text, 16384);
    return { unicode_code_points: Array.from(value).length, utf8_bytes: Buffer.byteLength(value),
      whitespace_delimited_words: value.trim() ? value.trim().split(/\s+/u).length : 0,
      lines: value ? value.split(/\r\n|\n|\r/).length : 0, sha256: digest(value) };
  }
  assert(Object.keys(x).length === 1, 'expected_text'); const value = text(x.text, 16384);
  return { algorithm: 'sha256', encoding: 'utf8', sha256: digest(value), utf8_bytes: Buffer.byteLength(value) };
}
export function example(name: Utility) {
  return name === 'json/canonicalize' ? { value: { z: 2, a: 1 } } : { text: '402Signal lab\nHello world' };
}
