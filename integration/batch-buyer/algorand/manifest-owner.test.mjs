import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  createPrivateKey,
  createPublicKey,
  sign,
  createHash,
} from "node:crypto";
import { runManifestOwnerCLI } from "./manifest-owner-cli.mjs";
import {
  ManifestOwnerCampaign,
  validateManifestOwnerConfig,
} from "./manifest-owner.mjs";
import { createManifestOwner } from "./manifest-owner-factory.mjs";
import { AlgorandManifestStore } from "../../lab/dist/src/algorand-manifest-store.js";
import { canonical } from "../../reference-buyer/policy.mjs";
import { AlgorandManifestSeller } from "../../lab/dist/src/algorand-manifest-seller.js";
const req = createRequire(new URL("../../lab/package.json", import.meta.url));
const { ExactAvmScheme } = await import(
  req.resolve("@x402/avm/exact/facilitator")
);
const {
  decodeTransaction,
  decodeSignedTransaction,
  encodeTransactionRaw,
  encodeSignedTransaction,
  bytesForSigning,
  transactionCodec,
} = await import(req.resolve("@algorandfoundation/algokit-utils/transact"));
const fixtures = JSON.parse(
  readFileSync(
    new URL("./test/manifest-owner-fixtures.json", import.meta.url),
    "utf8",
  ),
);
function pair(n) {
  const seed = Buffer.alloc(32, n),
    privateKey = createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        seed,
      ]),
      type: "pkcs8",
      format: "der",
    }),
    publicKey = createPublicKey(privateKey)
      .export({ type: "spki", format: "der" })
      .subarray(-32);
  return {
    privateKey,
    secret: Buffer.concat([seed, publicKey]).toString("base64"),
  };
}
const key = pair(1),
  sponsor = pair(3),
  encode = (x) => Buffer.from(canonical(x)).toString("base64");
function setup(index = 0, fault = "") {
  const f = structuredClone(fixtures[index]),
    directory = mkdtempSync(join(tmpdir(), "manifest-owner-"));
  let now = f.now;
  const counters = {
    routerSign: 0,
    merchantSign: 0,
    routerSend: 0,
    merchantSend: 0,
    merchantVerify: 0,
    merchantSettle: 0,
    merchantRecovery: 0,
  };
  const txs = new Map();
  const c = {
    version: 1,
    campaignId: "synthetic-manifest-owner-" + index,
    sourceCommit: "a".repeat(40),
    sourceTree: "b".repeat(40),
    releasePinsSha256: "c".repeat(64),
    buyer: f.buyer,
    createdAt: (now - 1) * 1000,
    expiresAt: (now + 14400 - 1) * 1000,
    rpcUrl: "https://rpc.example",
    routeRequest: f.request,
    trustedLogVkey: f.trusted_vkey,
    router: {
      url: "https://router.example/route",
      network: f.request.buyer_limits.network,
      asset: "31566704",
      recipient: f.merchant,
      feePayer: f.sponsor,
      maximumAtomic: "3000",
      maximumSponsorFeeMicroAlgo: "2000",
      maximumBuyerNativeFeeAtomic: "0",
    },
    budget: {
      maximumRouteObservations: 1,
      maximumMerchantSubmissions: 1,
      maximumUSDCAtomic: "6000",
      maximumMerchantAtomic: "3000",
      maximumMerchantSponsorFeeMicroAlgo:
        f.request.buyer_limits.max_sponsor_fee_micro_algo,
      maximumBuyerNativeFeeAtomic: "0",
    },
    recoveryContract: "digest-only-read-v1",
    newPaymentOnUnknown: false,
    commercialFee: "not-independently-quoted",
    hostedGroupPolicy: "not-independently-advertised",
  };
  const params = {
      "genesis-hash": c.router.network.slice(9),
      "genesis-id": "mainnet-v1.0",
      "last-round": 1000,
      "min-fee": 1000,
      fee: 0,
    },
    envelope = JSON.parse(Buffer.from(f.challenge.paymentRequired, "base64"));
  function signed(raw, k = sponsor) {
    const txn = decodeTransaction(raw);
    return encodeSignedTransaction({
      txn,
      sig: sign(null, bytesForSigning.transaction(txn), k.privateKey),
    });
  }
  function record(raw) {
    for (const b of raw) {
      const t = decodeTransaction(b);
      txs.set(t.txId(), { round: 1002, raw: b });
    }
  }
  const facilitator = new ExactAvmScheme({
    getAddresses: () => [f.sponsor],
    signTransaction: async (raw) => signed(raw),
    simulateTransactions: async () => ({ txnGroups: [{}] }),
    sendTransactions: async (group) =>
      record(
        group.map((b) => encodeTransactionRaw(decodeSignedTransaction(b).txn)),
      ),
    waitForConfirmation: async () => ({ confirmedRound: 1002 }),
  });
  const merchantStore = new AlgorandManifestStore(
    join(directory, "seller.sqlite"),
  );
  const merchant = new AlgorandManifestSeller(
    {
      offerId: c.campaignId,
      profile: f.request.merchant_profile,
      url: f.request.url,
      requirement: envelope.accepts[0],
      limits: f.request.buyer_limits,
      buyer: f.buyer,
    },
    merchantStore,
    {
      verify: async (p, r) => {
        counters.merchantVerify++;
        return facilitator.verify(p, r);
      },
      settle: async (p, r) => {
        counters.merchantSettle++;
        return facilitator.settle(p, r);
      },
    },
    async () => params,
  );
  const offer = {
    scheme: "exact",
    network: c.router.network,
    asset: "31566704",
    amount: "3000",
    payTo: c.router.recipient,
    maxTimeoutSeconds: 60,
    extra: { feePayer: c.router.feePayer },
  };
  const billing = {
    condition: "live_eligible_route_found",
    display_amount: "$0.003",
    model: "success_only_v1",
    amount_atomic: "3000",
    asset: "USDC",
    typed_misses_settled: false,
    seller_payment_separate: true,
  };
  const challenge = {
    x402Version: 2,
    resource: { url: c.router.url },
    accepts: [offer],
    billing,
  };
  const paid = {
    ...f.response,
    billing: {
      ...billing,
      settled: true,
      settlement_attempted: true,
      settlement_state: "settled",
      rail: "algorand",
    },
  };
  let routerReceipt;
  const response = (body, status = 200, headers = {}) =>
    new Response(
      typeof body === "string"
        ? body
        : JSON.stringify(body, (_k, v) =>
            typeof v === "bigint" ? Number(v) : v,
          ),
      { status, headers },
    );
  const backend = async (url, init = {}) => {
    assert.equal(init.redirect, "error");
    const h = new Headers(init.headers);
    if (url === c.router.url) {
      assert.equal(init.method, "POST");
      if (init.body === "{}" && h.get("Replay-Only") === "1")
        return response(
          {
            error: "recovery_unavailable",
            recovery_only: true,
            new_payment_allowed: false,
          },
          503,
        );
      assert.deepEqual(JSON.parse(init.body), f.request);
      if (!h.has("Payment-Signature"))
        return response(challenge, 402, {
          "Payment-Required": encode(challenge),
        });
      if (h.get("Replay-Only") === "1") {
        if (!routerReceipt)
          return response(
            {
              error: "recovery_unavailable",
              recovery_only: true,
              new_payment_allowed: false,
            },
            503,
          );
        return response(paid, 200, {
          "Payment-Response": encode(routerReceipt),
          "Replay-Only": "1",
        });
      }
      counters.routerSend++;
      const p = JSON.parse(Buffer.from(h.get("Payment-Signature"), "base64"));
      const raw = p.payload.paymentGroup.map((x, i) =>
        i
          ? encodeTransactionRaw(
              decodeSignedTransaction(Buffer.from(x, "base64")).txn,
            )
          : Buffer.from(x, "base64"),
      );
      record(raw);
      routerReceipt = {
        success: true,
        network: c.router.network,
        transaction: decodeTransaction(raw[1]).txId(),
        amount: "3000",
      };
      if (fault === "router_lost") throw Error("lost_router_ack");
      return response(paid, 200, { "Payment-Response": encode(routerReceipt) });
    }
    if (url === c.rpcUrl + "/v2/transactions/params") {
      return response(params);
    }
    if (url.startsWith(c.rpcUrl + "/v2/transactions/pending/")) {
      const id = url.split("/").at(-1),
        t = txs.get(id);
      if (!t) return response({}, 404);
      let round = t.round;
      if (
        fault === "wrong_round" &&
        counters.merchantSend &&
        id === [...txs.keys()].at(-1)
      )
        round++;
      return response({
        "confirmed-round": round,
        "pool-error": "",
        txn: { txn: transactionCodec.encode(decodeTransaction(t.raw), "json") },
      });
    }
    assert.equal(url, c.routeRequest.url);
    assert.equal(init.method, "GET");
    if (h.get("Replay-Only") === "1") {
      counters.merchantRecovery++;
      assert(!h.has("Payment-Signature"));
      const q = {
        recoveryOnly: true,
        url,
        groupId: h.get("Manifest-Group-Id"),
        requestDigest: h.get("Manifest-Request-Digest"),
        authorizationDigest: h.get("Manifest-Authorization-Digest"),
      };
      const out = await merchant.recover(q);
      if (fault === "bad_recovery" && out.body?.batch)
        out.body.batch.paymentCount = 99;
      return response(out.body, out.status, { "Replay-Only": "1" });
    }
    assert(h.has("Payment-Signature"));
    counters.merchantSend++;
    const out = await merchant.request(url, h.get("Payment-Signature"));
    if (fault === "merchant_lost" || fault === "bad_recovery")
      throw Error("lost_merchant_ack");
    return response(out.body, out.status, out.headers);
  };
  const fetch = async (...args) => {
    try {
      return await backend(...args);
    } catch (e) {
      throw e;
    }
  };
  const real = createManifestOwner(
    c,
    { LAB_BUYER_ALGORAND_KEY_B64: key.secret },
    { fetch },
  );
  const owner = {
    routerSigner: async (...args) => {
      counters.routerSign++;
      const out = await real.routerSigner(...args);
      if (fault === "expired_router_sign") now += 15000;
      return out;
    },
    signGroup: async (...args) => {
      counters.merchantSign++;
      const out = await real.signGroup(...args);
      if (fault === "expired_after_sign") now += 60;
      return out;
    },
  };
  const realFetch = globalThis.fetch,
    realNow = Date.now;
  globalThis.fetch = fetch;
  Date.now = () => now * 1000;
  const open = (wallet = true) =>
    new ManifestOwnerCampaign(directory, c, {
      owner: wallet ? owner : undefined,
      fetch,
      clock: () => now,
      pause: async () => {},
    });
  return {
    f,
    c,
    counters,
    directory,
    open,
    advance: (n) => (now += n),
    async ready() {
      const out = await merchant.request(c.routeRequest.url);
      assert.equal(out.status, 402);
      assert.equal(
        out.headers["Payment-Required"] ?? out.headers["payment-required"],
        f.challenge.paymentRequired,
      );
    },
    close() {
      merchantStore.close();
      globalThis.fetch = realFetch;
      Date.now = realNow;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
for (const index of [0, 1])
  test(
    "actual SDK group3/invoice3 one-shot run and complete restart " + index,
    async () => {
      const f = setup(index);
      let c;
      try {
        await f.ready();
        c = f.open();
        const out = await c.run();
        assert.equal(out.state, "complete");
        assert.equal(out.confirmation.transactions.length, index ? 2 : 4);
        assert.equal(out.confirmation.totalAtomic, "3000");
        assert.deepEqual(f.counters, {
          routerSign: 1,
          merchantSign: 1,
          routerSend: 1,
          merchantSend: 1,
          merchantVerify: 1,
          merchantSettle: 1,
          merchantRecovery: 0,
        });
        c.close();
        c = f.open(false);
        assert.equal((await c.recover()).state, "complete");
        await assert.rejects(c.run());
        assert.equal(f.counters.routerSend, 1);
        assert.equal(f.counters.merchantSend, 1);
      } finally {
        c?.close();
        f.close();
      }
    },
  );
test("lost merchant ACK restart after expiry recovers only digests and no second signing", async () => {
  const f = setup(0, "merchant_lost");
  let c;
  try {
    await f.ready();
    c = f.open();
    assert.equal((await c.run()).state, "merchant_unknown");
    c.close();
    f.advance(15000);
    c = f.open(false);
    assert.equal((await c.recover()).state, "complete");
    assert.equal(f.counters.merchantRecovery, 1);
    assert.equal(f.counters.merchantSign, 1);
    assert.equal(f.counters.merchantSettle, 1);
    await assert.rejects(c.deliver());
    assert.equal(f.counters.merchantSend, 1);
  } finally {
    c?.close();
    f.close();
  }
});
test("lost router ACK is read-only reconciled; no automatic merchant signing or replacement fee", async () => {
  const f = setup(0, "router_lost");
  let c;
  try {
    await f.ready();
    c = f.open();
    await assert.rejects(c.run());
    assert.equal(f.counters.merchantSign, 0);
    c.close();
    c = f.open(false);
    assert.equal((await c.recover()).state, "route_confirmed");
    assert.equal(f.counters.routerSend, 1);
    assert.equal(f.counters.merchantSign, 0);
    await assert.rejects(c.route());
  } finally {
    c?.close();
    f.close();
  }
});
test("stale signed offer stays fenced without merchant send", async () => {
  const f = setup(0, "expired_after_sign");
  let c;
  try {
    await f.ready();
    c = f.open();
    const out = await c.run();
    assert.equal(out.state, "merchant_unknown");
    assert.equal(f.counters.merchantSign, 1);
    assert.equal(f.counters.merchantSend, 0);
    assert.equal((await c.recover()).state, "merchant_unknown");
    await assert.rejects(c.deliver());
    assert.equal(f.counters.merchantSign, 1);
  } finally {
    c?.close();
    f.close();
  }
});
test("independent common-round mismatch refuses completion", async () => {
  const f = setup(0, "wrong_round");
  let c;
  try {
    await f.ready();
    c = f.open();
    const out = await c.run();
    assert.equal(out.state, "merchant_unknown");
    assert.equal(out.confirmation.state, "unknown");
    assert.equal(f.counters.merchantSend, 1);
  } finally {
    c?.close();
    f.close();
  }
});
test("concurrent processes share durable route claim and immutable config", async () => {
  const f = setup();
  let a, b;
  try {
    await f.ready();
    a = f.open();
    b = f.open();
    const outcomes = await Promise.allSettled([a.run(), b.run()]);
    assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(f.counters.routerSign, 1);
    assert.equal(f.counters.merchantSign, 1);
    const bad = structuredClone(f.c);
    bad.routeRequest.buyer_limits.job_hashes.reverse();
    assert.throws(() => new ManifestOwnerCampaign(f.directory, bad));
    bad.budget.maximumUSDCAtomic = "6001";
    assert.throws(() => validateManifestOwnerConfig(bad));
  } finally {
    a?.close();
    b?.close();
    f.close();
  }
});

test("actual source-pinned CLI runs once; recovery does not access wallet; source tamper refuses", async () => {
  const f = setup(1);
  try {
    await f.ready();
    const root = new URL("../../../", import.meta.url),
      files = [
        "integration/batch-buyer/algorand/manifest-owner.mjs",
        "integration/batch-buyer/algorand/manifest-owner-factory.mjs",
        "integration/batch-buyer/algorand/manifest-owner-cli.mjs",
        "integration/batch-buyer/algorand/owner-hooks.mjs",
        "integration/batch-buyer/algorand/manifest.mjs",
        "integration/batch-buyer/algorand/manifest-store.mjs",
        "sdk/route-guard/batch.mjs",
        "sdk/route-guard/client.mjs",
        "sdk/route-guard/file-store.mjs",
      ];
    const hash = (x) => createHash("sha256").update(x).digest("hex");
    const pins = {
      sourceCommit: f.c.sourceCommit,
      sourceTree: f.c.sourceTree,
      capsuleManifestSha256: "d".repeat(64),
      files: Object.fromEntries(
        files.map((p) => [p, hash(readFileSync(new URL(p, root)))]),
      ),
    };
    const c = structuredClone(f.c);
    c.releasePinsSha256 = hash(canonical(pins) + "\n");
    const config = join(f.directory, "owner.json"),
      pinFile = join(f.directory, "pins.json"),
      journal = join(f.directory, "cli-journal");
    writeFileSync(config, JSON.stringify(c));
    writeFileSync(pinFile, JSON.stringify(pins));
    assert.equal(
      (await runManifestOwnerCLI(["plan", config, pinFile, journal])).state,
      "prepared",
    );
    assert.equal(
      (
        await runManifestOwnerCLI(["run", config, pinFile, journal], {
          env: {
            LAB_MANIFEST_OWNER_ACK: "reviewed-fresh-group3-or-invoice3-6000",
            LAB_BUYER_ALGORAND_KEY_B64: key.secret,
          },
        })
      ).state,
      "complete",
    );
    assert.equal(
      (
        await runManifestOwnerCLI(["recover", config, pinFile, journal], {
          env: new Proxy(
            {},
            {
              get() {
                throw Error("wallet_environment_access_refused");
              },
            },
          ),
        })
      ).state,
      "complete",
    );
    const before = { ...f.counters };
    await assert.rejects(
      runManifestOwnerCLI(["run", config, pinFile, journal], {
        env: {
          LAB_MANIFEST_OWNER_ACK: "reviewed-fresh-group3-or-invoice3-6000",
          LAB_BUYER_ALGORAND_KEY_B64: key.secret,
        },
      }),
    );
    assert.deepEqual(f.counters, before);
    pins.files[files[0]] = "0".repeat(64);
    writeFileSync(pinFile, JSON.stringify(pins));
    await assert.rejects(
      runManifestOwnerCLI(["status", config, pinFile, journal]),
    );
  } finally {
    f.close();
  }
});
test("contradictory recovered accounting stays unknown, never signs or submits again", async () => {
  const f = setup(0, "bad_recovery");
  let c;
  try {
    await f.ready();
    c = f.open();
    assert.equal((await c.run()).state, "merchant_unknown");
    c.close();
    f.advance(100);
    c = f.open(false);
    assert.equal((await c.recover()).state, "merchant_unknown");
    assert.equal(f.counters.merchantSend, 1);
    assert.equal(f.counters.merchantSign, 1);
    assert.equal(f.counters.merchantSettle, 1);
  } finally {
    c?.close();
    f.close();
  }
});

test("campaign expiry while router signer is pending blocks ordinary payment transport", async () => {
  const f = setup(0, "expired_router_sign");
  let c;
  try {
    await f.ready();
    c = f.open();
    await assert.rejects(c.run());
    assert.equal(f.counters.routerSign, 1);
    assert.equal(f.counters.routerSend, 0);
    assert.equal(f.counters.merchantSign, 0);
    await assert.rejects(c.route());
  } finally {
    c?.close();
    f.close();
  }
});
