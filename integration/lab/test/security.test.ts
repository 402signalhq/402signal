import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { lab } from './helpers.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { Ledger } from '../src/ledger.js';
import { http, RemoteFacilitator, safeReceipt } from '../src/transport.js';
import { fixturePayment } from '../src/fixtures.js';
import { encode64 } from '../src/json.js';

for (const path of ['/data', '/data/seller.sqlite', '/.env', '/config/offline.json', '/%2e%2e/package.json', '/base/payload/sha256?token=secret', '/admin/fault']) {
  test(`no private file/fault endpoint at ${path}`, async () => {
    const l = await lab(true); try { assert.equal((await http(l.config.origin + path, 'GET')).status, 404); }
    finally { await l.close(); }
  });
}
test('health, catalog and GET probes create no settlement records', async () => {
  const l = await lab(true); try {
    assert.equal((await http(l.config.origin + '/health', 'GET')).status, 200);
    const cat = await http(l.config.origin + '/catalog.json', 'GET');
    assert.equal(cat.body.resources.length, 9); assert.equal(cat.body.organic_demand, false);
    assert.equal(cat.body.directory_submission, 'manual_opt_in_only');
    const ch = await http(l.config.origin + '/base/payload/sha256', 'GET'); assert.equal(ch.status, 402);
    assert.equal(ch.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal((await http(l.config.origin + '/base/payload/sha256', 'HEAD')).status, 402);
    assert.deepEqual(l.ledger.summary(), []);
  } finally { await l.close(); }
});
test('body content type, compression and size rejected without payment', async () => {
  const l = await lab(true); try {
    const u = l.config.origin + '/base/payload/sha256';
    assert.equal((await http(u, 'POST', {}, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await http(u, 'POST', {}, { 'Content-Encoding': 'gzip' })).status, 415);
    assert.equal((await http(u, 'POST', { text: 'x'.repeat(66000) })).status, 413);
    assert.equal(l.facilitators.base.verifies, 0);
  } finally { await l.close(); }
});
test('duplicate payment headers rejected at raw HTTP boundary', async () => {
  const l = await lab(true); try {
    const status = await new Promise<number>((resolve, reject) => {
      const r = request(l.config.origin + '/base/payload/sha256', { method: 'POST', headers: [
        'Content-Type', 'application/json', 'PAYMENT-SIGNATURE', 'e30=', 'payment-signature', 'e30=',
      ] }, res => { res.resume(); resolve(res.statusCode!); }); r.on('error', reject); r.end('{}');
    });
    assert.equal(status, 400); assert.equal(l.facilitators.base.verifies, 0);
  } finally { await l.close(); }
});
test('truncated wire transactions and type-confused payment bodies fail before verification', async () => {
  const l = await lab(true); try {
    for (const rail of ['base', 'solana', 'algorand'] as const) {
      const p = fixturePayment(rail, l.seller.requirements.get(rail)!, 'malformed');
      p.payload = rail === 'base' ? { authorization: [], signature: 1 } : rail === 'solana' ? { transaction: 'YQ==' } : { paymentGroup: ['YQ=='], paymentIndex: true };
      const r = await http(`${l.config.origin}/${rail}/payload/sha256`, 'POST', { text: 'x' }, { 'PAYMENT-SIGNATURE': encode64(p) });
      assert(r.status >= 400); assert.equal(l.facilitators[rail].verifies, 0); assert.equal(l.facilitators[rail].settles, 0);
    }
  } finally { await l.close(); }
});
test('outbound transport refuses redirects and bounds response bytes', async () => {
  let forbidden = 0;
  const app = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(307, { Location: '/target' }); res.end(); }
    else if (req.url === '/target') { forbidden++; res.end('{}'); }
    else if (req.url === '/large') { res.setHeader('Content-Length', '300000'); res.end(' '.repeat(300000)); }
    else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('"'); res.end('x'.repeat(270000) + '"'); }
  });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const u = `http://127.0.0.1:${(app.address() as any).port}`;
  try {
    await assert.rejects(http(u + '/redirect', 'POST', {})); assert.equal(forbidden, 0);
    await assert.rejects(http(u + '/large', 'GET'), /response_too_large/);
    await assert.rejects(http(u + '/chunked', 'GET'), /response_too_large/);
  } finally { await new Promise<void>(r => { app.close(() => r()); app.closeAllConnections(); }); }
});
test('facilitator transport sends exactly one POST on failure; never retries', async () => {
  const l = await lab(); try {
    let calls = 0;
    const f = new RemoteFacilitator('https://facilitator.example', async (_u, method) => {
      calls++; assert.equal(method, 'POST'); throw new Error('raw_sensitive_message');
    });
    const req = l.seller.requirements.get('base')!;
    await assert.rejects(f.settle(fixturePayment('base', req, 'transport'), req)); assert.equal(calls, 1);
    for (const v of [{ success: 'true' }, { success: false }, { success: true, network: 'eip155:1' },
      { success: true, network: req.network, transaction: '0x' + 'a'.repeat(64), amount: '999' }]) assert.throws(() => safeReceipt('base', v, req));
  } finally { await l.close(); }
});
test('live configuration gates and separate-ledger boundary', () => {
  const c = loadConfig();
  assert.throws(() => validateConfig({ ...c, host: '0.0.0.0' }, {}), /unsafe_bind/);
  assert.throws(() => validateConfig({ ...c, ledgerPath: '/data/live402-replay.sqlite' }, {}), /separate_ledger_required/);
  assert.throws(() => validateConfig({ ...c, mode: 'testnet', origin: 'https://lab.example' }, {}), /network_not_authorized/);
  assert.throws(() => validateConfig({ ...c, mode: 'mainnet', origin: 'https://lab.example' }, { LAB_ALLOW_NETWORK: '1' }), /mainnet_not_authorized/);
});
test('foreign database is refused without removing or changing existing rows', async () => {
  const l = await lab(); try {
    const path = join(l.dir, 'foreign.sqlite'), db = new DatabaseSync(path);
    db.exec('CREATE TABLE settle_ledger (id INTEGER); INSERT INTO settle_ledger VALUES (344)'); db.close();
    assert.throws(() => new Ledger(path), /foreign_database_refused/);
    const ro = new DatabaseSync(path, { readOnly: true });
    assert.equal((ro.prepare('SELECT id FROM settle_ledger').get() as any).id, 344);
    assert.equal((ro.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get() as any).n, 1); ro.close();
    assert.equal(statSync(l.config.ledgerPath).mode & 0o777, 0o600);
  } finally { await l.close(); }
});
test('concurrent spend reservations across connections share a hard cap', async () => {
  const l = await lab(), first = new Ledger(join(l.dir, 'spend.sqlite')), second = new Ledger(join(l.dir, 'spend.sqlite'));
  try {
    const r = await Promise.allSettled([Promise.resolve().then(() => first.reserveSpend('a', 'base', '4000', '4000')),
      Promise.resolve().then(() => second.reserveSpend('b', 'base', '4000', '4000'))]);
    assert.equal(r.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(r.filter(x => x.status === 'rejected').length, 1);
  } finally { first.close(); second.close(); await l.close(); }
});
test('new OS process preserves attempted authorization and reserved budget after abrupt exit', async () => {
  const l = await lab();
  try {
    const path = join(l.dir, 'crash.sqlite');
    const script = `import {Ledger} from ${JSON.stringify(new URL('../src/ledger.js', import.meta.url).href)};
      const ledger = new Ledger(process.argv[1]); ledger.reserve('economic-id', 'scope'); ledger.attempting('economic-id');
      ledger.reserveSpend('run-id','base','4000','4000'); process.exit(73);`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, path], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 73);
    const restarted = new Ledger(path);
    try {
      const r = restarted.reserve('economic-id', 'scope'); assert.equal(r.run, false);
      assert.equal(r.outcome!.body.billing.settled, null);
      assert.throws(() => restarted.reserveSpend('run-again', 'base', '4000', '4000'), /spend_cap_exceeded/);
    } finally { restarted.close(); }
  } finally { await l.close(); }
});
test('generated OpenAPI describes every resource and unknown settlement honestly', async () => {
  const l = await lab(true); try {
    const r = await http(l.config.origin + '/openapi.json', 'GET'); assert.equal(r.status, 200);
    assert.equal(r.body.openapi, '3.1.0'); assert.equal(Object.keys(r.body.paths).length, 9);
    for (const value of Object.values(r.body.paths) as any[]) {
      assert.equal(value.post['x-402-payment'].amount, '1000');
      assert(value.post.responses['503'].description.includes('unknown settlement'));
      assert(value.post.requestBody.content['application/json'].schema.required.length > 0);
    }
  } finally { await l.close(); }
});
