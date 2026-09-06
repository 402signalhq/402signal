import { createServer } from 'node:http';
import type { Seller } from './seller.js';
import { assert, encode64 } from './json.js';

export const FAULTS = ['valid_402', 'expensive', 'reachable_200', 'missing_accepts', 'wrong_asset', 'no_payto',
  'malformed_json', 'slow', 'upstream_503', 'payto_drift'] as const;
// Private wire observations only. NEVER accepts payment headers, settles,
// contacts a facilitator, or binds anywhere except loopback via the CLI.
export function faultServer(seller: Seller) {
  assert(seller.config.mode === 'offline', 'faults_require_offline');
  let drift = 0;
  const app = createServer((req, res) => {
    const finish = (status: number, body: any, header?: string) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow', 'X-402Signal-Lab': 'SYNTHETIC-FAULT', ...(header ? { 'PAYMENT-REQUIRED': header } : {}) });
      res.end(JSON.stringify(body));
    };
    req.resume();
    if (req.headers['payment-signature'] || req.headers['x-payment']) return finish(400, { error: 'fault_server_never_accepts_payments' });
    if (req.url === '/') return finish(200, { warning: 'SYNTHETIC FAULTS. No payments. No production submission.', cases: FAULTS });
    const name = req.url?.slice(1);
    if (!FAULTS.includes(name as any)) return finish(404, { error: 'not_found' });
    const ch = structuredClone(seller.challenge('base', 'payload/sha256').body);
    ch.resource.url = `http://127.0.0.1:${(app.address() as any).port}/${name}`;
    const a = ch.accepts[0];
    if (name === 'reachable_200') return finish(200, { hello: 'reachable is not payable', traffic_class: 'self_test' });
    if (name === 'upstream_503') return finish(503, { error: 'injected_upstream_failure' });
    if (name === 'malformed_json') { res.writeHead(402, { 'Content-Type': 'application/json' }); res.end('{broken'); return; }
    if (name === 'expensive') a.amount = '100000';
    if (name === 'missing_accepts') ch.accepts = [];
    if (name === 'wrong_asset') a.asset = '0x' + 'f'.repeat(40);
    if (name === 'no_payto') delete a.payTo;
    if (name === 'payto_drift' && ++drift % 2 === 0) a.payTo = '0x' + '2'.repeat(40);
    if (name === 'slow') { const timer = setTimeout(() => finish(402, ch, encode64(ch)), 2500);
      res.once('close', () => clearTimeout(timer)); return; }
    finish(402, ch, encode64(ch));
  });
  app.headersTimeout = 5000; app.requestTimeout = 5000; app.timeout = 6000;
  return app;
}
