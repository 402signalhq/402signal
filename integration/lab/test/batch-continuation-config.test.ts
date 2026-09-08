import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { privateKeyToAccount } from "viem/accounts";
import { configuredBatchHttpMerchants, BASE_BATCH_OPT_IN, SOLANA_SESSION_OPT_IN, SOLANA_CONTINUATION_OPT_IN } from "../src/batch-http-config.js";
import { BASE_BATCH_CONTINUATION_OPT_IN } from "../src/base-batch-continuation-merchant.js";
import { BaseBatchLedger } from "../src/base-batch-ledger.js";
import { PostgresChannelStorage } from "../src/batch-postgres-storage.js";
import { CdpBatchReadOnlyProvider, CDP_BATCH_AUTHORIZER } from "../src/base-batch-cdp-provider.js";
import { BASE_USDC } from "../src/base-batch-observer.js";
const db = process.env.LAB_BATCH_PG_DATABASE;
const payer = privateKeyToAccount(("0x" + "11".repeat(32)) as `0x${string}`).address;
const receiver = "0x" + "22".repeat(20);
const origin = "https://merchant.example";
const seller = { ready: true, config: { mode: "mainnet", origin,
  rails: { base: { payTo: receiver }, solana: { payTo: "native-recipient" } } } } as any;
const base = () => ({ version: 2, campaignId: "config-" + randomUUID(), url: origin + "/base/batch/sha256",
  createdAt: Date.now() - 1000, expiresAt: Date.now() + 600000, maxCalls: 3, perCallAtomic: "1000",
  channelConfig: { payer, payerAuthorizer: payer, receiver, receiverAuthorizer: CDP_BATCH_AUTHORIZER,
    token: BASE_USDC, withdrawDelay: 900, salt: "0x" + "44".repeat(32) } });
const native = () => ({ version: 2, campaignId: "config-" + randomUUID(), url: origin + "/solana/session/sha256",
  rpcUrl: "https://rpc.example/", policy: { recipient: "native-recipient", depositAtomic: "4000",
    voucherExpiresAt: Math.floor(Date.now() / 1000) + 7200, gracePeriod: 900 },
  expiresAt: Date.now() + 600000, perCallAtomic: "1000", maxCalls: 3 });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "continuation-config-"));
  const b = join(dir, "base.json"), s = join(dir, "solana.json");
  writeFileSync(b, JSON.stringify(base())); writeFileSync(s, JSON.stringify(native()));
  return { dir, b, s, env: { LAB_BATCH_DATABASE_URL: "postgresql://invalid.invalid/lab_batch_synthetic",
    LAB_BASE_BATCH_CONTINUATION: BASE_BATCH_CONTINUATION_OPT_IN, LAB_BASE_BATCH_CONTINUATION_CONFIG: b,
    LAB_SOLANA_PUSH_CONTINUATION: SOLANA_CONTINUATION_OPT_IN, LAB_SOLANA_CONTINUATION_CONFIG: s,
    LAB_BASE_BATCH_CDP_TOKENS: join(dir, "not-a-real-token") } };
}
test("all four gates default off, reject unknown values and same-path versions before resources", async () => {
  assert.equal((await configuredBatchHttpMerchants(seller, {})).merchants.length, 0);
  for (const env of [
    { LAB_BASE_BATCH_CONTINUATION: "yes" }, { LAB_SOLANA_PUSH_CONTINUATION: "yes" },
    { LAB_BASE_BATCH: BASE_BATCH_OPT_IN, LAB_BASE_BATCH_CONTINUATION: BASE_BATCH_CONTINUATION_OPT_IN },
    { LAB_SOLANA_PUSH_SESSION: SOLANA_SESSION_OPT_IN, LAB_SOLANA_PUSH_CONTINUATION: SOLANA_CONTINUATION_OPT_IN },
  ]) await assert.rejects(configuredBatchHttpMerchants(seller, env));
});
test("v2 configuration rejects origin, recipient, campaign, deadline and database substitution before provider work", async () => {
  const f = setup(); let supported = 0;
  const hook = mock.method(CdpBatchReadOnlyProvider.prototype, "getSupported", async () => { supported++; throw Error("must not load provider"); });
  try {
    for (const change of [ { version: 1 }, { campaignId: "../escape" }, { campaignId: "x".repeat(61) },
      { maxCalls: 2 }, { maxCalls: 65 }, { perCallAtomic: "01000" }, { extra: true },
      { url: origin + "/base/batch/sha256?x=1" }, { url: "https://other.example/base/batch/sha256" },
      { channelConfig: { ...base().channelConfig, receiver: payer } },
      { expiresAt: Date.now() + 86401000 },
    ]) { writeFileSync(f.b, JSON.stringify({ ...base(), ...change })); await assert.rejects(configuredBatchHttpMerchants(seller, f.env)); }
    writeFileSync(f.b, JSON.stringify(base()));
    for (const change of [ { version: 1 }, { campaignId: "x".repeat(49) }, { maxCalls: 64.5 },
      { policy: { ...native().policy, recipient: "other" } }, { url: origin + "/solana/session/sha256?x=1" },
      { rpcUrl: "http://rpc.example/" }, { rpcUrl: "https://user@rpc.example/" }, { rpcUrl: "https://rpc.example/#fragment" },
      { expiresAt: Date.now() + 86400001 },
    ]) { writeFileSync(f.s, JSON.stringify({ ...native(), ...change })); await assert.rejects(configuredBatchHttpMerchants(seller, f.env)); }
    writeFileSync(f.s, JSON.stringify(native()));
    for (const value of ["postgresql://invalid.invalid/replay_production", "postgresql://invalid.invalid/lab_batch_synthetic?database=replay_production",
      "postgresql://invalid.invalid/lab_batch_synthetic?sslmode=require&sslmode=disable", "postgresql://invalid.invalid/lab_batch_synthetic#ignored"])
      await assert.rejects(configuredBatchHttpMerchants(seller, { ...f.env, LAB_BATCH_DATABASE_URL: value }));
    await assert.rejects(configuredBatchHttpMerchants({ ...seller, config: { ...seller.config, origin: "http://merchant.example" } }, f.env));
    await assert.rejects(configuredBatchHttpMerchants({ ...seller, ready: false }, f.env));
    assert.equal(supported, 0);
  } finally { hook.mock.restore(); rmSync(f.dir, { recursive: true }); }
});
test("v2 configuration rejects duplicate keys, oversized files and symlinks", async () => {
  const f = setup();
  try {
    for (const raw of ['{"version":2,"version":2}', " ".repeat(16385)]) {
      writeFileSync(f.b, raw); await assert.rejects(configuredBatchHttpMerchants(seller, f.env));
    }
    writeFileSync(f.b, JSON.stringify(base())); const link = join(f.dir, "link.json"); symlinkSync(f.b, link);
    await assert.rejects(configuredBatchHttpMerchants(seller, { ...f.env, LAB_BASE_BATCH_CONTINUATION_CONFIG: link }));
  } finally { rmSync(f.dir, { recursive: true }); }
});
test("both v2 hooks register with DML readiness, no first native RPC, distinct durable namespaces and no v1 activation", { skip: !db }, async () => {
  assert.match(db!, /^lab_batch_/);
  const f = setup(), suffix = randomUUID().replaceAll("-", "");
  const database = "lab_batch_cont_config_" + suffix, role = "cont_config_" + suffix;
  const password = randomUUID().replaceAll("-", "");
  const connectionOptions = { host: process.env.LAB_BATCH_PG_HOST,
    port: Number(process.env.LAB_BATCH_PG_PORT), user: process.env.LAB_BATCH_PG_USER };
  const admin = new Pool({ ...connectionOptions, database: db });
  let pool: Pool | undefined;
  let loaded: Awaited<ReturnType<typeof configuredBatchHttpMerchants>> | undefined;
  const hooks: Array<{ mock: { restore(): void } }> = [];
  try {
    // A dedicated disposable database and login keep migration authority out of
    // the loader, and leave the other shared-PG fixtures' ACLs untouched.
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '${password}'`);
    await admin.query(`CREATE DATABASE ${database}`);
    pool = new Pool({ ...connectionOptions, database });
    await pool.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await pool.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
    await pool.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await new BaseBatchLedger(pool, "schema-setup").initialize();
    await new PostgresChannelStorage(pool, "schema-setup").initialize();
    await pool.query(`GRANT SELECT, INSERT, UPDATE ON public.lab_base_batch_stages_v1 TO ${role}`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.lab_batch_channels_v1 TO ${role}`);
    const b = base(), s = native();
    writeFileSync(f.b, JSON.stringify(b)); writeFileSync(f.s, JSON.stringify(s));
    hooks.push(
      mock.method(BaseBatchLedger.prototype, "initialize", async () => { throw Error("runtime DDL prohibited"); }),
      mock.method(PostgresChannelStorage.prototype, "initialize", async () => { throw Error("runtime DDL prohibited"); }),
      mock.method(CdpBatchReadOnlyProvider.prototype, "getSupported", async () => ({ kinds: [{ x402Version: 2, scheme: "batch-settlement", network: "eip155:8453", extra: { receiverAuthorizer: CDP_BATCH_AUTHORIZER } }], extensions: [], signers: {} })),
      mock.method(globalThis, "fetch", async () => { throw Error("unexpected provider/network action"); }),
    );
    const connection = new URL("postgresql://127.0.0.1/" + database);
    connection.port = process.env.LAB_BATCH_PG_PORT || process.env.PGPORT || "5432";
    connection.username = role; connection.password = password;
    connection.searchParams.set("sslmode", "disable");
    loaded = await configuredBatchHttpMerchants(seller, { ...f.env, LAB_BATCH_DATABASE_URL: connection.href });
    assert.deepEqual(loaded.merchants.map(m => [m.path, m.authorizationHeader]), [["/base/batch/sha256", "payment-signature"], ["/solana/session/sha256", "authorization"]]);
    assert.equal((await loaded.merchants[0]!.request(b.url)).status, 402);
    assert.equal((await loaded.merchants[1]!.request(s.url, undefined, true)).status, 503);
    assert.equal((await new BaseBatchLedger(pool, "merchant-v2-" + b.campaignId).require("plan")).version, 2);
    assert.equal((await new BaseBatchLedger(pool, "solana-continuation-merchant-" + s.campaignId).require("plan")).version, 2);
    assert.equal(await new BaseBatchLedger(pool, "merchant-" + b.campaignId).get("plan"), undefined);
    assert.equal(await new BaseBatchLedger(pool, "solana-merchant-" + s.campaignId).get("plan"), undefined);
  } finally {
    await loaded?.close(); hooks.forEach(h => h.mock.restore()); await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end(); rmSync(f.dir, { recursive: true });
  }
});
