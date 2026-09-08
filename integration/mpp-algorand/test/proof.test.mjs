import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import { Address } from "@algorandfoundation/algokit-utils";
import {
  decodeTransaction,
  encodeSignedTransaction,
  bytesForSigning,
} from "@algorandfoundation/algokit-utils/transact";
import { Receipt } from "mppx";
import { verifyBatchRoute } from "../../../sdk/route-guard/batch.mjs";
import { AlgorandManifestStore } from "../../batch-buyer/algorand/manifest-store.mjs";
import {
  prepareNativeAlgorandCharge,
  executeVerifiedNativeAlgorandCharge,
} from "../index.mjs";
process.env.LIVE402_FIXTURE = "1";
const vectors = JSON.parse(
  readFileSync(
    new URL(
      "../../../tests/fixtures/algorand-mpp-charge-v5.json",
      import.meta.url,
    ),
  ),
);
const evidence = (v) => ({
  routeResponseJson: JSON.stringify(v.response),
  routeRequestJson: JSON.stringify(v.request),
  trustedLogVkey: v.trusted_vkey,
});
test("all actual SDK quote sizes and Python signed v5 receipts verify offline", () => {
  for (const v of vectors) {
    const out = verifyBatchRoute({
      ...evidence(v),
      challenge: v.challenge,
      now: v.now,
    });
    assert.deepEqual(out.terms, v.expectedTerms);
    assert.throws(() =>
      verifyBatchRoute({
        ...evidence(v),
        challenge: v.challenge,
        now: v.now + 60,
      }),
    );
    const bad = structuredClone(v.response);
    bad.batch_terms.amount_atomic = "1";
    assert.throws(() =>
      verifyBatchRoute({
        ...evidence(v),
        routeResponseJson: JSON.stringify(bad),
        challenge: v.challenge,
        now: v.now,
      }),
    );
  }
});
test("actual wallet SDK requires matching v5 proof plus independently confirmed router payment before signing", async () => {
  const v = vectors[0],
    pair = generateKeyPairSync("ed25519"),
    buyer = new Address(
      pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32),
    ).toString();
  const plan = prepareNativeAlgorandCharge({
    request: { url: v.request.url, method: "GET", body: new Uint8Array() },
    challenge: v.challenge,
    limits: v.request.buyer_limits,
    buyer,
    now: v.now,
  });
  for (const mode of [
    "success",
    "router-unknown",
    "mismatched-proof",
    "expired",
    "budget-declined",
    "duplicate-receipt",
    "wrong-receipt",
  ]) {
    const db = new AlgorandManifestStore(":memory:");
    let signatures = 0,
      sends = 0,
      reservations = new Set(),
      clock = v.now;
    const e = evidence(v);
    if (mode === "mismatched-proof") {
      const b = structuredClone(v.request);
      b.url += "&changed=1";
      e.routeRequestJson = JSON.stringify(b);
    }
    if (mode === "expired") clock += 60;
    const opts = {
      routeEvidence: e,
      confirmRouterPayment: async () => mode !== "router-unknown",
      reserveBudget: async (id) => {
        if (mode === "budget-declined") throw Error("declined");
        reservations.add(id);
      },
      now: () => clock,
      readParams: async () => ({
        fee: 0,
        "min-fee": 1000,
        "last-round": 1000,
        "genesis-hash": v.offer.methodDetails.suggestedParams.genesisHash,
        "genesis-id": "mainnet-v1.0",
      }),
      sign: async (raw, indexes) => {
        signatures++;
        return raw.map((b, i) =>
          indexes.includes(i)
            ? encodeSignedTransaction({
                txn: decodeTransaction(b),
                sig: sign(
                  null,
                  bytesForSigning.transaction(decodeTransaction(b)),
                  pair.privateKey,
                ),
              })
            : null,
        );
      },
      send: async () => {
        sends++;
        let receipt = Receipt.serialize({
          method: "algorand",
          status: "success",
          reference: plan.inspection.transactionIds[0],
          timestamp: new Date(v.now * 1000).toISOString(),
        });
        if (mode === "duplicate-receipt")
          receipt = Buffer.from(
            '{"method":"algorand","method":"algorand","status":"success","reference":"' +
              plan.inspection.transactionIds[0] +
              '"}',
          ).toString("base64url");
        if (mode === "wrong-receipt")
          receipt = Receipt.serialize({
            method: "algorand",
            status: "success",
            reference: "different",
            timestamp: new Date(v.now * 1000).toISOString(),
          });
        return {
          status: 200,
          bodyText: '{"ok":true}',
          paymentReceipt: receipt,
        };
      },
    };
    try {
      const out = await executeVerifiedNativeAlgorandCharge(
        db,
        "proof",
        plan,
        opts,
      );
      assert.equal(
        out.state,
        mode === "success" ? "merchant_acknowledged" : "unknown",
        mode,
      );
      await executeVerifiedNativeAlgorandCharge(db, "proof", plan, opts);
      await executeVerifiedNativeAlgorandCharge(db, "changed-id", plan, opts);
      const maySign = [
        "success",
        "duplicate-receipt",
        "wrong-receipt",
      ].includes(mode);
      assert.equal(signatures, maySign ? 1 : 0, mode);
      assert.equal(sends, maySign ? 1 : 0, mode);
      assert(reservations.size <= 1);
    } finally {
      db.close();
    }
  }
});
