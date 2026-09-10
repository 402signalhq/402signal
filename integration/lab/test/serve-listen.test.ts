import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { serveListenOptions } from '../src/config.js';

test('mainnet-style 0.0.0.0 serve bind is dual-stack; offline loopback stays IPv4', async () => {
  assert.deepEqual(serveListenOptions('0.0.0.0', 4021), { port: 4021, host: '::', ipv6Only: false });
  assert.deepEqual(serveListenOptions('127.0.0.1', 4021), { port: 4021, host: '127.0.0.1' });
  const dual = createServer((_q, res) => { res.writeHead(200); res.end('ok'); });
  const loop = createServer((_q, res) => { res.writeHead(200); res.end('ok'); });
  dual.listen(serveListenOptions('0.0.0.0', 0)); await once(dual, 'listening');
  loop.listen(serveListenOptions('127.0.0.1', 0)); await once(loop, 'listening');
  try {
    const d = dual.address(), l = loop.address();
    assert(d && typeof d !== 'string' && l && typeof l !== 'string');
    assert.equal(d.address, '::'); assert.equal(d.family, 'IPv6');
    assert.equal(l.address, '127.0.0.1'); assert.equal(l.family, 'IPv4');
    assert.equal((await fetch(`http://[::1]:${d.port}/`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${d.port}/`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${l.port}/`)).status, 200);
    await assert.rejects(fetch(`http://[::1]:${l.port}/`));
  } finally {
    await Promise.all([
      new Promise<void>(r => { dual.close(() => r()); dual.closeAllConnections(); }),
      new Promise<void>(r => { loop.close(() => r()); loop.closeAllConnections(); }),
    ]);
  }
});
