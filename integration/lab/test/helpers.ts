import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { loadConfig, RAILS, type Rail } from '../src/config.js';
import { Ledger } from '../src/ledger.js';
import { Seller } from '../src/seller.js';
import { server } from '../src/http-server.js';
import { FixtureFacilitator } from '../src/transport.js';
export async function lab(listen = false) {
  const dir = mkdtempSync(join(tmpdir(), '402signal-lab-test-'));
  const config = loadConfig('config/offline.json'); config.ledgerPath = join(dir, 'seller.sqlite'); config.port = 0;
  const ledger = new Ledger(config.ledgerPath);
  const facilitators = Object.fromEntries(RAILS.map(r => [r, new FixtureFacilitator(r, config)])) as Record<Rail, FixtureFacilitator>;
  const seller = new Seller(config, ledger, facilitators); await seller.initialize();
  const app = server(seller);
  if (listen) { app.listen(0, '127.0.0.1'); await once(app, 'listening');
    config.origin = `http://127.0.0.1:${(app.address() as any).port}`; }
  return { dir, config, ledger, seller, facilitators, app,
    async close() { if (app.listening) await new Promise<void>(r => { app.close(() => r()); app.closeAllConnections(); });
      ledger.close(); rmSync(dir, { recursive: true }); } };
}
