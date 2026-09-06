import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { lab } from './helpers.js';
import { RAILS } from '../src/config.js';
import { fixturePayment } from '../src/fixtures.js';
import { paymentIdentity } from '../src/identity.js';
import { encode64, canonical } from '../src/json.js';
import { UTILITIES, example, utility } from '../src/utilities.js';
import { Ledger } from '../src/ledger.js';
import { Seller } from '../src/seller.js';
import { decodeSignedTransaction } from '@x402/avm';
import { encodeSignedTransaction, encodeTransaction } from '@algorandfoundation/algokit-utils/transact';
import { http } from '../src/transport.js';

for (const rail of RAILS) {
  for (const name of UTILITIES) test(`${rail} ${name}: actual HTTP challenge + payment + exact output`, async () => {
    const l = await lab(true); try {
      const url = `${l.config.origin}/${rail}/${name}`, input = example(name);
      const ch = await http(url, 'POST', input);
      assert.equal(ch.status, 402); assert.equal(ch.body.accepts[0].amount, '1000');
      assert.equal(canonical(JSON.parse(Buffer.from(ch.headers.get('PAYMENT-REQUIRED')!, 'base64').toString())), canonical(ch.body));
      assert.deepEqual(Object.keys(ch.body).sort(),
        ['accepts', 'error', 'extensions', 'resource', 'x402Version']);
      assert.deepEqual(Object.keys(ch.body.extensions), ['bazaar']);
      const bazaar = ch.body.extensions.bazaar;
      assert.equal(bazaar.info.input.method, 'POST');
      assert.equal(canonical(bazaar.info.input.body), canonical(input));
      assert.deepEqual(bazaar.schema.properties.input.properties.body.required,
        [name === 'json/canonicalize' ? 'value' : 'text']);
      assert.equal(bazaar.info.output.example.evidence.traffic_class, 'self_test');
      assert.equal(bazaar.info.output.example.evidence.operator_owned, true);
      assert.equal(bazaar.info.output.example.evidence.organic_demand, false);
      assert.match(ch.body.resource.description, /Operator-owned self-test/);
      const payload = fixturePayment(rail, ch.body.accepts[0], 'http-test');
      const paid = await http(url, 'POST', input, { 'PAYMENT-SIGNATURE': encode64(payload) });
      assert.equal(paid.status, 200); assert.equal(canonical(paid.body.result), canonical(utility(name, input)));
      assert.equal(paid.body.billing.settled, false); assert.equal(paid.body.billing.settlement_state, 'simulated');
      assert.equal(paid.body.evidence.organic_demand, false);
      assert.equal(l.facilitators[rail].verifies, 1); assert.equal(l.facilitators[rail].settles, 1);
    } finally { await l.close(); }
  });
  test(`${rail}: paid GET executes advertised example and replays without another settlement`, async () => {
    const l = await lab(true); try {
      const name = 'payload/sha256', url = `${l.config.origin}/${rail}/${name}`;
      const ch = await http(url, 'GET');
      assert.equal(ch.status, 402);
      assert.equal(l.facilitators[rail].settles, 0);
      const payload = fixturePayment(rail, ch.body.accepts[0], 'bound-get');
      const headers = { 'PAYMENT-SIGNATURE': encode64(payload) };
      const paid = await http(url, 'GET', undefined, headers);
      assert.equal(paid.status, 200);
      assert.equal(canonical(paid.body.result), canonical(utility(name, example(name))));
      assert.equal(paid.body.evidence.traffic_class, 'self_test');
      assert.equal(paid.body.evidence.organic_demand, false);
      const again = await http(url, 'GET', undefined, headers);
      assert.equal(canonical(again.body), canonical(paid.body));
      assert.equal(l.facilitators[rail].settles, 1);
    } finally { await l.close(); }
  });
  test(`${rail}: unsigned metadata and signature mutations share economic identity`, async () => {
    const l = await lab(); try {
      const req = l.seller.requirements.get(rail)!, p = fixturePayment(rail, req, 'same');
      const q = structuredClone(p); q.resource = { url: 'https://different.invalid', description: 'MUTABLE', mimeType: 'text/plain' };
      if (rail === 'base') { q.payload.signature = '0x' + '22'.repeat(65); (q.payload.authorization as any).from = (q.payload.authorization as any).from.toUpperCase().replace('0X', '0x'); }
      else if (rail === 'solana') { const bytes = Buffer.from(q.payload.transaction as string, 'base64'); bytes.fill(2, 1, 65); q.payload.transaction = bytes.toString('base64').replace(/=+$/, ''); }
      else { const signed = decodeSignedTransaction((q.payload.paymentGroup as string[])[0]!); signed.sig = new Uint8Array(64).fill(2);
        q.payload.paymentGroup = [Buffer.from(encodeSignedTransaction(signed)).toString('base64').replace(/=+$/, '')]; }
      assert.equal(paymentIdentity(rail, p, req), paymentIdentity(rail, q, req));
      const raw = JSON.stringify(example('payload/sha256'));
      const original = await l.seller.request(rail, 'payload/sha256', raw, encode64(p));
      assert.equal(original.status, 200);
      assert.deepEqual(await l.seller.request(rail, 'payload/sha256', raw, encode64(q)), original);
      assert.equal(l.facilitators[rail].verifies, 1); assert.equal(l.facilitators[rail].settles, 1);
    } finally { await l.close(); }
  });
  test(`${rail}: concurrent requests and restarted connection cannot settle twice`, async () => {
    const l = await lab(), second = new Ledger(l.config.ledgerPath);
    try {
      const s2 = new Seller(l.config, second, l.facilitators); await s2.initialize();
      const p = encode64(fixturePayment(rail, l.seller.requirements.get(rail)!, 'concurrent'));
      const raw = '{"text":"once"}';
      const results = await Promise.all([l.seller.request(rail, 'payload/sha256', raw, p), s2.request(rail, 'payload/sha256', raw, p)]);
      assert.equal(results.filter(o => o.status === 200).length, 1);
      assert.equal(results.filter(o => o.status === 409).length, 1);
      assert.equal((await s2.request(rail, 'payload/sha256', raw, p)).status, 200);
      assert.equal(l.facilitators[rail].settles, 1);
      await assert.rejects(s2.request(rail, 'payload/sha256', '{"text":"different"}', p), /authorization_scope_conflict/);
    } finally { second.close(); await l.close(); }
  });
  for (const settlement of ['throw', 'malformed'] as const) test(`${rail}: ${settlement} settlement stays unknown after restart`, async () => {
    const l = await lab(), second = new Ledger(l.config.ledgerPath);
    try {
      l.facilitators[rail].settlement = settlement;
      const header = encode64(fixturePayment(rail, l.seller.requirements.get(rail)!, settlement)), raw = '{"text":"unknown"}';
      const o = await l.seller.request(rail, 'payload/sha256', raw, header);
      assert.equal(o.status, 503); assert.equal(o.body.billing.settled, null); assert.equal(o.body.billing.settlement_state, 'unknown');
      const restarted = new Seller(l.config, second, l.facilitators); await restarted.initialize();
      assert.deepEqual(await restarted.request(rail, 'payload/sha256', raw, header), o);
      assert.equal(l.facilitators[rail].settles, 1);
      const persisted = JSON.stringify(second.db.prepare('SELECT * FROM payments').all());
      assert(!persisted.includes('SENSITIVE')); assert(!JSON.stringify(o).includes('SENSITIVE'));
    } finally { second.close(); await l.close(); }
  });
  test(`${rail}: invalid inputs become terminal without facilitator action`, async () => {
    const l = await lab(); try {
      const p = encode64(fixturePayment(rail, l.seller.requirements.get(rail)!, 'invalid'));
      const o = await l.seller.request(rail, 'payload/sha256', '{"text":"one","text":"two"}', p);
      assert.equal(o.status, 400); assert.equal(o.body.billing.settled, false);
      assert.deepEqual(await l.seller.request(rail, 'payload/sha256', '{"text":"one","text":"two"}', p), o);
      assert.equal(l.facilitators[rail].verifies, 0); assert.equal(l.facilitators[rail].settles, 0);
    } finally { await l.close(); }
  });
}
test('disk failure before attempted write prevents settlement; reservation stays closed', async () => {
  const l = await lab(); try {
    const p = encode64(fixturePayment('base', l.seller.requirements.get('base')!, 'disk-before'));
    l.ledger.attempting = () => { throw new Error('disk-failure'); };
    await assert.rejects(l.seller.request('base', 'payload/sha256', '{"text":"safe"}', p));
    assert.equal(l.facilitators.base.settles, 0);
    assert.equal((await l.seller.request('base', 'payload/sha256', '{"text":"safe"}', p)).status, 409);
  } finally { await l.close(); }
});
test('disk failure after settle never returns certain unpaid or retries', async () => {
  const l = await lab(); try {
    const p = encode64(fixturePayment('base', l.seller.requirements.get('base')!, 'disk-after'));
    l.ledger.finish = () => { throw new Error('disk-failure'); };
    const o = await l.seller.request('base', 'payload/sha256', '{"text":"safe"}', p);
    assert.equal(o.body.billing.settled, null); assert.equal(o.status, 503);
    assert.equal((await l.seller.request('base', 'payload/sha256', '{"text":"safe"}', p)).status, 409);
    assert.equal(l.facilitators.base.settles, 1);
    assert.equal((l.ledger.summary()[0] as any).state, 'attempted');
  } finally { await l.close(); }
});
for (const verification of ['reject', 'throw'] as const) test(`verify ${verification}: controlled public and durable response`, async () => {
  const l = await lab(); try {
    l.facilitators.base.verification = verification;
    const p = encode64(fixturePayment('base', l.seller.requirements.get('base')!, verification));
    const o = await l.seller.request('base', 'payload/sha256', '{"text":"safe"}', p);
    assert.equal(o.body.billing.settlement_state, 'not_attempted'); assert.equal(l.facilitators.base.settles, 0);
    assert(!JSON.stringify(o).includes('SENSITIVE'));
    assert(!JSON.stringify(l.ledger.db.prepare('SELECT * FROM payments').all()).includes('SENSITIVE'));
  } finally { await l.close(); }
});
test('success response and replay database strip sensitive receipt fields', async () => {
  const l = await lab(); try {
    const p = encode64(fixturePayment('base', l.seller.requirements.get('base')!, 'redact'));
    const o = await l.seller.request('base', 'payload/sha256', '{"text":"safe"}', p);
    const receipt = JSON.parse(Buffer.from(o.headers!['PAYMENT-RESPONSE']!, 'base64').toString());
    assert.deepEqual(Object.keys(receipt).sort(), ['amount', 'network', 'success', 'transaction']);
    assert(!JSON.stringify(l.ledger.db.prepare('SELECT * FROM payments').all()).includes('SENSITIVE'));
  } finally { await l.close(); }
});
test('wrong accepted terms rejected before ledger or verification', async () => {
  const l = await lab(); try {
    for (const patch of [{ amount: '1' }, { network: 'eip155:1' }, { payTo: 'attacker' }, { asset: 'FAKE' }]) {
      const p = fixturePayment('base', structuredClone(l.seller.requirements.get('base')!), 'badterms'); Object.assign(p.accepted, patch);
      await assert.rejects(l.seller.request('base', 'payload/sha256', '{}', encode64(p)), /payment_terms_mismatch/);
    }
    assert.equal(l.facilitators.base.verifies, 0);
  } finally { await l.close(); }
});
test('Algorand signed/unsigned encodings and unsigned paymentIndex do not create fresh authority', async () => {
  const l = await lab(); try {
    const req = l.seller.requirements.get('algorand')!;
    const a = fixturePayment('algorand', req, 'a'), b = fixturePayment('algorand', req, 'b');
    const signed = decodeSignedTransaction((b.payload.paymentGroup as string[])[0]!);
    const unsigned = Buffer.from(encodeTransaction(signed.txn)).toString('base64');
    a.payload.paymentGroup = [...a.payload.paymentGroup as string[], unsigned]; a.payload.paymentIndex = 0;
    const variant = structuredClone(a); variant.payload.paymentGroup = [...a.payload.paymentGroup as string[]];
    (variant.payload.paymentGroup as string[])[1] = (b.payload.paymentGroup as string[])[0]!;
    variant.payload.paymentIndex = 1;
    assert.equal(paymentIdentity('algorand', a, req), paymentIdentity('algorand', variant, req));
  } finally { await l.close(); }
});
