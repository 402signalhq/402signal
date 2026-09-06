import type { FacilitatorClient } from '@x402/core/server';
import { x402ResourceServer } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { ExactSvmScheme } from '@x402/svm/exact/server';
import { ExactAvmScheme } from '@x402/avm/exact/server';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { type Config, type Rail, RAILS, OFFLINE_ADDRESSES, railInfo } from './config.js';
import { assert, canonical, decode64, digest, encode64, LabError, parseJson } from './json.js';
import { Ledger, type Outcome } from './ledger.js';
import { matchRequirements, paymentIdentity } from './identity.js';
import { FixtureFacilitator, RemoteFacilitator, safeReceipt } from './transport.js';
import { example, utility, UTILITIES, type Utility } from './utilities.js';

export class Seller {
  servers = new Map<Rail, x402ResourceServer>();
  requirements = new Map<Rail, PaymentRequirements>();
  ready = false;
  constructor(public config: Config, public ledger: Ledger, private injected?: Record<Rail, FacilitatorClient>) {}
  evidence() { return { traffic_class: 'self_test', operator_owned: true,
    environment: this.config.mode, settlement_evidence: this.config.mode === 'offline' ? 'synthetic_fixture' : 'facilitator_receipt',
    chain_confirmation: 'not_independently_checked', organic_demand: false }; }
  async initialize() {
    for (const rail of RAILS) {
      assert(!this.injected || this.config.mode === 'offline', 'test_dependency_in_live_mode');
      const f = this.injected?.[rail] ?? (this.config.mode === 'offline' ? new FixtureFacilitator(rail, this.config) :
        new RemoteFacilitator(this.config.rails[rail].facilitatorUrl, undefined, process.env[`LAB_${rail.toUpperCase()}_FACILITATOR_AUTH`]));
      const s = new x402ResourceServer(f);
      const info = railInfo(rail, this.config.mode);
      s.register(info.network, rail === 'base' ? new ExactEvmScheme() : rail === 'solana' ? new ExactSvmScheme() : new ExactAvmScheme());
      await s.initialize();
      const req = (await s.buildPaymentRequirements({ scheme: 'exact', network: info.network,
        payTo: this.config.mode === 'offline' ? OFFLINE_ADDRESSES[rail] : this.config.rails[rail].payTo,
        price: '$' + (Number(this.config.priceAtomic) / 1000000).toFixed(6), maxTimeoutSeconds: 60 }))[0];
      assert(req && req.asset === info.asset && req.amount === this.config.priceAtomic, 'sdk_terms_mismatch');
      assert(!req.extra?.paymentFlow || req.extra.paymentFlow === 'authorization', 'unsupported_flow');
      this.servers.set(rail, s); this.requirements.set(rail, req);
    }
    this.ready = true;
  }
  catalog() {
    return { name: '402Signal Lab', ...this.evidence(), directory_submission: 'manual_opt_in_only',
      resources: RAILS.flatMap(rail => UTILITIES.map(name => ({ url: this.config.origin + '/' + rail + '/' + name,
        method: 'POST', capability: name, accepts: [this.requirements.get(rail)], input_example: example(name),
        description: `Operator-owned self-test utility: ${name}. Not evidence of independent adoption.` }))) };
  }
  openapi() {
    return { openapi: '3.1.0', info: { title: '402Signal Lab — operator-owned self-test APIs', version: '0.2.0',
      description: 'Not independent organic traffic. Seller payment is separate from the 402Signal routing fee. Never automatically retry an unknown settlement.' },
      servers: [{ url: this.config.origin }], 'x-traffic-class': 'self_test',
      paths: Object.fromEntries(RAILS.flatMap(rail => UTILITIES.map(name => {
        const ch = this.challenge(rail, name).body;
        return [`/${rail}/${name}`, { get: { summary: 'Unpaid discovery; paid GET executes the published Bazaar input example', responses: {
          '402': { description: 'USDC payment requirements; no settlement', content: { 'application/json': { example: ch } } } } },
          post: { summary: name, 'x-402-payment': this.requirements.get(rail),
            requestBody: { required: true, content: { 'application/json': { schema: ch.extensions.bazaar.schema.properties.input.properties.body, example: example(name) } } },
            responses: { '200': { description: 'Deterministic result; inspect billing and evidence for simulated vs settled',
              content: { 'application/json': { schema: { type: 'object', required: ['result', 'evidence', 'billing'] } } } },
              '402': { description: 'Unpaid challenge or verification rejection; inspect body', content: { 'application/json': { example: ch } } },
              '400': { description: 'Invalid input or authorization; no new settlement' },
              '409': { description: 'Authorization scope conflict or incomplete prior attempt; do not reauthorize automatically' },
              '503': { description: 'Unavailable or unknown settlement. Not evidence of an unpaid request; do not retry automatically.' } } } }];
      }))) };
  }
  challenge(rail: Rail, name: Utility): Outcome {
    const req = this.requirements.get(rail)!;
    const schema = name === 'json/canonicalize' ? { type: 'object', properties: { value: {} }, required: ['value'], additionalProperties: false }
      : { type: 'object', properties: { text: { type: 'string', maxLength: 16384 } }, required: ['text'], additionalProperties: false };
    const body = { x402Version: 2, error: 'Payment required', resource: { url: `${this.config.origin}/${rail}/${name}`,
      mimeType: 'application/json', description: `Operator-owned self-test ${name}; ${this.config.priceAtomic} atomic USDC. Paid GET executes the Bazaar input example; POST executes the supplied input.` },
      accepts: [req], extensions: { bazaar: { info: { input: { type: 'http', method: 'POST', bodyType: 'json', body: example(name) },
        output: { type: 'json', example: { result: utility(name, example(name)), evidence: this.evidence(), billing: {
          settled: this.config.mode !== 'offline', settlement_state: this.config.mode === 'offline' ? 'simulated' : 'settled', amount_atomic: req.amount, rail } } } },
        schema: { '$schema': 'https://json-schema.org/draft/2020-12/schema', type: 'object', required: ['input'], properties: {
          input: { type: 'object', required: ['type', 'method', 'bodyType', 'body'], properties: { type: { const: 'http' }, method: { const: 'POST' },
            bodyType: { const: 'json' }, body: schema } }, output: { type: 'object', properties: { type: { const: 'json' }, example: { type: 'object' } } } } } }
      } };
    return { status: 402, body, headers: { 'PAYMENT-REQUIRED': encode64(body) } };
  }
  async request(rail: Rail, name: Utility, raw: string, header?: string): Promise<Outcome> {
    assert(this.ready, 'not_ready', 503);
    if (!header) return this.challenge(rail, name);
    const payment = parseJson(decode64(header).toString('utf8')) as PaymentPayload;
    const req = this.requirements.get(rail)!;
    assert(matchRequirements(payment, req), 'payment_terms_mismatch');
    const id = paymentIdentity(rail, payment, req);
    // Existing results are scoped to the exact utility input. Lookup precedes
    // admission; invalid inputs and failed verification never consume rows.
    const scope = digest(`${rail}/${name}\n${raw}`);
    const existing = this.ledger.lookup(id, scope);
    if (existing) return existing.outcome;
    const noPayment = (error: string, status: number) => ({ status, body: { error, evidence: this.evidence(),
      billing: { settled: false, settlement_attempted: false, settlement_state: 'not_attempted' } } });
    let result: unknown;
    try { result = utility(name, parseJson(raw)); }
    catch { return noPayment('invalid_input', 400); }
    try {
      const v = await this.servers.get(rail)!.verifyPayment(payment, req);
      if (v.isValid !== true) {
        return noPayment('payment_rejected', 402);
      }
    } catch {
      return noPayment('verification_unavailable', 503);
    }
    const reservation = this.ledger.reserve(id, scope);
    if (!reservation.run) return reservation.outcome!;
    // If this write fails, do not call settle. Attempted is durable before POST.
    this.ledger.attempting(id);
    let outcome: Outcome;
    try {
      const rawReceipt = await this.servers.get(rail)!.settlePayment(payment, req);
      const receipt = safeReceipt(rail, rawReceipt, req);
      outcome = { status: 200, body: { result, evidence: this.evidence(),
        billing: { settled: this.config.mode !== 'offline', settlement_attempted: this.config.mode !== 'offline',
          settlement_state: this.config.mode === 'offline' ? 'simulated' : 'settled', amount_atomic: req.amount, rail },
        result_sha256: digest(canonical(result)) }, headers: { 'PAYMENT-RESPONSE': encode64(receipt) } };
      this.ledger.finish(id, this.config.mode === 'offline' ? 'simulated' : 'settled', outcome);
    } catch {
      outcome = { status: 503, body: { error: 'settlement_unknown', evidence: this.evidence(), billing: {
        settled: null, settlement_attempted: true, settlement_state: 'unknown' } } };
      // On a post-settlement disk failure, preserve attempted. Never reconstruct.
      try { this.ledger.finish(id, 'unknown', outcome); } catch { /* fail closed */ }
    }
    return outcome;
  }
}
