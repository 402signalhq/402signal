import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { privateKeyToAccount } from "viem/accounts";
import {
  configuredBatchHttpMerchants,
  BASE_BATCH_OPT_IN,
  SOLANA_SESSION_OPT_IN,
  SOLANA_CONTINUATION_OPT_IN,
  optionalBatchProfileError,
  optionalSessionRuntime,
} from "../src/batch-http-config.js";
import { BaseBatchMerchant } from "../src/base-batch-merchant.js";
import { BASE_USDC } from "../src/base-batch-observer.js";
import { LabError } from "../src/json.js";
import { server } from "../src/http-server.js";
import { lab } from "./helpers.js";
import { http } from "../src/transport.js";
import { encode64 } from "../src/json.js";

const receiver = privateKeyToAccount(("0x" + "22".repeat(32)) as `0x${string}`).address;
const payer = privateKeyToAccount(("0x" + "11".repeat(32)) as `0x${string}`).address;
const origin = "https://merchant.example";
const mainnetSeller = {
  ready: true,
  config: {
    mode: "mainnet",
    origin,
    rails: { base: { payTo: receiver }, solana: { payTo: "native-recipient" } },
  },
} as any;

function campaign(extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    campaignId: "ready-" + randomUUID().slice(0, 8),
    url: origin + "/base/batch/sha256",
    channelConfig: {
      payer,
      payerAuthorizer: payer,
      receiver,
      receiverAuthorizer: "0x" + "33".repeat(20),
      token: BASE_USDC,
      withdrawDelay: 900,
      salt: "0x" + "44".repeat(32),
    },
    perCallAtomic: "1000",
    maxCalls: 2,
    expiresAt: Date.now() + 3600000,
    ...extra,
  };
}

function envFor(campaignPath: string, tokens?: string) {
  return {
    LAB_BASE_BATCH: BASE_BATCH_OPT_IN,
    LAB_BASE_BATCH_CONFIG: campaignPath,
    LAB_BATCH_DATABASE_URL: "postgresql://127.0.0.1/lab_batch_readiness",
    ...(tokens ? { LAB_BASE_BATCH_CDP_TOKENS: tokens } : {}),
  };
}

function sessionCampaign(extra: Record<string, unknown> = {}) {
  return {
    campaignId: "session-" + randomUUID().slice(0, 8),
    url: origin + "/solana/session/sha256",
    policy: { recipient: "native-recipient", depositAtomic: "4000" },
    rpcUrl: "https://rpc.example/",
    perCallAtomic: "1000",
    maxCalls: 2,
    ...extra,
  };
}

function sessionEnv(sessionPath: string) {
  return {
    LAB_SOLANA_PUSH_SESSION: SOLANA_SESSION_OPT_IN,
    LAB_SOLANA_SESSION_CONFIG: sessionPath,
    LAB_BATCH_DATABASE_URL: "postgresql://127.0.0.1/lab_batch_readiness",
  };
}

function continuationCampaign(extra: Record<string, unknown> = {}) {
  return {
    version: 2,
    campaignId: "cont-" + randomUUID().slice(0, 8),
    url: origin + "/solana/session/sha256",
    rpcUrl: "https://rpc.example/",
    policy: {
      recipient: "native-recipient",
      depositAtomic: "4000",
      voucherExpiresAt: Math.floor(Date.now() / 1000) + 7200,
      gracePeriod: 900,
    },
    expiresAt: Date.now() + 600000,
    perCallAtomic: "1000",
    maxCalls: 3,
    ...extra,
  };
}

async function assertExactReadyAndSessionRefused(
  merchants: Awaited<ReturnType<typeof configuredBatchHttpMerchants>>["merchants"],
  profile: string,
  error: string,
) {
  const l = await lab();
  const app = server(l.seller, undefined, merchants);
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  const originUrl = `http://127.0.0.1:${(app.address() as any).port}`;
  try {
    const ready = await http(originUrl + "/ready", "GET");
    assert.equal(ready.status, 200);
    assert.equal(ready.body.ok, true);
    assert.equal(ready.body.unavailable_profiles.length, 1);
    assert.equal(ready.body.unavailable_profiles[0].profile, profile);
    assert.equal(ready.body.unavailable_profiles[0].path, "/solana/session/sha256");
    assert.equal(ready.body.unavailable_profiles[0].error, error);
    assert.equal(ready.body.unavailable_profiles[0].new_payment_allowed, false);
    const challenge = await http(originUrl + "/solana/payload/sha256", "GET");
    assert.equal(challenge.status, 402);
    assert.equal(challenge.body.accepts[0].scheme, "exact");
    const catalog = await http(originUrl + "/catalog.json", "GET");
    assert.equal(catalog.status, 200);
    assert(!JSON.stringify(catalog.body).includes("/solana/session/sha256"));
    const unpaid = await http(originUrl + "/solana/session/sha256", "GET");
    assert.equal(unpaid.status, 503);
    assert.equal(unpaid.body.error, error);
    assert.equal(unpaid.body.new_payment_allowed, false);
    assert.equal(unpaid.body.accepts, undefined);
    assert.equal(unpaid.headers.get("payment-required"), null);
    const paid = await http(originUrl + "/solana/session/sha256", "GET", undefined, {
      Authorization: "Payment synthetic",
    });
    assert.equal(paid.status, 503);
    assert.equal(paid.body.new_payment_allowed, false);
    assert.equal(paid.body.billing.settlement_attempted, false);
  } finally {
    if (app.listening) await new Promise<void>((resolve) => { app.close(() => resolve()); app.closeAllConnections(); });
    await l.close();
  }
}

test("optional batch errors map credentials and supported-kinds fetch failures", () => {
  assert.equal(
    optionalBatchProfileError(new LabError("base_batch_cdp_tokens_required")),
    "base_batch_cdp_tokens_required",
  );
  assert.equal(
    optionalBatchProfileError(new Error("batch_provider_credentials_unavailable")),
    "batch_provider_credentials_unavailable",
  );
  assert.equal(
    optionalBatchProfileError(
      new Error("Failed to fetch supported kinds from facilitator: Error: batch_provider_credentials_unavailable"),
    ),
    "batch_provider_credentials_unavailable",
  );
  assert.equal(
    optionalBatchProfileError(new Error("Failed to fetch supported kinds from facilitator")),
    "batch_provider_unavailable",
  );
  assert.equal(
    optionalBatchProfileError(new LabError("solana_rpc_unavailable", 503)),
    "solana_rpc_unavailable",
  );
  assert.equal(optionalBatchProfileError(new LabError("base_batch_deployment_scope_refused")), undefined);
  assert.equal(optionalBatchProfileError(new LabError("batch_config_refused")), undefined);
  assert.equal(optionalBatchProfileError(new LabError("solana_session_deployment_scope_refused")), undefined);
  assert.equal(optionalBatchProfileError(new LabError("solana_rpc_refused")), undefined);
  assert.equal(optionalBatchProfileError(new LabError("solana_continuation_scope_refused")), undefined);
});

test("missing batch credentials keep seller boot and refuse the batch profile closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "batch-ready-missing-"));
  const campaignPath = join(dir, "base.json");
  writeFileSync(campaignPath, JSON.stringify(campaign()));
  let loaded: Awaited<ReturnType<typeof configuredBatchHttpMerchants>> | undefined;
  const l = await lab();
  try {
    loaded = await configuredBatchHttpMerchants(mainnetSeller, envFor(campaignPath));
    assert.equal(loaded.merchants.length, 1);
    assert.deepEqual(loaded.merchants[0]!.unavailable, {
      profile: "base-batch",
      error: "base_batch_cdp_tokens_required",
    });
    const app = server(l.seller, undefined, loaded.merchants);
    app.listen(0, "127.0.0.1");
    await once(app, "listening");
    l.config.origin = `http://127.0.0.1:${(app.address() as any).port}`;
    try {
      const ready = await http(l.config.origin + "/ready", "GET");
      assert.equal(ready.status, 200);
      assert.equal(ready.body.ok, true);
      assert.equal(ready.body.unavailable_profiles.length, 1);
      assert.equal(ready.body.unavailable_profiles[0].profile, "base-batch");
      assert.equal(ready.body.unavailable_profiles[0].path, "/base/batch/sha256");
      assert.equal(ready.body.unavailable_profiles[0].error, "base_batch_cdp_tokens_required");
      assert.equal(ready.body.unavailable_profiles[0].new_payment_allowed, false);
      const again = await http(l.config.origin + "/ready", "GET");
      assert.equal(again.status, 200);
      assert.equal(again.body.unavailable_profiles[0].error, ready.body.unavailable_profiles[0].error);
      const challenge = await http(l.config.origin + "/base/payload/sha256", "GET");
      assert.equal(challenge.status, 402);
      assert.equal(challenge.body.accepts[0].scheme, "exact");
      assert.equal(challenge.body.accepts.length, 1);
      const catalog = await http(l.config.origin + "/catalog.json", "GET");
      assert.equal(catalog.status, 200);
      assert(!JSON.stringify(catalog.body).includes("/base/batch/sha256"));
      const unpaid = await http(l.config.origin + "/base/batch/sha256", "GET");
      assert.equal(unpaid.status, 503);
      assert.equal(unpaid.body.error, "base_batch_cdp_tokens_required");
      assert.equal(unpaid.body.new_payment_allowed, false);
      assert.equal(unpaid.body.accepts, undefined);
      assert.equal(unpaid.headers.get("payment-required"), null);
      const paid = await http(l.config.origin + "/base/batch/sha256", "GET", undefined, {
        "PAYMENT-SIGNATURE": encode64({ x402Version: 2, payload: { type: "voucher" } }),
      });
      assert.equal(paid.status, 503);
      assert.equal(paid.body.new_payment_allowed, false);
      assert.equal(paid.body.billing.settlement_attempted, false);
      assert.equal(paid.body.billing.settlement_state, "not_attempted");
    } finally {
      if (app.listening) await new Promise<void>((resolve) => { app.close(() => resolve()); app.closeAllConnections(); });
    }
  } finally {
    await loaded?.close();
    await l.close();
    rmSync(dir, { recursive: true });
  }
});

test("batch supported-kinds credential failure is isolated and does not crash seller startup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "batch-ready-kinds-"));
  const campaignPath = join(dir, "base.json");
  writeFileSync(campaignPath, JSON.stringify(campaign()));
  const hook = mock.method(BaseBatchMerchant.prototype, "initialize", async () => {
    throw new Error("Failed to fetch supported kinds from facilitator: Error: batch_provider_credentials_unavailable");
  });
  let loaded: Awaited<ReturnType<typeof configuredBatchHttpMerchants>> | undefined;
  const l = await lab();
  try {
    loaded = await configuredBatchHttpMerchants(mainnetSeller, envFor(campaignPath, join(dir, "tokens.json")));
    assert.equal(loaded.merchants.length, 1);
    assert.deepEqual(loaded.merchants[0]!.unavailable, {
      profile: "base-batch",
      error: "batch_provider_credentials_unavailable",
    });
    const app = server(l.seller, undefined, loaded.merchants);
    app.listen(0, "127.0.0.1");
    await once(app, "listening");
    const originUrl = `http://127.0.0.1:${(app.address() as any).port}`;
    try {
      const ready = await http(originUrl + "/ready", "GET");
      assert.equal(ready.status, 200);
      assert.equal(ready.body.ok, true);
      assert.equal(ready.body.unavailable_profiles[0].error, "batch_provider_credentials_unavailable");
      const challenge = await http(originUrl + "/base/payload/sha256", "GET");
      assert.equal(challenge.status, 402);
      assert.equal(challenge.body.accepts[0].scheme, "exact");
      const refused = await http(originUrl + "/base/batch/sha256", "GET", undefined, {
        "PAYMENT-SIGNATURE": encode64({ x402Version: 2 }),
      });
      assert.equal(refused.status, 503);
      assert.equal(refused.body.error, "batch_provider_credentials_unavailable");
      assert.equal(refused.body.new_payment_allowed, false);
    } finally {
      if (app.listening) await new Promise<void>((resolve) => { app.close(() => resolve()); app.closeAllConnections(); });
    }
  } finally {
    hook.mock.restore();
    await loaded?.close();
    await l.close();
    rmSync(dir, { recursive: true });
  }
});

test("solana session RPC unavailability keeps seller boot and refuses the session profile closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "batch-ready-solana-"));
  const sessionPath = join(dir, "solana.json");
  writeFileSync(sessionPath, JSON.stringify(sessionCampaign()));
  const hook = mock.method(optionalSessionRuntime, "createSession", async () => {
    throw new LabError("solana_rpc_unavailable", 503);
  });
  let loaded: Awaited<ReturnType<typeof configuredBatchHttpMerchants>> | undefined;
  try {
    loaded = await configuredBatchHttpMerchants(mainnetSeller, sessionEnv(sessionPath));
    assert.equal(loaded.merchants.length, 1);
    assert.deepEqual(loaded.merchants[0]!.unavailable, {
      profile: "solana-session",
      error: "solana_rpc_unavailable",
    });
    await assertExactReadyAndSessionRefused(loaded.merchants, "solana-session", "solana_rpc_unavailable");
  } finally {
    hook.mock.restore();
    await loaded?.close();
    rmSync(dir, { recursive: true });
  }
});

test("solana continuation RPC unavailability keeps seller boot and refuses the session profile closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "batch-ready-solana-v2-"));
  const sessionPath = join(dir, "solana.json");
  writeFileSync(sessionPath, JSON.stringify(continuationCampaign()));
  const hook = mock.method(optionalSessionRuntime, "createContinuation", async () => {
    throw new LabError("solana_rpc_unavailable", 503);
  });
  let loaded: Awaited<ReturnType<typeof configuredBatchHttpMerchants>> | undefined;
  try {
    loaded = await configuredBatchHttpMerchants(mainnetSeller, {
      LAB_SOLANA_PUSH_CONTINUATION: SOLANA_CONTINUATION_OPT_IN,
      LAB_SOLANA_CONTINUATION_CONFIG: sessionPath,
      LAB_BATCH_DATABASE_URL: "postgresql://127.0.0.1/lab_batch_readiness",
    });
    assert.equal(loaded.merchants.length, 1);
    assert.deepEqual(loaded.merchants[0]!.unavailable, {
      profile: "solana-session-continuation",
      error: "solana_rpc_unavailable",
    });
    await assertExactReadyAndSessionRefused(
      loaded.merchants,
      "solana-session-continuation",
      "solana_rpc_unavailable",
    );
  } finally {
    hook.mock.restore();
    await loaded?.close();
    rmSync(dir, { recursive: true });
  }
});

test("invalid batch opt-in and deployment scope still fail closed before isolation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "batch-ready-fatal-"));
  const campaignPath = join(dir, "base.json");
  const sessionPath = join(dir, "solana.json");
  writeFileSync(campaignPath, JSON.stringify(campaign({ url: origin + "/base/batch/sha256?x=1" })));
  writeFileSync(sessionPath, JSON.stringify(sessionCampaign({ url: origin + "/solana/session/sha256?x=1" })));
  try {
    await assert.rejects(configuredBatchHttpMerchants(mainnetSeller, {
      LAB_BASE_BATCH: "yes",
      LAB_BASE_BATCH_CONFIG: campaignPath,
      LAB_BATCH_DATABASE_URL: "postgresql://127.0.0.1/lab_batch_readiness",
    }));
    await assert.rejects(configuredBatchHttpMerchants(mainnetSeller, envFor(campaignPath)));
    await assert.rejects(configuredBatchHttpMerchants(mainnetSeller, {
      LAB_SOLANA_PUSH_SESSION: "yes",
      LAB_SOLANA_SESSION_CONFIG: sessionPath,
      LAB_BATCH_DATABASE_URL: "postgresql://127.0.0.1/lab_batch_readiness",
    }));
    await assert.rejects(configuredBatchHttpMerchants(mainnetSeller, sessionEnv(sessionPath)));
    writeFileSync(sessionPath, JSON.stringify(sessionCampaign({ rpcUrl: "http://rpc.example/" })));
    await assert.rejects(configuredBatchHttpMerchants(mainnetSeller, sessionEnv(sessionPath)));
  } finally {
    rmSync(dir, { recursive: true });
  }
});
