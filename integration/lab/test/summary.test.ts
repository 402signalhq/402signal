import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../src/summary.js';
import type { RunReport } from '../src/buyer.js';
const run = { run_id: 'one', mode: 'offline', rail: 'base', traffic_class: 'self_test', organic_demand: false,
  capability: 'payload/sha256', routing: 'simulated', delivery: 'validated', seller_settlement: 'simulated', reserved_atomic: '4000', pq_evidence: 'not_checked' } as RunReport;
test('summary separates environments and refuses false organic provenance', () => {
  const s = summarize([run, { ...run, run_id: 'two', mode: 'testnet', routing: 'unknown' }]);
  assert.equal(s.groups.length, 2); assert.equal(s.groups[1]!.unknown_payments, 1); assert.equal(s.organic_demand, false);
  assert.throws(() => summarize([run, run]), /mixed_or_duplicate/);
  assert.throws(() => summarize([{ ...run, traffic_class: 'organic' } as any]), /mixed_or_duplicate/);
});
