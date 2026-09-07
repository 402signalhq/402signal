import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { Pool } from "pg";
import { privateKeyToAccount } from "viem/accounts";
import {
  computeChannelId,
  signVoucher,
} from "@x402/evm/batch-settlement/client";
import {
  CdpBatchReadOnlyProvider,
  CDP_BATCH_AUTHORIZER,
} from "../src/base-batch-cdp-provider.js";
import { BaseBatchMerchant } from "../src/base-batch-merchant.js";
import { BASE_USDC } from "../src/base-batch-observer.js";
import { encode64 } from "../src/json.js";
const base = "https://api.cdp.coinbase.com/platform/v2/x402";
const b64 = (x: unknown) =>
  Buffer.from(JSON.stringify(x)).toString("base64url");
function token(
  kind: "supported" | "verify",
  extra: Record<string, unknown> = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return (
    b64({
      alg: "EdDSA",
      typ: "JWT",
      kid: "synthetic-key-id",
      nonce: "a".repeat(32),
    }) +
    "." +
    b64({
      sub: "synthetic-key-id",
      iss: "cdp",
      aud: ["cdp_service"],
      nbf: now,
      exp: now + 120,
      uri:
        (kind === "supported" ? "GET" : "POST") +
        " api.cdp.coinbase.com/platform/v2/x402/" +
        kind,
      ...extra,
    }) +
    "." +
    Buffer.alloc(64).toString("base64url")
  );
}
const supported = {
  kinds: [
    {
      x402Version: 2,
      scheme: "batch-settlement",
      network: "eip155:8453",
      extra: { receiverAuthorizer: CDP_BATCH_AUTHORIZER },
    },
  ],
  extensions: [],
  signers: {},
};
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cdp-batch-auth-")),
    file = join(directory, "tokens.json"),
    campaignId = "cdp-" + randomUUID();
  const bundle = () => ({
    version: 1,
    campaignId,
    supportedJwt: token("supported"),
    verifyJwt: token("verify"),
  });
  const write = (value: any) =>
    writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  write(bundle());
  return {
    directory,
    file,
    campaignId,
    bundle,
    write,
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}
const requirements: any = {
  scheme: "batch-settlement",
  network: "eip155:8453",
  asset: BASE_USDC,
  amount: "1000",
  payTo: "0x" + "2".repeat(40),
  maxTimeoutSeconds: 300,
  extra: { receiverAuthorizer: CDP_BATCH_AUTHORIZER },
};
const voucher: any = { x402Version: 2, payload: { type: "voucher" } };
test("separate method/path tokens, bounded transport and zero cloud settlement authority", async () => {
  const f = fixture();
  let calls = 0;
  const send: typeof fetch = async (input, init) => {
    calls++;
    const kind = String(input).endsWith("/supported") ? "supported" : "verify";
    assert.equal(String(input), base + "/" + kind);
    assert.equal(init?.method, kind === "supported" ? "GET" : "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    assert.ok(init?.signal);
    const h = init?.headers as Record<string, string>;
    assert.equal(
      h.Authorization,
      "Bearer " +
        (kind === "supported"
          ? JSON.parse(readFileSync(f.file, "utf8")).supportedJwt
          : JSON.parse(readFileSync(f.file, "utf8")).verifyJwt),
    );
    return new Response(
      JSON.stringify(
        kind === "supported"
          ? supported
          : { isValid: true, payer: requirements.payTo },
      ),
    );
  };
  try {
    const provider = new CdpBatchReadOnlyProvider(f.file, f.campaignId, send);
    await provider.getSupported();
    await provider.verify(voucher, requirements);
    assert.equal(calls, 2);
    await assert.rejects(
      provider.settle(voucher, requirements),
      /cloud_batch_settlement_disabled/,
    );
    await assert.rejects(
      provider.verify(
        { ...voucher, payload: { type: "deposit" } },
        requirements,
      ),
    );
    assert.equal(calls, 2);
  } finally {
    f.close();
  }
});
test("owner token file rejects symlink, broad mode, wrong campaign, duplicate keys and oversized content before network", async () => {
  const f = fixture();
  let calls = 0;
  const provider = new CdpBatchReadOnlyProvider(
    f.file,
    f.campaignId,
    async () => {
      calls++;
      return new Response("{}");
    },
  );
  try {
    chmodSync(f.file, 0o644);
    await assert.rejects(provider.getSupported());
    chmodSync(f.file, 0o600);
    f.write({ ...f.bundle(), campaignId: "other-campaign" });
    await assert.rejects(provider.getSupported());
    f.write({ ...f.bundle(), masterKey: "synthetic-forbidden" });
    await assert.rejects(provider.getSupported());
    writeFileSync(f.file, '{"version":1,"version":1}');
    await assert.rejects(provider.getSupported());
    writeFileSync(f.file, "x".repeat(20001));
    await assert.rejects(provider.getSupported());
    unlinkSync(f.file);
    const target = join(f.directory, "target");
    writeFileSync(target, JSON.stringify(f.bundle()), { mode: 0o600 });
    symlinkSync(target, f.file);
    await assert.rejects(provider.getSupported());
    assert.equal(calls, 0);
  } finally {
    f.close();
  }
});
test("wrong JWT endpoint, expiry, excessive lifetime and malformed signature fail; atomic fresh token replacement works without restart", async () => {
  const f = fixture();
  let calls = 0;
  const provider = new CdpBatchReadOnlyProvider(
    f.file,
    f.campaignId,
    async () => {
      calls++;
      return new Response(JSON.stringify(supported));
    },
  );
  try {
    const now = Math.floor(Date.now() / 1000);
    for (const patch of [
      { uri: "POST api.cdp.coinbase.com/platform/v2/x402/settle" },
      { exp: now + 5 },
      { nbf: now + 1 },
      { exp: now + 121 },
      { aud: ["other"] },
    ]) {
      f.write({ ...f.bundle(), supportedJwt: token("supported", patch) });
      await assert.rejects(provider.getSupported());
    }
    f.write({
      ...f.bundle(),
      supportedJwt: token("supported").slice(0, -1) + "=",
    });
    await assert.rejects(provider.getSupported());
    assert.equal(calls, 0);
    const next = join(f.directory, "replacement");
    writeFileSync(next, JSON.stringify(f.bundle()), { mode: 0o600 });
    renameSync(next, f.file);
    await provider.getSupported();
    assert.equal(calls, 1);
  } finally {
    f.close();
  }
});
test("transport errors and upstream text remain generic, without token leakage or retry", async () => {
  const f = fixture();
  let calls = 0;
  try {
    const provider = new CdpBatchReadOnlyProvider(
      f.file,
      f.campaignId,
      async () => {
        calls++;
        throw Error("private-token-canary");
      },
    );
    await assert.rejects(
      provider.getSupported(),
      (e) => (e as Error).message === "batch_provider_unavailable",
    );
    assert.equal(calls, 1);
  } finally {
    f.close();
  }
});
test(
  "real SDK plus PostgreSQL: first voucher remotely verified with CDP token, next verified locally, provider settle never called",
  { skip: !process.env.LAB_BATCH_PG_DATABASE },
  async () => {
    const f = fixture(),
      db = process.env.LAB_BATCH_PG_DATABASE!;
    assert.match(db, /^lab_batch_/);
    const pool = new Pool({
      database: db,
      host: process.env.LAB_BATCH_PG_HOST,
      port: Number(process.env.LAB_BATCH_PG_PORT),
      user: process.env.LAB_BATCH_PG_USER,
      max: 4,
    });
    const buyer = privateKeyToAccount(
        ("0x" + "11".repeat(32)) as `0x${string}`,
      ),
      receiver = ("0x" + "22".repeat(20)) as `0x${string}`;
    let supportedCalls = 0,
      verifyCalls = 0,
      settleCalls = 0;
    const app = createServer(async (req, res) => {
      let raw = "";
      for await (const b of req) raw += b;
      const kind = req.url?.slice(1);
      if (kind === "supported") {
        supportedCalls++;
        assert.equal(req.method, "GET");
        assert.equal(
          req.headers.authorization,
          "Bearer " + JSON.parse(readFileSync(f.file, "utf8")).supportedJwt,
        );
        res.end(JSON.stringify(supported));
        return;
      }
      if (kind === "settle") settleCalls++;
      assert.equal(kind, "verify");
      verifyCalls++;
      assert.equal(req.method, "POST");
      assert.equal(
        req.headers.authorization,
        "Bearer " + JSON.parse(readFileSync(f.file, "utf8")).verifyJwt,
      );
      assert.equal(JSON.parse(raw).paymentPayload.payload.type, "voucher");
      res.end(
        JSON.stringify({
          isValid: true,
          payer: buyer.address,
          extra: {
            balance: "3000",
            totalClaimed: "0",
            withdrawRequestedAt: 0,
            refundNonce: 0,
          },
        }),
      );
    });
    app.listen(0, "127.0.0.1");
    await once(app, "listening");
    const origin = "http://127.0.0.1:" + (app.address() as any).port;
    const send: typeof fetch = async (input, init) => {
      const path = String(input).slice(base.length);
      const response = await fetch(origin + path, init);
      return new Response(await response.text(), {
        status: response.status,
        headers: response.headers,
      });
    };
    const provider = new CdpBatchReadOnlyProvider(f.file, f.campaignId, send);
    const cfg = {
      version: 1 as const,
      campaignId: f.campaignId,
      url: "https://merchant.example/base/batch/sha256",
      channelConfig: {
        payer: buyer.address,
        payerAuthorizer: buyer.address,
        receiver,
        receiverAuthorizer: CDP_BATCH_AUTHORIZER as `0x${string}`,
        token: BASE_USDC as `0x${string}`,
        withdrawDelay: 900,
        salt: ("0x" + "44".repeat(32)) as `0x${string}`,
      },
      perCallAtomic: "1000",
      maxCalls: 2,
      expiresAt: Date.now() + 60000,
    };
    try {
      const merchant = new BaseBatchMerchant(pool, cfg, provider);
      await merchant.initialize({ migrateSchema: true });
      const channelId = computeChannelId(cfg.channelConfig, "eip155:8453");
      assert.equal(await merchant.storage.get(channelId), undefined);
      for (const amount of ["1000", "2000"]) {
        const signed = await signVoucher(
          { address: buyer.address, signTypedData: buyer.signTypedData },
          channelId,
          amount,
          "eip155:8453",
        );
        const payment = {
          x402Version: 2,
          resource: { url: cfg.url },
          accepted: merchant.requirements,
          payload: {
            type: "voucher",
            channelConfig: cfg.channelConfig,
            voucher: signed,
          },
        };
        const out = await merchant.request(cfg.url, encode64(payment));
        assert.equal(out.status, 200, JSON.stringify(out));
        assert.equal(out.body.billing.chargedCumulativeAmount, amount);
      }
      assert.equal(supportedCalls, 1);
      assert.equal(verifyCalls, 1);
      assert.equal(settleCalls, 0);
      await assert.rejects(provider.settle(voucher, requirements));
      assert.equal(settleCalls, 0);
    } finally {
      await new Promise<void>((r) => app.close(() => r()));
      app.closeAllConnections();
      await pool.end();
      f.close();
    }
  },
);
