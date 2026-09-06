import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { randomBytes } from 'node:crypto';
import { type Rail, type Mode, RAILS, railInfo, safeUrl } from './config.js';
import { assert, atomic, canonical, decode64, digest, encode64, object, parseJson, LabError } from './json.js';
import { Ledger } from './ledger.js';
import { type Transport, type HttpResult, http, safeReceipt } from './transport.js';
import { type Utility, UTILITIES, example, utility } from './utilities.js';
import { type MainnetPolicy, validateMainnetPolicy, mainnetTerms, paymentIntent } from './mainnet-policy.js';
import { type Confirmer, type Confirmation } from './confirmation.js';

export interface BuyerConfig {
  mode: Mode; routerUrl: string; sellerOrigin: string; ledgerPath: string;
  routerPayTo: Record<Rail, string>; sellerPayTo: Record<Rail, string>;
  feePayers: Record<Rail, string[]>; capAtomicPerRail: Record<Rail, string>;
  sellerMaxAtomic: string;
  mainnet?: MainnetPolicy;
  routePilot?: {protocol: '402signal-lab-route-v2'; routerFeePayers: Record<Rail,string[]>};
}
export type Signer = (rail: Rail, challenge: PaymentRequired) => Promise<PaymentPayload>;
export function validateBuyer(raw: unknown): BuyerConfig {
  const c = object(raw) as unknown as BuyerConfig;
  assert(['offline', 'testnet', 'mainnet'].includes(c.mode), 'invalid_mode');
  const r = safeUrl(c.routerUrl, c.mode === 'offline'), s = safeUrl(c.sellerOrigin, c.mode === 'offline');
  assert(r.pathname === '/route' && s.pathname === '/', 'invalid_endpoint');
  assert(!c.sellerOrigin.endsWith('/'), 'origin_must_not_end_with_slash');
  // Do not contaminate production rankings, history, or PQ with fixture claims.
  const production = /(^|\.)402signal\.com$/.test(r.hostname) || r.hostname === '402signal.fly.dev';
  if (production) assert(c.mode === 'mainnet' && c.routerUrl === 'https://402signal.com/route' &&
    c.routePilot?.protocol === '402signal-lab-route-v2', 'production_router_not_enabled');
  if (c.routePilot) {
    assert(c.mode === 'mainnet' && c.routePilot.protocol === '402signal-lab-route-v2', 'invalid_route_pilot');
    for (const rail of RAILS) assert(Array.isArray(c.routePilot.routerFeePayers?.[rail]), 'router_fee_payers_required');
  }
  assert(typeof c.ledgerPath === 'string' && c.ledgerPath.length > 0 && !c.ledgerPath.startsWith('/data/live402'), 'separate_ledger_required');
  assert(atomic(c.sellerMaxAtomic) > 0n && atomic(c.sellerMaxAtomic) <= 10000n, 'seller_price_out_of_bounds');
  for (const rail of RAILS) {
    atomic(c.capAtomicPerRail[rail]); assert(atomic(c.capAtomicPerRail[rail]) <= 1000000n, 'lab_cap_limit_one_usdc_per_rail');
    assert(typeof c.routerPayTo[rail] === 'string' && typeof c.sellerPayTo[rail] === 'string', 'recipient_required');
    assert(Array.isArray(c.feePayers[rail]), 'fee_payers_required');
  }
  if (c.mode === 'mainnet') validateMainnetPolicy(c.mainnet);
  return c;
}
export function challenge(r: HttpResult, expectedUrl: string): PaymentRequired {
  assert(r.status === 402, 'challenge_required');
  const h = r.headers.get('PAYMENT-REQUIRED'); assert(h, 'challenge_header_required');
  const parsed = parseJson(decode64(h).toString('utf8'));
  assert(parsed.x402Version === 2 && canonical(parsed) === canonical(r.body), 'challenge_header_body_mismatch');
  assert(parsed.resource?.url === expectedUrl && Array.isArray(parsed.accepts) && parsed.accepts.length <= 16, 'challenge_resource_mismatch');
  return parsed;
}
export function selectTerms(c: BuyerConfig, rail: Rail, ch: PaymentRequired, kind: 'router' | 'seller'): PaymentRequirements {
  const info = railInfo(rail, c.mode);
  const matches = ch.accepts.filter(a => a.network === info.network);
  assert(matches.length === 1, 'ambiguous_payment_options'); const a = matches[0]!;
  assert(a.scheme === 'exact' && a.asset === info.asset && a.payTo === (kind === 'router' ? c.routerPayTo[rail] : c.sellerPayTo[rail]), 'payment_policy_mismatch');
  const n = atomic(a.amount); assert(kind === 'router' ? n === 3000n : n > 0n && n <= atomic(c.sellerMaxAtomic), 'payment_price_mismatch');
  assert(Number.isInteger(a.maxTimeoutSeconds) && a.maxTimeoutSeconds > 0 && a.maxTimeoutSeconds <= 60, 'timeout_policy_mismatch');
  assert(!a.extra?.paymentFlow || a.extra.paymentFlow === 'authorization', 'unsupported_payment_flow');
  assert(!a.extra?.assetTransferMethod || a.extra.assetTransferMethod === 'eip3009', 'unsupported_transfer_method');
  if (rail !== 'base') assert(typeof a.extra?.feePayer === 'string' && (kind === 'router' && c.routePilot ? c.routePilot.routerFeePayers[rail] : c.feePayers[rail]).includes(a.extra.feePayer), 'fee_payer_not_allowlisted');
  if (c.mode === 'mainnet') mainnetTerms(a,rail);
  return a;
}
export interface RunReport {
  run_id: string; rail: Rail; capability: Utility; mode: Mode;
  traffic_class: 'self_test'; organic_demand: false;
  routing: string; delivery: string; seller_settlement: string; reserved_atomic: string;
  routing_ms?: number; execution_ms?: number; miss_reason?: string;
  result_sha256?: string; seller_receipt?: unknown; router_receipt?: unknown;
  pq_evidence: 'not_checked'; error?: string;
  workflow?: 'route_and_execute' | 'seller_only';
  chain_confirmation?: Confirmation;
  stopped_because?: string;
}
export class Buyer {
  constructor(public config: BuyerConfig, private ledger: Ledger, private signer: Signer, private send: Transport = http, private confirm?: Confirmer) {}
  async run(runId: string, rail: Rail, name: Utility, sellerOnly = false): Promise<RunReport> {
    assert(/^[a-zA-Z0-9_-]{1,64}$/.test(runId) && RAILS.includes(rail) && UTILITIES.includes(name), 'invalid_run');
    const c = this.config;
    if (c.mode === 'mainnet') {
      validateBuyer(c);
      assert(sellerOnly && this.confirm, 'mainnet_seller_only_confirmation_required');
      this.ledger.bindCampaign(digest(canonical({mode:c.mode, policy:c.mainnet, origin:c.sellerOrigin, recipients:c.sellerPayTo, feePayers:c.feePayers})));
    }
    const report: RunReport = { run_id: runId, rail, capability: name, mode: c.mode, traffic_class: 'self_test', organic_demand: false,
      workflow: sellerOnly ? 'seller_only' : 'route_and_execute',
      routing: sellerOnly ? 'bypassed_seller_only' : 'not_attempted', delivery: 'not_attempted', seller_settlement: 'not_attempted',
      reserved_atomic: ((sellerOnly ? 0n : 3000n) + atomic(c.sellerMaxAtomic)).toString(), pq_evidence: 'not_checked' };
    // Reserve the entire maximum before any request or signature. All failed,
    // missed and ambiguous attempts count against this lifetime campaign cap.
    this.ledger.reserveSpend(runId, rail, report.reserved_atomic, c.capAtomicPerRail[rail], c.mode === 'mainnet');
    let stage: 'router' | 'seller' = sellerOnly ? 'seller' : 'router';
    const url = `${c.sellerOrigin}/${rail}/${name}`;
    const routeBody = { need: `self-test ${name}`, url, objective: 'best', networks: [rail], max_price_usd: Number(c.sellerMaxAtomic) / 1000000 };
    try {
      let selectedAmount: string | undefined;
      if (!sellerOnly) {
        const initial = challenge(await this.send(c.routerUrl, 'POST', routeBody), c.routerUrl);
        const req = selectTerms(c, rail, initial, 'router');
        const payment = await this.signer(rail, { ...initial, accepts: [req] });
        assert(canonical(payment.accepted) === canonical(req), 'signer_changed_terms');
        const start = Date.now();
        this.ledger.spendState(runId, 'router_attempted'); report.routing = 'unknown';
        const replayKey = randomBytes(32).toString('hex');
        const routed = await this.send(c.routerUrl, 'POST', routeBody, { 'PAYMENT-SIGNATURE': encode64(payment), 'Replay-Key': replayKey });
        report.routing_ms = Date.now() - start;
        const b = routed.body?.billing;
        const guardModule = '../../sdk/route-guard/index.mjs';
        const { isUnsettledRouteMiss } = await import(guardModule);
        if (isUnsettledRouteMiss({ httpStatus: routed.status,
            routeResponseJson: routed.rawBody ?? JSON.stringify(routed.body),
            paymentResponseHeader: routed.headers.get('PAYMENT-RESPONSE') })) {
          report.routing = 'free_miss'; report.miss_reason = routed.body.miss_reason;
          this.ledger.spendState(runId, 'free_miss'); return report;
        }
        assert(b?.settled === true && b?.settlement_state === 'settled', 'router_settlement_unknown');
        const rh = routed.headers.get('PAYMENT-RESPONSE'); assert(rh, 'router_receipt_missing');
        report.router_receipt = safeReceipt(rail, parseJson(decode64(rh).toString('utf8')), req);
        report.routing = c.mode === 'offline' ? 'simulated' : 'settled_receipt_observed';
        // A settled transparency failure is paid; stop, do not sign again.
        assert(routed.status === 200 && routed.body.live === true && routed.body.url === url, 'route_not_executable');
        const selected = object(routed.body.selected_payment);
        assert(selected.network === req.network && selected.asset === req.asset && selected.payTo === c.sellerPayTo[rail] &&
          Number.isSafeInteger(selected.amount_atomic) && selected.amount_atomic > 0 && BigInt(selected.amount_atomic) <= atomic(c.sellerMaxAtomic), 'selected_option_mismatch');
        selectedAmount = String(selected.amount_atomic);
      }
      stage = 'seller';
      const input = example(name);
      const sellerChallenge = challenge(await this.send(url, 'POST', input), url);
      const sellerReq = selectTerms(c, rail, sellerChallenge, 'seller');
      assert(selectedAmount === undefined || sellerReq.amount === selectedAmount, 'seller_terms_changed');
      const sellerPayment = await this.signer(rail, { ...sellerChallenge, accepts: [sellerReq] });
      assert(canonical(sellerPayment.accepted) === canonical(sellerReq), 'signer_changed_terms');
      const intent = c.mode === 'mainnet' ? paymentIntent(rail,sellerReq,sellerPayment,c.mainnet!.buyerAddresses[rail]) : undefined;
      if (intent) this.ledger.recordIntent(runId,intent);
      this.ledger.spendState(runId, 'seller_attempted'); report.seller_settlement = 'unknown';
      report.delivery = 'unknown';
      const execStart = Date.now();
      const executed = await this.send(url, 'POST', input, { 'PAYMENT-SIGNATURE': encode64(sellerPayment) });
      report.execution_ms = Date.now() - execStart;
      const h = executed.headers.get('PAYMENT-RESPONSE'); assert(h, 'seller_receipt_missing');
      report.seller_receipt = safeReceipt(rail, parseJson(decode64(h).toString('utf8')), sellerReq);
      if (intent) this.ledger.recordReceipt(runId,(report.seller_receipt as any).transaction);
      report.seller_settlement = c.mode === 'offline' ? 'simulated' : 'settled_receipt_observed';
      assert(executed.status === 200, 'seller_delivery_failed');
      assert(canonical(executed.body.result) === canonical(utility(name, input)), 'seller_result_mismatch');
      report.result_sha256 = digest(canonical(executed.body.result)); report.delivery = 'validated';
      if (intent) {
        report.chain_confirmation = await this.confirm!(intent,(report.seller_receipt as any).transaction);
        this.ledger.recordConfirmation(runId,report.chain_confirmation);
        assert(report.chain_confirmation.state === 'confirmed', 'chain_confirmation_unknown');
        report.seller_settlement = 'chain_confirmed';
      }
      this.ledger.spendState(runId, 'complete');
    } catch (error) {
      report.error = stage === 'router' ? 'router_phase_stopped' : 'seller_phase_stopped';
      if (error instanceof LabError) report.stopped_because = error.code;
      // Unknown reservations are never released or silently retried.
      try { this.ledger.spendState(runId, c.mode === 'mainnet' && report.seller_settlement === 'not_attempted' ? 'not_submitted' : 'halted'); } catch { /* fail closed */ }
    }
    return report;
  }
}
