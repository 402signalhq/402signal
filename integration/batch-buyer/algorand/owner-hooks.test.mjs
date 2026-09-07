import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { AlgorandBatchCampaign } from "./campaign-operator.mjs";
import { createAlgorandOwnerHooks } from "./owner-hooks.mjs";
import { createOwnerGroupSigner } from "./owner-factory.mjs";
const req = createRequire(new URL("../../lab/package.json", import.meta.url));
const { Address } = await import(
  req.resolve("@algorandfoundation/algokit-utils")
);
const {
  Transaction,
  TransactionType,
  groupTransactions,
  decodeTransaction,
  encodeTransactionRaw,
  encodeSignedTransaction,
  bytesForSigning,
  transactionCodec,
} = await import(req.resolve("@algorandfoundation/algokit-utils/transact"));
const fixture = JSON.parse(
  readFileSync(
    new URL("../../../tests/fixtures/batch-route-v5.json", import.meta.url),
    "utf8",
  ),
)[2];
const pair = generateKeyPairSync("ed25519"),
  buyer = new Address(
    pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32),
  ).toString();
function setup(fault = "") {
  const directory = mkdtempSync(join(tmpdir(), "avm-owner-"));
  const policy = {
    version: 1,
    campaignMaximumAtomic: "5000",
    buyer,
    url: fixture.request.url,
    buyerLimits: fixture.request.buyer_limits,
    trustedLogVkey: fixture.trusted_vkey,
    router: {
      url: "https://router.example/route",
      network: fixture.request.buyer_limits.network,
      asset: "31566704",
      recipient: fixture.request.buyer_limits.recipient,
      feePayer: fixture.request.buyer_limits.fee_payer,
      maximumAtomic: "3000",
      maximumBuyerNativeFeeAtomic: "0",
    },
    rpcUrl: "https://rpc.example",
  };
  const counts = {
    routerSign: 0,
    merchantSign: 0,
    routerSend: 0,
    merchantSend: 0,
    recover: 0,
    routerRecover: 0,
  };
  const rows = new Map();
  let routerRaw,
    merchantRaw,
    time = fixture.now;
  const offer = {
    scheme: "exact",
    network: policy.router.network,
    asset: "31566704",
    currency: "31566704",
    amount: "3000",
    payTo: policy.router.recipient,
    maxTimeoutSeconds: 60,
    extra: {
      name: "USD Coin",
      feePayer: policy.router.feePayer,
      displayAmount: 0.003,
      tag: "x402-global-challenge",
      facilitator: "https://facilitator.example",
      suggestedParams: { ignored: true },
      unsignedGroup: { ignored: true },
    },
  };
  const challenge = {
    x402Version: 2,
    resource: { url: policy.router.url },
    accepts: [{ scheme: "exact", network: "eip155:8453" }, offer],
    extensions: { bazaar: { info: { description: "synthetic" } } },
    billing: {
      model: "success_only_v1",
      amount_atomic: "3000",
      asset: "USDC",
      typed_misses_settled: false,
      seller_payment_separate: true,
    },
  };
  const paid = structuredClone(fixture.response);
  paid.billing = {
    condition: "live_eligible_route_found",
    display_amount: "$0.003",
    model: "success_only_v1",
    amount_atomic: "3000",
    asset: "USDC",
    rail: "algorand",
    settled: true,
    settlement_attempted: true,
    settlement_state: "settled",
  };
  if (fault === "proof") paid.batch_terms = {};
  const encode = (x) => Buffer.from(JSON.stringify(x)).toString("base64");
  const response = (body, status = 200, headers = {}) =>
    new Response(
      typeof body === "string"
        ? body
        : JSON.stringify(body, (_k, v) =>
            typeof v === "bigint" ? Number(v) : v,
          ),
      {
        status,
        headers,
      },
    );
  function record(raw) {
    for (const b of raw) {
      const tx = decodeTransaction(b);
      rows.set(tx.txId(), {
        "confirmed-round": 1001,
        txn: { txn: transactionCodec.encode(tx, "json") },
      });
    }
  }
  function signed(raw, i) {
    const txn = decodeTransaction(raw[i]);
    return encodeSignedTransaction({
      txn,
      sig: sign(null, bytesForSigning.transaction(txn), pair.privateKey),
    });
  }
  const owner = {
    async routerSigner(rail, c) {
      counts.routerSign++;
      assert.equal(rail, "algorand");
      assert.equal(c.accepts.length, 1);
      assert.deepEqual(c.accepts[0], offer);
      const common = {
        genesisHash: Buffer.from(policy.router.network.slice(9), "base64"),
        genesisId: "mainnet-v1.0",
        firstValid: 1000n,
        lastValid: 1060n,
      };
      routerRaw = groupTransactions([
        new Transaction({
          ...common,
          type: TransactionType.Payment,
          sender: Address.fromString(offer.extra.feePayer),
          fee: 2000n,
          payment: {
            receiver: Address.fromString(offer.extra.feePayer),
            amount: 0n,
          },
        }),
        new Transaction({
          ...common,
          type: TransactionType.AssetTransfer,
          sender: Address.fromString(buyer),
          fee: 0n,
          assetTransfer: {
            receiver: Address.fromString(offer.payTo),
            assetId: 31566704n,
            amount: 3000n,
          },
        }),
      ]).map(encodeTransactionRaw);
      const payload = {
        x402Version: 2,
        resource: { url: policy.router.url },
        accepted: offer,
        payload: {
          paymentIndex: 1,
          paymentGroup: [
            Buffer.from(routerRaw[0]).toString("base64"),
            Buffer.from(signed(routerRaw, 1)).toString("base64"),
          ],
        },
      };
      if (fault === "wallet_lost") throw Error("PRIVATE_WALLET_CANARY");
      return payload;
    },
    async signGroup(raw, indexes) {
      counts.merchantSign++;
      assert.deepEqual(indexes, [1, 2]);
      merchantRaw = raw;
      if (fault === "expired_after_sign") time += 120;
      const key = Buffer.concat([
        pair.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32),
        pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32),
      ]).toString("base64");
      return createOwnerGroupSigner(policy, {
        LAB_BUYER_ALGORAND_KEY_B64: key,
      })(raw, indexes);
    },
  };
  function delivery() {
    const txs = merchantRaw.map(decodeTransaction);
    return {
      batch: {
        groupId: Buffer.from(txs[0].group).toString("base64"),
        items: fixture.response.batch_terms.jobHashes.map((hash, i) => ({
          index: i + 1,
          result: { sha256: hash },
          transaction: txs[i + 1].txId(),
          amount_atomic: "1000",
        })),
      },
      billing: { amount_atomic: "2000" },
    };
  }
  const fetch = async (url, init = {}) => {
    assert.equal(init.redirect, "error");
    const h = new Headers(init.headers);
    if (url === policy.router.url) {
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
      assert.deepEqual(JSON.parse(init.body), fixture.request);
      if (!h.has("PAYMENT-SIGNATURE"))
        return response(challenge, 402, {
          "PAYMENT-REQUIRED": encode(challenge),
        });
      if (h.get("Replay-Only") === "1") counts.routerRecover++;
      else {
        counts.routerSend++;
        record(routerRaw);
        if (fault === "router_lost") throw Error("lost response");
      }
      return response(paid, 200, {
        "PAYMENT-RESPONSE": encode({
          success: true,
          network: policy.router.network,
          transaction: decodeTransaction(routerRaw[1]).txId(),
          amount: "3000",
        }),
      });
    }
    assert.equal(init.method, "GET");
    if (url === policy.url) {
      if (!h.has("PAYMENT-SIGNATURE"))
        return response(
          fixture.challenge.bodyText,
          402,
          fixture.challenge.paymentRequired
            ? { "PAYMENT-REQUIRED": fixture.challenge.paymentRequired }
            : {},
        );
      if (h.get("Replay-Only") === "1") counts.recover++;
      else {
        counts.merchantSend++;
        record(merchantRaw);
        if (fault === "seller_lost") throw Error("lost response");
      }
      return response(delivery());
    }
    if (url === policy.rpcUrl + "/v2/transactions/params")
      return response({
        "genesis-hash": policy.router.network.slice(9),
        "genesis-id": "mainnet-v1.0",
        "min-fee": 1000,
        fee: 0,
        "last-round": 1000,
      });
    const found = structuredClone(rows.get(url.split("/").at(-1)));
    if (
      fault === "router_sponsor_mismatch" &&
      routerRaw &&
      url.endsWith(decodeTransaction(routerRaw[0]).txId()) &&
      found
    )
      found["confirmed-round"] = 1002;
    return response(found ?? {}, found ? 200 : 404);
  };
  let campaign = new AlgorandBatchCampaign(directory, policy, {
      clock: () => time,
    }),
    hooks = createAlgorandOwnerHooks(policy, {
      directory,
      id: "once",
      owner,
      fetch,
      pause: async () => {},
      clock: () => time,
    });
  return {
    counts,
    policy,
    async run() {
      return campaign.run("once", hooks);
    },
    async recover() {
      hooks.close();
      campaign.close();
      campaign = new AlgorandBatchCampaign(directory, policy, {
        clock: () => time,
      });
      hooks = createAlgorandOwnerHooks(policy, {
        directory,
        id: "once",
        fetch,
        pause: async () => {},
        clock: () => time,
      });
      return campaign.recover("once", hooks);
    },
    async routerRecovery() {
      return hooks.recoverRouter();
    },
    async again() {
      return campaign.run("once", hooks);
    },
    close() {
      hooks.close();
      campaign.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test("owner driver + real RouteClient + v5 + synthetic buyer completes once and recovers without signer", async () => {
  const s = setup();
  try {
    assert.equal((await s.run()).state, "complete");
    assert.deepEqual(s.counts, {
      routerSign: 1,
      merchantSign: 1,
      routerSend: 1,
      merchantSend: 1,
      recover: 0,
      routerRecover: 0,
    });
    await assert.rejects(s.again());
    assert.equal((await s.recover()).state, "complete");
    assert.equal(s.counts.merchantSign, 1);
  } finally {
    s.close();
  }
});
test("bad proof and whole-router-group mismatch suppress merchant signing", async () => {
  for (const fault of ["proof", "router_sponsor_mismatch"]) {
    const s = setup(fault);
    try {
      await assert.rejects(s.run());
      assert.equal(s.counts.merchantSign, 0);
      assert.equal(s.counts.merchantSend, 0);
      await s.recover();
      await assert.rejects(s.again());
    } finally {
      s.close();
    }
  }
});
test("lost merchant acknowledgement recovers once with Replay-Only and no second signing or send", async () => {
  const s = setup("seller_lost");
  try {
    assert.equal((await s.run()).state, "unresolved");
    assert.equal((await s.recover()).state, "complete");
    assert.deepEqual(s.counts, {
      routerSign: 1,
      merchantSign: 1,
      routerSend: 1,
      merchantSend: 1,
      recover: 1,
      routerRecover: 0,
    });
  } finally {
    s.close();
  }
});
test("lost router acknowledgement remains fenced; explicit readonly recovery confirms whole group", async () => {
  const s = setup("router_lost");
  try {
    await assert.rejects(s.run());
    assert.equal((await s.recover()).stage, "router_or_proof");
    const recovered = await s.routerRecovery();
    assert.equal(recovered.confirmation.state, "confirmed");
    assert.equal(recovered.settlementReport, "settled");
    assert.deepEqual(s.counts, {
      routerSign: 1,
      merchantSign: 0,
      routerSend: 1,
      merchantSend: 0,
      recover: 0,
      routerRecover: 2,
    });
    await assert.rejects(s.again());
  } finally {
    s.close();
  }
});
test("wallet failure and expiration during merchant signing cannot become another submit", async () => {
  for (const fault of ["wallet_lost", "expired_after_sign"]) {
    const s = setup(fault);
    try {
      if (fault === "wallet_lost") await assert.rejects(s.run());
      else assert.equal((await s.run()).state, "unresolved");
      assert.equal(s.counts.merchantSend, 0);
      await s.recover();
      await assert.rejects(s.again());
      assert.equal(s.counts.routerSign, 1);
    } finally {
      s.close();
    }
  }
});

test("owner CLI plan loads no hooks; callback error text is never printed", () => {
  const s = setup();
  const dir = mkdtempSync(join(tmpdir(), "avm-owner-cli-"));
  try {
    const policyPath = join(dir, "policy.json");
    writeFileSync(policyPath, JSON.stringify(s.policy));
    const cli = new URL("./owner-cli.mjs", import.meta.url).pathname;
    const plan = spawnSync(process.execPath, [cli, "plan", policyPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        ALGOrAND_UNUSED: "1",
        ALGORAND_BATCH_OWNER_FACTORY: "/does-not-exist",
      },
    });
    assert.equal(plan.status, 0, plan.stderr);
    assert.equal(JSON.parse(plan.stdout).campaignMaximumAtomic, "5000");
    const hook = join(dir, "throw.mjs");
    writeFileSync(
      hook,
      "export function createRunHooks(){throw Error('PRIVATE_WALLET_CANARY_lowercasecredential');}",
    );
    const run = spawnSync(
      process.execPath,
      [cli, "run", policyPath, join(dir, "private"), "once", hook],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ALGORAND_BATCH_CAMPAIGN_ACK: "reviewed-mainnet-5000-atomic-v1",
        },
      },
    );
    assert.equal(run.status, 1);
    assert.match(run.stderr, /algorand_campaign_stopped/);
    assert.ok(!run.stderr.includes("PRIVATE_WALLET_CANARY"));
    assert.ok(!run.stderr.includes("lowercasecredential"));
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
