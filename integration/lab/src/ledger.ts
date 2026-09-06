import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { assert, atomic } from './json.js';
import type { Rail } from './config.js';
import type { PaymentIntent } from './mainnet-policy.js';
import type { Confirmation } from './confirmation.js';

export interface Outcome { status: number; body: any; headers?: Record<string, string>; }
export class Ledger {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    const existing = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    // Never initialize against production replay/history/PQ or an unmarked DB.
    try {
      assert(existing.every(t => ['payments', 'spend', 'lab_meta', 'intents', 'route_runs'].includes(t.name)) &&
        (!existing.length || existing.some(t => t.name === 'lab_meta')), 'foreign_database_refused');
      if (existing.length) assert((this.db.prepare('SELECT value FROM lab_meta WHERE key=?').get('schema') as any)?.value === '402signal-lab-v1', 'foreign_database_refused');
    } catch (e) { this.db.close(); throw e; }
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS lab_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO lab_meta VALUES ('schema', '402signal-lab-v1');
      CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, scope TEXT NOT NULL,
        state TEXT NOT NULL, outcome TEXT, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS spend (id TEXT PRIMARY KEY, rail TEXT NOT NULL,
        amount INTEGER NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY, intent TEXT NOT NULL, receipt TEXT, confirmation TEXT);
      CREATE TABLE IF NOT EXISTS route_runs (id TEXT PRIMARY KEY, report TEXT NOT NULL);`);
  }
  lookup(id: string, scope: string): { run: false; outcome: Outcome } | undefined {
    const row = this.db.prepare('SELECT * FROM payments WHERE id=?').get(id) as any;
    if (!row) return undefined;
    assert(row && row.scope === scope, 'authorization_scope_conflict', 409);
    if (row.outcome && row.created + 120000 > Date.now()) return { run: false, outcome: JSON.parse(row.outcome) };
    return { run: false, outcome: { status: 409, body: { error: 'authorization_incomplete', billing: { settled: null, settlement_state: 'unknown' } } } };
  }
  capacity() {
    const count = (this.db.prepare('SELECT count(*) AS n FROM payments').get() as any).n as number;
    return { ready: count < 10000, remaining: Math.max(0, 10000 - count) };
  }
  reserve(id: string, scope: string): { run: boolean; outcome?: Outcome } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Existing outcomes and incomplete economic records remain accessible
      // even when new admission is full. Never expire economic identities.
      const existing = this.lookup(id, scope);
      if (existing) { this.db.exec('COMMIT'); return existing; }
      this.db.prepare('UPDATE payments SET outcome=NULL WHERE outcome IS NOT NULL AND created<=?').run(Date.now() - 120000);
      assert(this.capacity().ready, 'ledger_capacity_reached', 503);
      this.db.prepare('INSERT INTO payments VALUES (?, ?, ?, NULL, ?)').run(id, scope, 'reserved', Date.now());
      this.db.exec('COMMIT');
      return { run: true };
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  attempting(id: string): void {
    const r = this.db.prepare("UPDATE payments SET state='attempted' WHERE id=? AND state='reserved'").run(id);
    assert(r.changes === 1, 'ledger_write_failed', 503);
  }
  finish(id: string, state: string, result: Outcome): void {
    const r = this.db.prepare('UPDATE payments SET state=?, outcome=? WHERE id=? AND outcome IS NULL').run(state, JSON.stringify(result), id);
    assert(r.changes === 1, 'ledger_write_failed', 503);
  }
  bindCampaign(hash: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare("SELECT value FROM lab_meta WHERE key='mainnet_campaign'").get() as any;
      if (!previous) {
        assert(!(this.db.prepare('SELECT 1 FROM spend LIMIT 1').get()) && !(this.db.prepare('SELECT 1 FROM payments LIMIT 1').get()), 'fresh_mainnet_campaign_ledger_required');
        this.db.prepare("INSERT INTO lab_meta VALUES ('mainnet_campaign',?)").run(hash);
      } else assert(previous.value === hash, 'campaign_scope_changed');
      this.db.exec('COMMIT');
    } catch (e) {this.db.exec('ROLLBACK'); throw e;}
  }
  bindRoutePolicy(hash: string) {
    this.db.prepare("INSERT OR IGNORE INTO lab_meta VALUES ('route_policy',?)").run(hash);
    assert((this.db.prepare("SELECT value FROM lab_meta WHERE key='route_policy'").get() as any)?.value === hash, 'route_policy_changed');
  }
  saveRoute(id: string, report: unknown) {
    this.db.prepare('INSERT INTO route_runs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET report=excluded.report').run(id,JSON.stringify(report));
  }
  getRoute(id: string): any {
    const r = this.db.prepare('SELECT report FROM route_runs WHERE id=?').get(id) as any;
    assert(r,'route_run_not_found'); return JSON.parse(r.report);
  }
  recordIntent(id: string, intent: PaymentIntent) {
    this.db.prepare('INSERT INTO intents(id,intent) VALUES (?,?)').run(id,JSON.stringify(intent));
  }
  recordReceipt(id: string, transaction: string) {
    assert(this.db.prepare('UPDATE intents SET receipt=? WHERE id=? AND receipt IS NULL').run(transaction,id).changes === 1, 'intent_write_failed');
  }
  recordConfirmation(id: string, result: Confirmation) {
    assert(this.db.prepare('UPDATE intents SET confirmation=? WHERE id=?').run(JSON.stringify(result),id).changes === 1, 'intent_write_failed');
  }
  getIntent(id: string) {
    const row = this.db.prepare('SELECT * FROM intents WHERE id=?').get(id) as any;
    assert(row,'intent_not_found'); return {intent:JSON.parse(row.intent) as PaymentIntent, transaction:row.receipt as string | null};
  }
  reserveSpend(id: string, rail: Rail, amount: string, cap: string, haltOnPending = false): void {
    const n = atomic(amount), limit = atomic(cap);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      assert(!this.db.prepare('SELECT 1 FROM spend WHERE id=?').get(id), 'run_already_reserved');
      if (haltOnPending) assert(!this.db.prepare("SELECT 1 FROM spend WHERE rail=? AND state NOT IN ('complete','reconciled','not_submitted','route_free_miss')").get(rail), 'prior_mainnet_run_unresolved');
      const sum = this.db.prepare('SELECT COALESCE(sum(amount),0) AS n FROM spend WHERE rail=?').get(rail) as any;
      assert(BigInt(sum.n) + n <= limit, 'spend_cap_exceeded');
      this.db.prepare('INSERT INTO spend VALUES (?, ?, ?, ?, ?)').run(id, rail, Number(n), 'reserved', Date.now());
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  spendState(id: string, state: string): void {
    assert(this.db.prepare('UPDATE spend SET state=? WHERE id=?').run(state, id).changes === 1, 'spend_write_failed');
  }
  summary() { return this.db.prepare('SELECT state,count(*) AS count FROM payments GROUP BY state').all(); }
  close() { this.db.close(); }
}
