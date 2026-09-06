import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { Address } from '@algorandfoundation/algokit-utils';
import { Transaction, TransactionType, encodeSignedTransaction } from '@algorandfoundation/algokit-utils/transact';
import { type Config, type Rail, OFFLINE_ADDRESSES, RAILS } from './config.js';
import { assert, digest, encode64 } from './json.js';
import { type BuyerConfig, type Signer } from './buyer.js';
import { type Transport, http } from './transport.js';
import type { Seller } from './seller.js';

// INVALID SIGNATURES. These bytes exercise wire decoders, not cryptography.
// Never use these payloads with a real facilitator or funded address.
export function fixturePayment(rail: Rail, req: PaymentRequirements, seed: string): PaymentPayload {
  const hash = Buffer.from(digest(seed), 'hex');
  let payload: Record<string, unknown>;
  if (rail === 'base') payload = { signature: '0x' + '11'.repeat(65), authorization: {
    from: OFFLINE_ADDRESSES.base, to: req.payTo, value: req.amount,
    validAfter: '0', validBefore: '1', nonce: '0x' + hash.toString('hex'),
  } };
  else if (rail === 'solana') {
    // Legacy transaction: one signature/account, blockhash, zero instructions.
    const message = Buffer.concat([Buffer.from([1, 0, 0, 1]), Buffer.alloc(32, 1), hash, Buffer.from([0])]);
    payload = { transaction: Buffer.concat([Buffer.from([1]), Buffer.alloc(64, 1), message]).toString('base64') };
  } else {
    const txn = new Transaction({ type: TransactionType.AssetTransfer,
      sender: new Address(new Uint8Array(32).fill(1)), fee: 0n, firstValid: 1n, lastValid: 2n, genesisHash: new Uint8Array(32).fill(2),
      note: hash, assetTransfer: { assetId: BigInt(req.asset), amount: BigInt(req.amount), receiver: new Address(new Uint8Array(32)) } });
    payload = { paymentGroup: [Buffer.from(encodeSignedTransaction({ txn, sig: new Uint8Array(64).fill(1) })).toString('base64')], paymentIndex: 0 };
  }
  return { x402Version: 2, accepted: structuredClone(req), payload };
}
export function fixtureBuyerConfig(config: Config): BuyerConfig {
  assert(config.mode === 'offline', 'fixture_only');
  return { mode: 'offline', routerUrl: 'http://127.0.0.1:1/route', sellerOrigin: config.origin,
    ledgerPath: ':memory:', routerPayTo: { ...OFFLINE_ADDRESSES }, sellerPayTo: { ...OFFLINE_ADDRESSES },
    feePayers: Object.fromEntries(RAILS.map(r => [r, [OFFLINE_ADDRESSES[r]]])) as BuyerConfig['feePayers'],
    capAtomicPerRail: { base: '40000', solana: '40000', algorand: '40000' }, sellerMaxAtomic: config.priceAtomic };
}
export function fixtureSigner(seed: string): Signer {
  let counter = 0;
  return async (rail, ch) => fixturePayment(rail, ch.accepts[0]!, `${seed}-${counter++}`);
}
export type RouterScenario = 'success' | 'free_miss' | 'unknown' | 'settled_transparency_failure' | 'wrong_selected_price' | 'wrong_selected_network';
// The only fake router. Never binds a port; intercepts one loopback fixture URL.
// Sellers still run through their actual local HTTP server in the demo.
export function fixtureRouter(seller: Seller, c: BuyerConfig, scenario: RouterScenario = 'success'): Transport {
  assert(c.mode === 'offline' && seller.config.mode === 'offline', 'fixture_only');
  return async (url, method, body: any, headers = {}) => {
    if (url !== c.routerUrl) {
      assert(url.startsWith(c.sellerOrigin + '/') && new URL(url).hostname === '127.0.0.1', 'fixture_network_blocked');
      return http(url, method, body, headers);
    }
    assert(method === 'POST' && !body.constraints && Array.isArray(body.networks), 'fixture_bad_router_request');
    const rail = body.networks[0] as Rail;
    const sellerReq = seller.requirements.get(rail)!;
    const req = { ...sellerReq, amount: '3000', payTo: c.routerPayTo[rail] };
    const ch: PaymentRequired = { x402Version: 2, resource: { url, description: 'SYNTHETIC ROUTER', mimeType: 'application/json' }, accepts: [req] };
    if (!headers['PAYMENT-SIGNATURE']) return { status: 402, body: ch, headers: new Headers({ 'PAYMENT-REQUIRED': encode64(ch) }) };
    if (scenario === 'free_miss') return { status: 200, headers: new Headers(), body: {
      live: false, payable: false, selected_payment: null, miss_reason: 'no_candidates', billing: {
        model: 'success_only_v1', condition: 'live_eligible_route_found', asset: 'USDC',
        amount_atomic: '3000', display_amount: '$0.003', rail,
        settled: false, settlement_attempted: false, settlement_state: 'not_attempted' } } };
    if (scenario === 'unknown') throw new Error('fixture_lost_router_reply');
    const receipt = { success: true, network: req.network, amount: '3000', transaction: rail === 'base' ? '0x' + 'a'.repeat(64) : rail === 'solana' ? '2'.repeat(88) : 'A'.repeat(52) };
    return { status: scenario === 'settled_transparency_failure' ? 503 : 200,
      headers: new Headers({ 'PAYMENT-RESPONSE': encode64(receipt) }), body: {
        url: body.url, live: true, status: 402, evidence: 'SYNTHETIC_FIXTURE', billing: { settled: true, settlement_state: 'settled' },
        selected_payment: { rail, network: scenario === 'wrong_selected_network' ? 'eip155:1' : sellerReq.network, asset: sellerReq.asset,
          payTo: sellerReq.payTo, amount_atomic: scenario === 'wrong_selected_price' ? 999999 : Number(sellerReq.amount) },
      } };
  };
}
