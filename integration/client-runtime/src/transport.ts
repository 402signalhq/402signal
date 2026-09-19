import type { FacilitatorClient } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from '@x402/core/types';
import { assert, parseJson } from './json.js';
import { type Config, type Rail, railInfo, OFFLINE_ADDRESSES, safeUrl } from './config.js';

export interface HttpResult { status: number; headers: Headers; body: any; rawBody?: string; }
export type Transport = (url: string, method: string, body?: unknown, headers?: Record<string, string>) => Promise<HttpResult>;
// No redirects, retries, ambient auth, cookie jars or payment-aware fetch wrappers.
// Deadline covers headers AND the bounded response stream.
export const http: Transport = async (url, method, body, headers = {}) => {
  const signal = AbortSignal.timeout(15000);
  const r = await fetch(url, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...headers }, redirect: 'error', signal });
  assert(Number(r.headers.get('content-length') || 0) <= 262144, 'response_too_large');
  const reader = r.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  if (reader) try {
    for (;;) { const item = await reader.read(); if (item.done) break;
      size += item.value.length; assert(size <= 262144, 'response_too_large'); chunks.push(item.value); }
  } catch (e) { await reader.cancel().catch(() => {}); throw e; }
  const rawBody = Buffer.concat(chunks).toString('utf8');
  return { status: r.status, headers: r.headers, rawBody, body: size ? parseJson(rawBody, 262144, method === 'POST' && (body as any)?.jsonrpc === '2.0' && (body as any)?.method === 'getAccountInfo') : null };
};
export class RemoteFacilitator implements FacilitatorClient {
  constructor(private url: string, private send: Transport = http, private authorization?: string) { safeUrl(url); }
  async call(path: string, body?: unknown): Promise<any> {
    const r = await this.send(this.url.replace(/\/$/, '') + '/' + path, body ? 'POST' : 'GET', body,
      this.authorization ? { Authorization: this.authorization } : {});
    assert(r.status === 200 && r.body && typeof r.body === 'object', 'facilitator_unavailable', 503);
    return r.body;
  }
  async getSupported(): Promise<SupportedResponse> {
    const s = await this.call('supported');
    assert(Array.isArray(s.kinds) && s.kinds.length <= 128 && Array.isArray(s.extensions), 'invalid_supported');
    return s;
  }
  async verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResponse> {
    const v = await this.call('verify', { x402Version: 2, paymentPayload, paymentRequirements });
    assert(typeof v.isValid === 'boolean', 'invalid_verify'); return v;
  }
  async settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse> {
    return this.call('settle', { x402Version: 2, paymentPayload, paymentRequirements });
  }
}
// Explicitly injected ONLY in loopback offline mode; does not validate signatures.
export class FixtureFacilitator implements FacilitatorClient {
  verifies = 0; settles = 0;
  verification: 'valid' | 'reject' | 'throw' = 'valid';
  settlement: 'success' | 'throw' | 'malformed' = 'success';
  constructor(private rail: Rail, private config: Config) { assert(config.mode === 'offline', 'fixture_on_live_mode'); }
  async getSupported(): Promise<SupportedResponse> {
    return { kinds: [{ x402Version: 2, scheme: 'exact', network: railInfo(this.rail, this.config.mode).network,
      extra: { feePayer: OFFLINE_ADDRESSES[this.rail] } }], extensions: [], signers: {} };
  }
  async verify(): Promise<VerifyResponse> {
    this.verifies++;
    if (this.verification === 'throw') throw new Error('SENSITIVE_VERIFY_CANARY');
    return { isValid: this.verification === 'valid', invalidReason: 'SENSITIVE_VERIFY_CANARY' };
  }
  async settle(_p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> {
    this.settles++;
    if (this.settlement === 'throw') throw new Error('SENSITIVE_SETTLE_CANARY');
    return { success: true, transaction: this.settlement === 'malformed' ? 'SENSITIVE_CANARY' :
      this.rail === 'base' ? '0x' + 'a'.repeat(64) : this.rail === 'solana' ? '2'.repeat(88) : 'A'.repeat(52),
      network: r.network, amount: r.amount, errorReason: 'SENSITIVE_SETTLE_CANARY' };
  }
}
export function safeReceipt(rail: Rail, value: unknown, r: PaymentRequirements) {
  const s = value as any;
  assert(s?.success === true && s.network === r.network, 'settlement_unknown', 503);
  assert(typeof s.transaction === 'string' && ({ base: /^0x[\da-fA-F]{64}$/, solana: /^[1-9A-HJ-NP-Za-km-z]{64,88}$/, algorand: /^[A-Z2-7]{52}$/ }[rail]).test(s.transaction), 'settlement_unknown', 503);
  assert(s.amount === undefined || s.amount === r.amount, 'settlement_unknown', 503);
  return { success: true, transaction: s.transaction as string, network: r.network, amount: r.amount };
}
