import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { lab } from './helpers.js';
import { RAILS, railInfo } from '../src/config.js';
import { Buyer, selectTerms, validateBuyer } from '../src/buyer.js';
import { Ledger } from '../src/ledger.js';
import { fixtureBuyerConfig, fixtureRouter, fixtureSigner, type RouterScenario } from '../src/fixtures.js';
import { UTILITIES } from '../src/utilities.js';
import { encode64 } from '../src/json.js';
import { sdkSigner } from '../src/signer-sdk.js';

for (const rail of RAILS) {
  test(`${rail}: seller-only integration skips router and reserves only seller maximum`, async () => {
    const l = await lab(true), spend = new Ledger(':memory:');
    try {
      const c = fixtureBuyerConfig(l.config); c.capAtomicPerRail[rail] = '1000';
      const send = fixtureRouter(l.seller, c); let calls = 0;
      const b = new Buyer(c, spend, fixtureSigner('seller-only'), async (u, m, body, h) => {
        assert.notEqual(u, c.routerUrl); calls++; return send(u, m, body, h);
      });
      const r = await b.run('direct-' + rail, rail, 'payload/sha256', true);
      assert.equal(calls, 2); assert.equal(r.delivery, 'validated'); assert.equal(r.reserved_atomic, '1000');
      assert.equal(r.workflow, 'seller_only'); assert.equal(r.routing, 'bypassed_seller_only');
      assert.equal(l.facilitators[rail].settles, 1);
      await assert.rejects(b.run('second-direct', rail, 'payload/sha256', true), /spend_cap_exceeded/);
    } finally { spend.close(); await l.close(); }
  });
  test(`${rail}: buyer validates all three deliveries; no organic claims`, async () => {
    const l = await lab(true), spend = new Ledger(join(l.dir, 'buyer.sqlite'));
    try {
      const c = fixtureBuyerConfig(l.config), b = new Buyer(c, spend, fixtureSigner('success'), fixtureRouter(l.seller, c));
      for (const name of UTILITIES) {
        const r = await b.run(`${rail}-${name.replace('/', '-')}`, rail, name);
        assert.equal(r.delivery, 'validated'); assert.equal(r.routing, 'simulated'); assert.equal(r.seller_settlement, 'simulated');
        assert.equal(r.organic_demand, false); assert.equal(r.pq_evidence, 'not_checked');
      }
      assert.equal(l.facilitators[rail].settles, 3);
    } finally { spend.close(); await l.close(); }
  });
  for (const scenario of ['free_miss', 'unknown', 'settled_transparency_failure', 'wrong_selected_price', 'wrong_selected_network'] as RouterScenario[]) {
    test(`${rail}: ${scenario} does not pay seller or retry router`, async () => {
      const l = await lab(true), spend = new Ledger(join(l.dir, 'buyer.sqlite'));
      try {
        const c = fixtureBuyerConfig(l.config), send = fixtureRouter(l.seller, c, scenario);
        let signedPosts = 0;
        const b = new Buyer(c, spend, fixtureSigner(scenario), async (u, m, body, headers) => {
          if (headers?.['PAYMENT-SIGNATURE']) signedPosts++; return send(u, m, body, headers);
        });
        const r = await b.run(scenario, rail, 'payload/sha256');
        assert.equal(signedPosts, 1); assert.equal(l.facilitators[rail].settles, 0);
        assert.equal(r.delivery, 'not_attempted');
        if (scenario === 'free_miss') { assert.equal(r.routing, 'free_miss'); assert.equal(r.error, undefined); }
        else if (scenario === 'unknown') assert.equal(r.routing, 'unknown');
        else assert.equal(r.routing, 'simulated');
        await assert.rejects(b.run(scenario, rail, 'payload/sha256'), /run_already_reserved/);
        assert.equal(signedPosts, 1);
      } finally { spend.close(); await l.close(); }
    });
  }
  test(`${rail}: cap enforced across restart before network or signing`, async () => {
    const l = await lab(), path = join(l.dir, 'buyer.sqlite'), first = new Ledger(path), second = new Ledger(path);
    try {
      first.reserveSpend('first', rail, '4000', '4000');
      const c = fixtureBuyerConfig(l.config); c.capAtomicPerRail[rail] = '4000';
      const b = new Buyer(c, second, async () => { throw new Error('SIGN_MUST_NOT_RUN'); }, async () => { throw new Error('NETWORK_MUST_NOT_RUN'); });
      await assert.rejects(b.run('second', rail, 'payload/sha256'), /spend_cap_exceeded/);
      await assert.rejects(b.run('first', rail, 'payload/sha256'), /run_already_reserved/);
    } finally { first.close(); second.close(); await l.close(); }
  });
  test(`${rail}: losing seller reply halts with unknown, even when server completed`, async () => {
    const l = await lab(true), spend = new Ledger(join(l.dir, 'buyer.sqlite'));
    try {
      const c = fixtureBuyerConfig(l.config), send = fixtureRouter(l.seller, c);
      const b = new Buyer(c, spend, fixtureSigner('lost'), async (u, m, body, headers) => {
        const r = await send(u, m, body, headers);
        if (u.startsWith(c.sellerOrigin + '/') && headers?.['PAYMENT-SIGNATURE']) throw new Error('lost_after_commit');
        return r;
      });
      const r = await b.run('lost', rail, 'payload/sha256');
      assert.equal(r.seller_settlement, 'unknown'); assert.equal(r.delivery, 'unknown'); assert.equal(l.facilitators[rail].settles, 1);
      await assert.rejects(b.run('lost', rail, 'payload/sha256'), /run_already_reserved/);
      assert.equal(l.facilitators[rail].settles, 1);
    } finally { spend.close(); await l.close(); }
  });
  test(`${rail}: changed live seller quote refuses second signature`, async () => {
    const l = await lab(true), spend = new Ledger(':memory:');
    try {
      const c = fixtureBuyerConfig(l.config), send = fixtureRouter(l.seller, c); let signatures = 0;
      const sign = fixtureSigner('quote');
      const b = new Buyer(c, spend, async (r, p) => { signatures++; return sign(r, p); }, async (u, m, body, headers) => {
        const r = await send(u, m, body, headers);
        if (u.startsWith(c.sellerOrigin + '/') && r.status === 402) {
          r.body.accepts[0].amount = '999'; r.headers.set('PAYMENT-REQUIRED', encode64(r.body));
        } return r;
      });
      const report = await b.run('changed', rail, 'payload/sha256');
      assert.equal(report.error, 'seller_phase_stopped'); assert.equal(signatures, 1); assert.equal(l.facilitators[rail].settles, 0);
    } finally { spend.close(); await l.close(); }
  });
  test(`${rail}: exact terms reject wrong network, recipient, asset, price and duplicate accepts`, async () => {
    const l = await lab(); try {
      const c = fixtureBuyerConfig(l.config), r = l.seller.requirements.get(rail)!;
      const ch = { x402Version: 2 as const, resource: { url: c.sellerOrigin, description: 'fixture', mimeType: 'application/json' }, accepts: [r] };
      assert.equal(selectTerms(c, rail, ch, 'seller').amount, '1000');
      for (const patch of [{ asset: 'FAKE' }, { payTo: 'attacker' }, { network: 'eip155:1' }, { amount: '999999' },
        { maxTimeoutSeconds: 3600 }, { extra: { paymentFlow: 'permit2' } }]) {
        assert.throws(() => selectTerms(c, rail, { ...ch, accepts: [{ ...r, ...patch } as any] }, 'seller'));
      }
      assert.throws(() => selectTerms(c, rail, { ...ch, accepts: [r, r] }, 'seller'));
    } finally { await l.close(); }
  });
}
test('mainnet signing remains disabled even with testnet execution flags', async () => {
  const l = await lab(); try {
    const c = fixtureBuyerConfig(l.config); c.mode = 'mainnet';
    assert.throws(() => sdkSigner(c, { LAB_ALLOW_NETWORK: '1', LAB_BUYER_ACK: 'testnet-spend-with-caps' }), /mainnet_review_required/);
    c.mode = 'testnet'; assert.throws(() => sdkSigner(c, {}), /buyer_not_authorized/);
  } finally { await l.close(); }
});
test('buyer config cannot target the known production router or production replay path', async () => {
  const l = await lab(); try {
    const c = fixtureBuyerConfig(l.config);
    for (const routerUrl of ['https://402signal.com/route', 'https://402signal.fly.dev/route']) {
      assert.throws(() => validateBuyer({ ...c, mode: 'testnet', routerUrl, sellerOrigin: 'https://seller.example' }), /production_router_not_enabled/);
    }
    assert.throws(() => validateBuyer({ ...c, ledgerPath: '/data/live402-replay.sqlite' }), /separate_ledger_required/);
  } finally { await l.close(); }
});

for (const rail of RAILS) for (const status of [200, 503]) {
  test(`${rail}: HTTP ${status} free-miss classification rejects contradictory evidence`, async () => {
    for (const mutation of ['none', 'receipt', 'selected', 'billing', 'raw-json'] as const) {
      const l = await lab(true), spend = new Ledger(':memory:');
      try {
        const c = fixtureBuyerConfig(l.config); c.capAtomicPerRail[rail] = '4000';
        const send = fixtureRouter(l.seller, c, 'free_miss');
        const sign = fixtureSigner('miss-contract'); let signatures = 0, requests = 0;
        const buyer = new Buyer(c, spend, async (r, ch) => { signatures++; return sign(r, ch); },
          async (url, method, body, headers) => {
            requests++;
            const response = await send(url, method, body, headers);
            if (headers?.['PAYMENT-SIGNATURE']) {
              response.status = status;
              if (mutation === 'receipt') response.headers.set('PAYMENT-RESPONSE', 'contradiction');
              if (mutation === 'selected') response.body.selected_payment = {rail};
              if (mutation === 'billing') response.body.billing.settlement_attempted = true;
              if (mutation === 'raw-json') response.rawBody = '{"live":false,"live":true}';
            }
            return response;
          });
        const report = await buyer.run('miss', rail, 'payload/sha256');
        assert.equal(report.routing, mutation === 'none' ? 'free_miss' : 'unknown');
        assert.equal(report.error, mutation === 'none' ? undefined : 'router_phase_stopped');
        assert.equal(report.delivery, 'not_attempted');
        assert.equal(l.facilitators[rail].settles, 0);
        assert.equal(signatures, 1); assert.equal(requests, 2);
        await assert.rejects(buyer.run('miss', rail, 'payload/sha256'), /run_already_reserved/);
        await assert.rejects(buyer.run('fresh', rail, 'payload/sha256'), /spend_cap_exceeded/);
        assert.equal(signatures, 1); assert.equal(requests, 2);
      } finally { spend.close(); await l.close(); }
    }
  });
}
