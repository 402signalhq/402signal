import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { x402ResourceServer } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { ExactSvmScheme } from '@x402/svm/exact/server';
import { ExactAvmScheme } from '@x402/avm/exact/server';
import { RAILS, railInfo, OFFLINE_ADDRESSES } from '../src/config.js';
import { selectTerms, validateBuyer } from '../src/buyer.js';

const supported = JSON.parse(readFileSync('test/fixtures/testnet-supported-subset.json', 'utf8')).supported;
const seller = JSON.parse(readFileSync('config/testnet.example.json', 'utf8'));
const buyer = validateBuyer(JSON.parse(readFileSync('config/buyer.example.json', 'utf8')));
for (const rail of RAILS) test(`${rail}: configured testnet matches operator's advertised x402.org support`, async () => {
  const info = railInfo(rail, 'testnet');
  assert.equal(seller.rails[rail].facilitatorUrl, 'https://x402.org/facilitator');
  const resource = new x402ResourceServer({
    getSupported: async () => supported,
    verify: async () => { throw new Error('network_or_verification_not_allowed'); },
    settle: async () => { throw new Error('payment_not_allowed'); },
  });
  resource.register(info.network, rail === 'base' ? new ExactEvmScheme() : rail === 'solana' ? new ExactSvmScheme() : new ExactAvmScheme());
  await resource.initialize();
  const req = (await resource.buildPaymentRequirements({ scheme: 'exact', network: info.network,
    payTo: OFFLINE_ADDRESSES[rail], price: '$0.001', maxTimeoutSeconds: 60 }))[0]!;
  assert.equal(req.network, info.network); assert.equal(req.asset, info.asset); assert.equal(req.amount, '1000');
  const c = structuredClone(buyer); c.sellerPayTo[rail] = OFFLINE_ADDRESSES[rail];
  const ch = { x402Version: 2 as const, resource: { url: 'https://fixture.invalid', mimeType: 'application/json', description: 'offline policy check' }, accepts: [req] };
  assert.equal(selectTerms(c, rail, ch, 'seller'), req);
  if (rail !== 'base') {
    assert.deepEqual(c.feePayers[rail], [req.extra.feePayer]);
    const changed = { ...ch, accepts: [{ ...req, extra: { ...req.extra, feePayer: 'unexpected-recipient' } }] };
    assert.throws(() => selectTerms(c, rail, changed, 'seller'), /fee_payer_not_allowlisted/);
  }
  assert.equal(c.capAtomicPerRail[rail], '0');
});
