import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { Pool } from "pg";
import { privateKeyToAccount } from "viem/accounts";
import { computeChannelId, signVoucher } from "@x402/evm/batch-settlement/client";
import { BaseBatchContinuationMerchant, type BaseContinuationMerchantConfig } from "../src/base-batch-continuation-merchant.js";
import { BASE_USDC } from "../src/base-batch-observer.js";
import { canonical, digest, encode64 } from "../src/json.js";
import { server } from "../src/http-server.js";
import { Seller } from "../src/seller.js";
import { Ledger } from "../src/ledger.js";
import { loadConfig } from "../src/config.js";
const db = process.env.LAB_BATCH_PG_DATABASE;
const buyer = privateKeyToAccount(("0x" + "11".repeat(32)) as `0x${string}`);
const receiver = ("0x" + "22".repeat(20)) as `0x${string}`;
const authorizer = ("0x" + "33".repeat(20)) as `0x${string}`;
const url = "https://merchant.example/base/batch/sha256";
function config(maxCalls = 3): BaseContinuationMerchantConfig {
  return { version: 2, createdAt: Date.now() - 1000, expiresAt: Date.now() + 3600000,
    campaignId: "continuation-" + randomUUID(), url, perCallAtomic: "1000", maxCalls,
    channelConfig: { payer: buyer.address, payerAuthorizer: buyer.address, receiver,
      receiverAuthorizer: authorizer, token: BASE_USDC, withdrawDelay: 900,
      salt: ("0x" + "44".repeat(32)) as `0x${string}` } };
}
function provider() {
  return { getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "batch-settlement",
      network: "eip155:8453", extra: { receiverAuthorizer: authorizer } }], extensions: [], signers: {} }),
    verify: async () => { throw Error("unexpected external verify"); },
    settle: async () => { throw Error("onchain action forbidden"); } } as any;
}
async function setup(maxCalls = 3, cfg = config(maxCalls)) {
  assert.match(db!, /^lab_batch_/);
  const pool = new Pool({ database: db, host: process.env.LAB_BATCH_PG_HOST,
    port: Number(process.env.LAB_BATCH_PG_PORT), user: process.env.LAB_BATCH_PG_USER, max: 4 });
  const p = provider();
  const m = new BaseBatchContinuationMerchant(pool, cfg, p);
  await m.initialize({ migrateSchema: true });
  const channelId = computeChannelId(cfg.channelConfig, "eip155:8453");
  await m.storage.updateChannel(channelId, () => ({ channelId, channelConfig: cfg.channelConfig,
    chargedCumulativeAmount: "0", signedMaxClaimable: "0", signature: "0x", balance: String((maxCalls + 2) * 1000),
    totalClaimed: "0", withdrawRequestedAt: 0, refundNonce: 0, onchainSyncedAt: Date.now(), lastRequestTimestamp: Date.now() }));
  const header = async (n: number) => encode64({ x402Version: 2, accepted: m.requirements, resource: { url },
    payload: { type: "voucher", channelConfig: cfg.channelConfig,
      voucher: await signVoucher({ address: buyer.address, signTypedData: buyer.signTypedData }, channelId, String(n * 1000), "eip155:8453") } });
  const scope = (sequence: number, authorization: string) => ({ recoveryOnly: true as const, channelId, sequence,
    requestDigest: digest(canonical({ body: "", method: "GET", url })), authorizationDigest: digest(authorization) });
  return { pool, m, cfg, p, channelId, header, scope };
}
test("Base continuation validates immutable count, price, and fixed deadline bounds", () => {
  const p = {} as Pool;
  for (const change of [{ maxCalls: 2 }, { maxCalls: 65 }, { maxCalls: 3.1 }, { perCallAtomic: "1001" },
      { version: 1 }, { expiresAt: Date.now() + 86401000 }, { createdAt: -1 }]) {
    assert.throws(() => new BaseBatchContinuationMerchant(p, { ...config(), ...change } as any, provider()));
  }
  const m = new BaseBatchContinuationMerchant(p, config(64), provider());
  assert.ok(Object.isFrozen(m.config)); assert.ok(Object.isFrozen(m.config.channelConfig));
});
for (const maxCalls of [3, 10, 64]) test(`actual SDK and PG accept ${maxCalls} vouchers; exact ack survives restart and read-only recovery`, { skip: !db }, async () => {
  const f = await setup(maxCalls);
  try {
    const originalSettle = f.m.server.settlePayment.bind(f.m.server);
    const actualAcks: string[] = [];
    f.m.server.settlePayment = async (...args: Parameters<typeof originalSettle>) => {
      const result = await originalSettle(...args); actualAcks.push(encode64(result)); return result;
    };
    for (let n = 1; n <= maxCalls; n++) {
      const h = await f.header(n);
      assert.equal(await f.m.readReceipt(f.scope(n, h)), undefined);
      const result = await f.m.request(url, h);
      assert.equal(result.status, 200, JSON.stringify(result));
      assert.equal(result.headers?.["PAYMENT-RESPONSE"], actualAcks[n - 1]);
      const ack = JSON.parse(Buffer.from(result.headers!["PAYMENT-RESPONSE"]!, "base64").toString());
      assert.equal(ack.success, true); assert.equal(ack.transaction, "");
      assert.equal(ack.network, "eip155:8453"); assert.equal(ack.extra.chargedAmount, "1000");
      assert.equal(ack.extra.channelState.channelId, f.channelId);
      assert.equal(ack.extra.channelState.chargedCumulativeAmount, String(n * 1000));
      assert.equal(result.body.billing.settled, false);
      // No initialize or SDK call is needed for the authority-free lookup.
      const reopened = new BaseBatchContinuationMerchant(f.pool, f.cfg, provider());
      reopened.server.initialize = async () => { throw Error("lookup must not initialize SDK"); };
      reopened.ledger.once = async () => { throw Error("lookup must not write"); };
      reopened.ledger.transition = async () => { throw Error("lookup must not transition"); };
      assert.deepEqual(await reopened.readReceipt(f.scope(n, h)), result);
      assert.deepEqual(await f.m.request(url, h, true), result);
      await assert.rejects(reopened.readReceipt({ ...f.scope(n, h), authorizationDigest: "0".repeat(64) }));
    }
    assert.equal(actualAcks.length, maxCalls);
    await assert.rejects(f.m.request(url, await f.header(maxCalls + 1)));
    assert.equal((await f.m.storage.get(f.channelId))?.chargedCumulativeAmount, String(maxCalls * 1000));
    const altered = new BaseBatchContinuationMerchant(f.pool, { ...f.cfg, maxCalls: maxCalls === 64 ? 63 : maxCalls + 1 }, f.p);
    await assert.rejects(altered.initialize());
  } finally { await f.pool.end(); }
});
test("continuation order/concurrency cannot duplicate accounting and incomplete outcomes stay fenced", { skip: !db }, async () => {
  const f = await setup();
  try {
    await assert.rejects(f.m.request(url, await f.header(2)));
    assert.equal(await f.m.ledger.get("delivery:2:intent"), undefined);
    const h = await f.header(1);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => f.m.request(url, h)));
    assert.ok(results.some(x => x.status === "fulfilled" && x.value.status === 200));
    assert.equal((await f.m.storage.get(f.channelId))?.chargedCumulativeAmount, "1000");
    const original = f.m.server.settlePayment.bind(f.m.server);
    let calls = 0;
    f.m.server.settlePayment = async (...args: Parameters<typeof original>) => { calls++; await original(...args); throw Error("lost SDK ack"); };
    const h2 = await f.header(2), result = await f.m.request(url, h2);
    assert.equal(result.status, 503);
    assert.deepEqual(await f.m.readReceipt(f.scope(2, h2)), result);
    assert.deepEqual(await f.m.request(url, h2), result);
    await assert.rejects(f.m.request(url, await f.header(3)));
    assert.equal(calls, 1); assert.equal((await f.m.storage.get(f.channelId))?.chargedCumulativeAmount, "2000");
  } finally { await f.pool.end(); }
});
test("completed predecessor repairs only its progress on a new authorized call; expired recovery remains read-only", { skip: !db }, async () => {
  const f = await setup();
  try {
    const transition = f.m.ledger.transition.bind(f.m.ledger);
    f.m.ledger.transition = async (from, to) => { if (from === "inflight:1") throw Error("lost transition before commit"); await transition(from, to); };
    const h1 = await f.header(1);
    await assert.rejects(f.m.request(url, h1));
    assert.equal((await f.m.readReceipt(f.scope(1, h1)))?.status, 200);
    assert.equal((await f.m.ledger.get("progress")).state, "inflight:1");
    f.m.ledger.transition = transition;
    assert.equal((await f.m.request(url, await f.header(2))).status, 200);
    assert.equal((await f.m.ledger.get("progress")).state, "active:2");
    const now = Date.now; Date.now = () => f.cfg.expiresAt + 1;
    try { assert.equal((await f.m.readReceipt(f.scope(1, h1)))?.status, 200); await assert.rejects(f.m.request(url, await f.header(3))); }
    finally { Date.now = now; }
  } finally { await f.pool.end(); }
});
test("actual SDK ack field mismatches produce durable unknown, never fabricated success", { skip: !db }, async () => {
  for (const mutate of [
    (a: any) => a.success = false, (a: any) => a.network = "eip155:1", (a: any) => a.transaction = "0x1234",
    (a: any) => a.extra.chargedAmount = "999", (a: any) => a.extra.channelState.channelId = "0x" + "00".repeat(32),
    (a: any) => a.extra.channelState.chargedCumulativeAmount = "2000", (a: any) => a.payer = receiver,
  ]) {
    const f = await setup();
    try {
      const original = f.m.server.settlePayment.bind(f.m.server);
      f.m.server.settlePayment = async (...args: Parameters<typeof original>) => { const a = await original(...args); mutate(a); return a; };
      const h = await f.header(1), result = await f.m.request(url, h);
      assert.equal(result.status, 503); assert.equal(result.headers?.["PAYMENT-RESPONSE"], undefined);
      assert.deepEqual(await f.m.readReceipt(f.scope(1, h)), result);
      await assert.rejects(f.m.request(url, await f.header(2)));
    } finally { await f.pool.end(); }
  }
});
test("HTTP delivers original PAYMENT-RESPONSE and replay headers with actual SDK", { skip: !db }, async () => {
  const f = await setup(), c = loadConfig("config/offline.json"), ledger = new Ledger(":memory:");
  const seller = new Seller(c, ledger); await seller.initialize(); c.origin = "https://merchant.example";
  const app = server(seller, undefined, [{ path: f.m.path, authorizationHeader: "payment-signature", request: f.m.request.bind(f.m) }]);
  app.listen(0, "127.0.0.1"); await once(app, "listening");
  const endpoint = "http://127.0.0.1:" + (app.address() as any).port + f.m.path;
  try {
    assert.equal((await fetch(endpoint)).status, 402);
    const h = await f.header(1), a = await fetch(endpoint, { headers: { "Payment-Signature": h } });
    assert.equal(a.status, 200); const body = await a.text(), ack = a.headers.get("payment-response"); assert.ok(ack);
    const b = await fetch(endpoint, { headers: { "Payment-Signature": h, "Replay-Only": "1" } });
    assert.equal(b.status, 200); assert.equal(await b.text(), body); assert.equal(b.headers.get("payment-response"), ack);
  } finally { await new Promise<void>(resolve => app.close(() => resolve())); app.closeAllConnections(); ledger.close(); await f.pool.end(); }
});
