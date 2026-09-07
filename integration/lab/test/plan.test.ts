import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const workflow of ['offline', 'testnet', 'mainnet-seller', 'mainnet-route']) {
  test(`plan ${workflow} includes every payment phase without opening a ledger`, () => {
    const dir = mkdtempSync(join(tmpdir(), '402-plan-'));
    try {
      const mainnet = workflow.startsWith('mainnet');
      const c = JSON.parse(readFileSync(mainnet ? 'config/mainnet-buyer.example.json' : 'config/buyer.example.json', 'utf8'));
      c.mode = mainnet ? 'mainnet' : workflow;
      if (workflow === 'offline') { c.routerUrl = 'http://127.0.0.1:1/route'; c.sellerOrigin = 'http://127.0.0.1:4021'; }
      c.ledgerPath = join(dir, 'must-not-exist.sqlite');
      if (workflow === 'mainnet-route') {
        c.routerUrl = 'https://402signal.com/route';
        c.routePilot = {protocol: '402signal-lab-route-v2', routerFeePayers: {base: [], solana: [], algorand: []}};
      }
      const path = join(dir, 'config.json'); writeFileSync(path, JSON.stringify(c));
      const run = spawnSync(process.execPath, ['dist/src/cli.js', 'plan', '--config', path],
        {encoding: 'utf8', env: {PATH: process.env.PATH}, timeout: 10000});
      assert.equal(run.status, 0, run.stdout + run.stderr);
      const plan = JSON.parse(run.stdout);
      const routes = workflow !== 'mainnet-seller';
      assert.equal(plan.workflow, routes ? 'route_and_execute' : 'seller_only');
      assert.equal(plan.run_command, mainnet ? (routes ? 'run-route' : 'run-seller') : 'run');
      assert.equal(plan.max_per_run_atomic, routes ? '4000' : '1000');
      assert.equal(plan.router_max_atomic, routes ? '3000' : '0');
      assert.equal(plan.seller_max_atomic, '1000');
      assert.deepEqual(plan.cap_atomic_per_rail, c.capAtomicPerRail);
      assert.equal(plan.signs_or_sends, false);
      assert.equal(existsSync(c.ledgerPath), false);
    } finally { rmSync(dir, {recursive: true}); }
  });
}
