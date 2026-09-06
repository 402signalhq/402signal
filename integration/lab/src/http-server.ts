import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Seller } from './seller.js';
import { RAILS, type Rail } from './config.js';
import { assert, LabError } from './json.js';
import { UTILITIES, example, type Utility } from './utilities.js';
import type { Outcome } from './ledger.js';

async function readBody(req: IncomingMessage): Promise<string> {
  assert(!req.headers['content-encoding'], 'unsupported_encoding', 415);
  assert((req.headers['content-type'] ?? '').split(';')[0] === 'application/json', 'json_required', 415);
  assert(Number(req.headers['content-length'] ?? 0) <= 65536, 'body_too_large', 413);
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; assert(size <= 65536, 'body_too_large', 413); chunks.push(chunk); }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}
function send(res: ServerResponse, o: Outcome, head = false) {
  const bytes = Buffer.from(JSON.stringify(o.body));
  res.writeHead(o.status, { 'Content-Type': 'application/json', 'Content-Length': bytes.length,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", ...o.headers });
  res.end(head ? undefined : bytes);
}
export function server(seller: Seller) {
  let active = 0, minute = 0, requests = 0;
  const app = createServer({ maxHeaderSize: 24576 }, async (req, res) => {
    const epoch = Math.floor(Date.now() / 60000);
    if (epoch !== minute) { minute = epoch; requests = 0; }
    if (++requests > 600 || active >= 8) { req.resume(); send(res, { status: 429, body: { error: 'lab_capacity' } }); return; }
    active++;
    try {
      const path = req.url ?? '';
      assert(!path.includes('?') && !path.includes('%') && path.length <= 256, 'invalid_path', 404);
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (path === '/health') return send(res, { status: 200, body: { ok: true, mode: seller.config.mode } }, req.method === 'HEAD');
        if (path === '/ready') {
          const capacity = seller.ledger.capacity(), ok = seller.ready && capacity.ready;
          return send(res, { status: ok ? 200 : 503, body: { ok, payment_capacity_remaining: capacity.remaining } }, req.method === 'HEAD');
        }
        if (path === '/openapi.json') return send(res, { status: 200, body: seller.openapi() }, req.method === 'HEAD');
        if (['/catalog.json', '/.well-known/x402.json'].includes(path)) return send(res, { status: 200, body: seller.catalog() }, req.method === 'HEAD');
      }
      const parts = path.split('/'), rail = parts[1] as Rail, name = parts.slice(2).join('/') as Utility;
      assert(RAILS.includes(rail) && UTILITIES.includes(name), 'not_found', 404);
      if ((req.method === 'GET' || req.method === 'HEAD') &&
          !req.headers['payment-signature'] && !req.headers['x-payment'] && !req.headers['payment-payload'])
        return send(res, seller.challenge(rail, name), req.method === 'HEAD');
      assert(req.method === 'POST' || req.method === 'GET', 'method_not_allowed', 405);
      // Reject legacy/duplicate payment headers; do not let parsers choose one.
      assert(!req.headers['x-payment'] && !req.headers['payment-payload'], 'unsupported_payment_header');
      const count = req.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === 'payment-signature').length;
      assert(count <= 1, 'duplicate_payment_header');
      const header = req.headers['payment-signature']; assert(!Array.isArray(header), 'invalid_payment_header');
      // GET has a fixed, publicly advertised example; the bound request has no body.
      if (req.method === 'GET')
        assert(!req.headers['transfer-encoding'] && Number(req.headers['content-length'] ?? 0) === 0, 'get_body_refused');
      const raw = req.method === 'GET' ? JSON.stringify(example(name)) : await readBody(req);
      send(res, await seller.request(rail, name, raw, header));
    } catch (e) {
      req.resume();
      send(res, { status: e instanceof LabError ? e.status : 503, body: { error: e instanceof LabError ? e.code : 'lab_unavailable' } });
    } finally { active--; }
  });
  app.requestTimeout = 10000; app.headersTimeout = 5000; app.timeout = 20000;
  app.keepAliveTimeout = 2000; app.maxRequestsPerSocket = 100;
  return app;
}
