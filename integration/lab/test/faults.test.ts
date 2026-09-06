import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { lab } from './helpers.js';
import { faultServer } from '../src/fault-server.js';
import { http } from '../src/transport.js';
for (const [name, status] of [['valid_402', 402], ['expensive', 402], ['reachable_200', 200], ['missing_accepts', 402],
  ['wrong_asset', 402], ['no_payto', 402], ['upstream_503', 503]] as const) {
  test(`private fault ${name} produces the intended observation`, async () => {
    const l = await lab(), app = faultServer(l.seller);
    try {
      app.listen(0, '127.0.0.1'); await once(app, 'listening');
      const r = await http(`http://127.0.0.1:${(app.address() as any).port}/${name}`, 'GET');
      assert.equal(r.status, status);
      if (name === 'expensive') assert.equal(r.body.accepts[0].amount, '100000');
      if (name === 'missing_accepts') assert.deepEqual(r.body.accepts, []);
      if (name === 'no_payto') assert.equal(r.body.accepts[0].payTo, undefined);
      assert.equal(l.facilitators.base.settles, 0); assert.deepEqual(l.ledger.summary(), []);
    } finally { if (app.listening) await new Promise<void>(r => { app.close(() => r()); app.closeAllConnections(); }); await l.close(); }
  });
}
test('private faults refuse payment headers, expose drift, and bound timeout fixture', async () => {
  const l = await lab(), app = faultServer(l.seller);
  try {
    app.listen(0, '127.0.0.1'); await once(app, 'listening');
    const url = `http://127.0.0.1:${(app.address() as any).port}`;
    assert.equal((await http(url + '/valid_402', 'POST', {}, { 'PAYMENT-SIGNATURE': 'never-send-real-payments' })).status, 400);
    const a = await http(url + '/payto_drift', 'GET'), b = await http(url + '/payto_drift', 'GET');
    assert.notEqual(a.body.accepts[0].payTo, b.body.accepts[0].payTo);
    await assert.rejects(http(url + '/malformed_json', 'GET'));
    await assert.rejects(fetch(url + '/slow', { signal: AbortSignal.timeout(50) }));
    assert.equal(l.facilitators.base.verifies, 0);
  } finally { if (app.listening) await new Promise<void>(r => { app.close(() => r()); app.closeAllConnections(); }); await l.close(); }
});
