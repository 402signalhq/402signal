import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { Pool } from "pg";
import { privateKeyToAccount } from "viem/accounts";
import {
  computeChannelId,
  signVoucher,
} from "@x402/evm/batch-settlement/client";
import {
  BaseBatchMerchant,
  type BaseMerchantConfig,
} from "../src/base-batch-merchant.js";
import { BASE_USDC } from "../src/base-batch-observer.js";
import { server } from "../src/http-server.js";
import { Seller } from "../src/seller.js";
import { Ledger } from "../src/ledger.js";
import { loadConfig } from "../src/config.js";
import { encode64 } from "../src/json.js";
import { configuredBatchHttpMerchants } from "../src/batch-http-config.js";
const db = process.env.LAB_BATCH_PG_DATABASE;
const buyer = privateKeyToAccount(("0x" + "11".repeat(32)) as `0x${string}`),
  receiver = ("0x" + "22".repeat(20)) as `0x${string}`,
  authorizer = ("0x" + "33".repeat(20)) as `0x${string}`;
const origin = "https://merchant.example",
  url = origin + "/base/batch/sha256";
function config(): BaseMerchantConfig {
  return {
    version: 1,
    campaignId: "http-" + randomUUID(),
    url,
    channelConfig: {
      payer: buyer.address,
      payerAuthorizer: buyer.address,
      receiver,
      receiverAuthorizer: authorizer,
      token: BASE_USDC,
      withdrawDelay: 900,
      salt: ("0x" + "44".repeat(32)) as `0x${string}`,
    },
    perCallAtomic: "1000",
    maxCalls: 2,
    expiresAt: Date.now() + 3600000,
  };
}
test("batch module configuration defaults off; invalid activation fails without loading keys or DB", async () => {
  const s = { ready: true, config: { mode: "mainnet" } } as any;
  assert.equal((await configuredBatchHttpMerchants(s, {})).merchants.length, 0);
  await assert.rejects(
    configuredBatchHttpMerchants(s, { LAB_BASE_BATCH: "yes" }),
  );
  await assert.rejects(
    configuredBatchHttpMerchants(s, { LAB_SOLANA_PUSH_SESSION: "yes" }),
  );
});
test(
  "real PostgreSQL + SDK merchant HTTP accepts two signed vouchers once and preserves recovery",
  { skip: !db },
  async () => {
    assert.match(db!, /^lab_batch_/);
    const pool = new Pool({
      database: db,
      host: process.env.LAB_BATCH_PG_HOST,
      port: Number(process.env.LAB_BATCH_PG_PORT),
      user: process.env.LAB_BATCH_PG_USER,
      max: 4,
    });
    const cfg = config();
    let verify = 0,
      settle = 0;
    const provider: any = {
      getSupported: async () => ({
        kinds: [
          {
            x402Version: 2,
            scheme: "batch-settlement",
            network: "eip155:8453",
            extra: { receiverAuthorizer: authorizer },
          },
        ],
        extensions: [],
        signers: {},
      }),
      verify: async () => {
        verify++;
        throw Error(
          "unexpected provider verify for fresh synthetic chain snapshot",
        );
      },
      settle: async () => {
        settle++;
        throw Error("HTTP voucher must not claim or transfer onchain");
      },
    };
    const merchant = new BaseBatchMerchant(pool, cfg, provider);
    await merchant.initialize({ migrateSchema: true });
    const channelId = computeChannelId(cfg.channelConfig, "eip155:8453");
    await merchant.storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: cfg.channelConfig,
      chargedCumulativeAmount: "0",
      signedMaxClaimable: "0",
      signature: "0x",
      balance: "3000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      onchainSyncedAt: Date.now(),
      lastRequestTimestamp: Date.now(),
    }));
    const c = loadConfig("config/offline.json"),
      ledger = new Ledger(":memory:"),
      seller = new Seller(c, ledger);
    await seller.initialize();
    c.origin = origin;
    const app = server(seller, undefined, [
      {
        path: merchant.path,
        authorizationHeader: "payment-signature",
        request: merchant.request.bind(merchant),
      },
      {
        path: "/solana/session/sha256",
        authorizationHeader: "authorization",
        request: async () => ({
          status: 402,
          bodyText: "",
          headers: { "WWW-Authenticate": "Payment synthetic-native-challenge" },
        }),
      },
    ]);
    app.listen(0, "127.0.0.1");
    await once(app, "listening");
    const endpoint = "http://127.0.0.1:" + (app.address() as any).port;
    try {
      const unpaid = await fetch(endpoint + merchant.path);
      assert.equal(unpaid.status, 402);
      assert.equal(
        ((await unpaid.json()) as any).accepts[0].scheme,
        "batch-settlement",
      );
      assert.equal(await merchant.ledger.get("delivery:1:intent"), undefined);
      const native = await fetch(endpoint + "/solana/session/sha256");
      assert.equal(native.status, 402);
      assert.equal(await native.text(), "");
      assert.equal(
        native.headers.get("www-authenticate"),
        "Payment synthetic-native-challenge",
      );
      assert.equal(
        (
          await fetch(endpoint + merchant.path, {
            headers: { Authorization: "unexpected" },
          })
        ).status,
        400,
      );
      assert.equal(
        (await fetch(endpoint + merchant.path, { method: "POST" })).status,
        405,
      );
      for (const cumulative of ["1000", "2000"]) {
        const voucher = await signVoucher(
          { address: buyer.address, signTypedData: buyer.signTypedData },
          channelId,
          cumulative,
          "eip155:8453",
        );
        const payment = {
            x402Version: 2,
            accepted: merchant.requirements,
            resource: { url },
            payload: {
              type: "voucher",
              channelConfig: cfg.channelConfig,
              voucher,
            },
          },
          header = encode64(payment);
        const forged = encode64({
          ...payment,
          payload: {
            ...payment.payload,
            voucher: { ...voucher, signature: "0x" + "00".repeat(65) },
          },
        });
        const rejected = await fetch(endpoint + merchant.path, {
          headers: { "Payment-Signature": forged },
        });
        assert.equal(rejected.status, 400);
        assert.equal(
          await merchant.ledger.get(
            "delivery:" + Number(BigInt(cumulative) / 1000n) + ":intent",
          ),
          undefined,
        );
        const recoverMissing = await fetch(endpoint + merchant.path, {
          headers: { "Payment-Signature": header, "Replay-Only": "1" },
        });
        assert.equal(recoverMissing.status, 503);
        const first = await fetch(endpoint + merchant.path, {
          headers: { "Payment-Signature": header },
        });
        const body: any = await first.json();
        assert.equal(first.status, 200, JSON.stringify(body));
        assert.equal(body.billing.chargedCumulativeAmount, cumulative);
        assert.equal(body.billing.settled, false);
        const again = await fetch(endpoint + merchant.path, {
          headers: { "Payment-Signature": header, "Replay-Only": "1" },
        });
        assert.deepEqual(await again.json(), body);
        const reopened = new BaseBatchMerchant(pool, cfg, provider);
        await reopened.initialize({ migrateSchema: true });
        assert.deepEqual(await reopened.request(url, header, true), {
          status: 200,
          body,
        });
      }
      assert.equal(
        (await merchant.storage.get(channelId))!.chargedCumulativeAmount,
        "2000",
      );
      assert.equal(verify, 0);
      assert.equal(settle, 0);
    } finally {
      await new Promise<void>((resolve) => app.close(() => resolve()));
      app.closeAllConnections();
      ledger.close();
      await pool.end();
    }
  },
);
