import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { Address } from "@algorandfoundation/algokit-utils";
import {
  decodeTransaction,
  encodeSignedTransaction,
  bytesForSigning,
  transactionCodec,
} from "@algorandfoundation/algokit-utils/transact";
// @ts-expect-error Repository-only composition module is native JavaScript.
import { AlgorandBatchCampaign } from "../../../batch-buyer/algorand/campaign-operator.mjs";
const fixture = JSON.parse(
  readFileSync(
    new URL("../../../../tests/fixtures/batch-route-v5.json", import.meta.url),
    "utf8",
  ),
)[2];
const pair = generateKeyPairSync("ed25519"),
  buyer = new Address(
    pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32),
  ).toString();
function setup() {
  const p = {
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
  const counts = { route: 0, sign: 0, send: 0, recover: 0 },
    rows = new Map();
  let raw: Uint8Array[] = [];
  const hooks: any = {
    routeOnce: async (request: string, policy: any) => {
      counts.route++;
      assert.deepEqual(JSON.parse(request), fixture.request);
      assert.equal(policy.maximumAtomic, "3000");
      return { routeResponseJson: JSON.stringify(fixture.response) };
    },
    confirmRouter: async () => ({
      state: "confirmed",
      network: p.router.network,
      asset: p.router.asset,
      buyer,
      recipient: p.router.recipient,
      feePayer: p.router.feePayer,
      amountAtomic: "3000",
      buyerNativeFeeAtomic: "0",
    }),
    readSellerChallenge: async () => structuredClone(fixture.challenge),
    suggestedParams: async () => ({
      genesisHash: p.router.network.slice(9),
      genesisId: "mainnet-v1.0",
      minimumFee: "1000",
      feePerByte: "0",
      firstValid: "1000",
      lastValid: "1100",
    }),
    signGroup: async (input: Uint8Array[], indexes: number[]) => {
      counts.sign++;
      assert.deepEqual(indexes, [1, 2]);
      raw = input;
      for (const bytes of raw) {
        const tx = decodeTransaction(bytes);
        rows.set(tx.txId(), {
          "confirmed-round": 1001,
          txn: { txn: transactionCodec.encode(tx, "json") },
        });
      }
      return raw.map((bytes, i) => {
        const txn = decodeTransaction(bytes);
        return i
          ? encodeSignedTransaction({
              txn,
              sig: sign(
                null,
                bytesForSigning.transaction(txn),
                pair.privateKey,
              ),
            })
          : undefined;
      });
    },
    sendSeller: async (_url: string, payment: any) => {
      counts.send++;
      return result(payment);
    },
    recoverSeller: async (_url: string, payment: any, headers: any) => {
      counts.recover++;
      assert.deepEqual(headers, { "Replay-Only": "1" });
      return result(payment);
    },
    readAlgod: async (url: string, method: string) => {
      assert.equal(method, "GET");
      return {
        status: 200,
        body: url.endsWith("/params")
          ? {
              "genesis-hash": p.router.network.slice(9),
              "genesis-id": "mainnet-v1.0",
            }
          : rows.get(url.split("/").at(-1)),
      };
    },
  };
  function result(payment: any) {
    const txs = raw.map(decodeTransaction),
      groupId = Buffer.from(txs[0]!.group!).toString("base64");
    return {
      status: 200,
      body: {
        batch: {
          groupId,
          items: payment.extensions["402signal-atomic-batch"].jobHashes.map(
            (hash: string, i: number) => ({
              index: i + 1,
              result: { sha256: hash },
              transaction: txs[i + 1]!.txId(),
              amount_atomic: "1000",
            }),
          ),
        },
        billing: { amount_atomic: "2000" },
      },
    };
  }
  const dir = mkdtempSync(join(tmpdir(), "avm-campaign-"));
  let campaign = new AlgorandBatchCampaign(dir, p, {
    clock: () => fixture.now,
  });
  return {
    p,
    hooks,
    counts,
    dir,
    get campaign() {
      return campaign;
    },
    reopen() {
      campaign.close();
      campaign = new AlgorandBatchCampaign(dir, p, {
        clock: () => fixture.now + 120,
      });
    },
    close() {
      campaign.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("real v5 proof gates buyer-owned group and whole immutable campaign completes once", async () => {
  const s = setup();
  try {
    const result = await s.campaign.run("one", s.hooks);
    assert.equal(result.state, "complete");
    assert.equal(result.confirmation.sponsorFeeMicroAlgo, "3000");
    assert.deepEqual(s.counts, { route: 1, sign: 1, send: 1, recover: 0 });
    await assert.rejects(s.campaign.run("one", s.hooks));
    await assert.rejects(s.campaign.run("two", s.hooks));
    s.reopen();
    assert.equal((await s.campaign.recover("one", s.hooks)).state, "complete");
    assert.deepEqual(s.counts, { route: 1, sign: 1, send: 1, recover: 0 });
  } finally {
    s.close();
  }
});
test("proof, challenge and independent router confirmation failures never invoke merchant signer", async () => {
  for (const fault of ["proof", "challenge", "confirmation"]) {
    const s = setup();
    try {
      if (fault === "proof")
        s.hooks.routeOnce = async () => ({
          routeResponseJson: JSON.stringify({
            ...fixture.response,
            batch_terms: {},
          }),
        });
      if (fault === "challenge")
        s.hooks.readSellerChallenge = async () => ({
          ...fixture.challenge,
          bodyText: fixture.challenge.bodyText + " ",
        });
      if (fault === "confirmation")
        s.hooks.confirmRouter = async () => ({ state: "unknown" });
      await assert.rejects(s.campaign.run("one", s.hooks));
      assert.equal(s.counts.sign, 0);
      assert.equal(s.counts.send, 0);
      s.reopen();
      await s.campaign.recover("one", s.hooks);
      assert.equal(s.counts.sign, 0);
      assert.equal(s.counts.send, 0);
    } finally {
      s.close();
    }
  }
});
test("uncertain router callback stays spent and recovery cannot advance into merchant stage", async () => {
  const s = setup();
  try {
    s.hooks.routeOnce = async () => {
      s.counts.route++;
      throw new Error("lost acknowledgement");
    };
    await assert.rejects(s.campaign.run("one", s.hooks));
    s.reopen();
    assert.equal(
      (await s.campaign.recover("one", s.hooks)).state,
      "unresolved",
    );
    await assert.rejects(s.campaign.run("two", s.hooks));
    assert.deepEqual(s.counts, { route: 1, sign: 0, send: 0, recover: 0 });
  } finally {
    s.close();
  }
});
test("uncertain group delivery recovers using explicit read-only merchant contract without signing again", async () => {
  const s = setup();
  try {
    s.hooks.sendSeller = async () => {
      s.counts.send++;
      throw new Error("lost acknowledgement");
    };
    assert.equal((await s.campaign.run("one", s.hooks)).state, "unresolved");
    s.reopen();
    assert.equal((await s.campaign.recover("one", s.hooks)).state, "complete");
    assert.deepEqual(s.counts, { route: 1, sign: 1, send: 1, recover: 1 });
  } finally {
    s.close();
  }
});
test("wallet failure after durable claim never invokes wallet again on recovery", async () => {
  const s = setup();
  try {
    s.hooks.signGroup = async () => {
      s.counts.sign++;
      throw new Error("wallet stopped");
    };
    assert.equal((await s.campaign.run("one", s.hooks)).state, "unresolved");
    s.reopen();
    assert.equal(
      (await s.campaign.recover("one", s.hooks)).state,
      "unresolved",
    );
    assert.deepEqual(s.counts, { route: 1, sign: 1, send: 0, recover: 0 });
  } finally {
    s.close();
  }
});
