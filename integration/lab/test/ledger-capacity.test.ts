import test from 'node:test';
import assert from 'node:assert/strict';
import { lab } from './helpers.js';
import { encode64 } from '../src/json.js';
import { fixturePayment } from '../src/fixtures.js';

test('rejected verification never consumes durable payment capacity', async () => {
  const l = await lab();
  try {
    l.facilitators.base.verification = 'reject';
    for (let i=0; i<20; i++) {
      const p = encode64(fixturePayment('base', l.seller.requirements.get('base')!, `reject-${i}`));
      assert.equal((await l.seller.request('base', 'payload/sha256', '{"text":"fixture"}', p)).status, 402);
    }
    assert.deepEqual(l.ledger.summary(), []);
    assert.equal(l.facilitators.base.settles, 0);
  } finally { await l.close(); }
});

test('full ledger preserves existing outcome and incomplete recovery', async () => {
  const l = await lab();
  try {
    const p = encode64(fixturePayment('base', l.seller.requirements.get('base')!, 'capacity'));
    const first = await l.seller.request('base', 'payload/sha256', '{"text":"fixture"}', p);
    assert.equal(first.status, 200);
    l.ledger.reserve('pending', 'scope');
    const insert = l.ledger.db.prepare('INSERT INTO payments VALUES (?, ?, ?, NULL, ?)');
    l.ledger.db.exec('BEGIN');
    for (let i=2; i<10000; i++) insert.run(`fixture-${i}`, 'scope', 'unknown', Date.now());
    l.ledger.db.exec('COMMIT');
    assert.equal(l.ledger.capacity().ready, false);
    assert.deepEqual(await l.seller.request('base', 'payload/sha256', '{"text":"fixture"}', p), first);
    assert.equal(l.ledger.reserve('pending', 'scope').outcome!.status, 409);
    assert.throws(() => l.ledger.reserve('new', 'scope'), /ledger_capacity_reached/);
    assert.equal(l.facilitators.base.settles, 1);
  } finally { await l.close(); }
});
