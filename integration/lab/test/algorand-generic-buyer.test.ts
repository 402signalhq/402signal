import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { Address } from "@algorandfoundation/algokit-utils";
import {
  decodeTransaction,
  encodeSignedTransaction,
  bytesForSigning,
  transactionCodec,
} from "@algorandfoundation/algokit-utils/transact";
import {
  buildAlgorandBatchTransactions,
  prepareAlgorandBatch,
  executeAlgorandBatch,
  confirmAlgorandBatchOnce,
} from "../src/algorand-batch.js";
import { Ledger } from "../src/ledger.js";
// @ts-expect-error The native JS offline guard has a standalone API.
import { verifyBatchRoute } from "../../sdk/route-guard/batch.mjs";
const f = JSON.parse(
  readFileSync(
    new URL(
      "../../../../tests/fixtures/algorand-generic-v5.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const pair = generateKeyPairSync("ed25519"),
  buyer = new Address(
    pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32),
  ).toString();
function input() {
  const observed = verifyBatchRoute({
    routeResponseJson: JSON.stringify(f.response),
    routeRequestJson: JSON.stringify(f.request),
    trustedLogVkey: f.trusted_vkey,
    challenge: f.challenge,
    now: f.now,
  });
  const requirement = JSON.parse(f.challenge.bodyText).accepts[0];
  return {
    url: f.request.url,
    origin: new URL(f.request.url).origin,
    requirement,
    buyer,
    raw: buildAlgorandBatchTransactions(requirement, buyer, 1000n, 1100n),
    maxSpendAtomic: "3000",
    manifest: observed.terms,
    profile: "algorand-atomic-two-item-v1" as const,
    buyerLimits: f.request.buyer_limits,
  };
}
test("generic buyer signs exact arbitrary endpoint two-item price and keeps every pin through read-only confirmation", async () => {
  const i = input(),
    p = prepareAlgorandBatch(i),
    ledger = new Ledger(":memory:");
  let signs = 0,
    sends = 0;
  try {
    assert.equal(p.group.totalAtomic, "3000");
    const signer = async (raw: Uint8Array[]) => {
      signs++;
      return raw.map((b, index) => {
        const txn = decodeTransaction(b);
        return index
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
    };
    const send = async (url: string, payment: any) => {
      sends++;
      assert.equal(url, f.request.url);
      assert.equal(
        payment.extensions["402signal-atomic-batch"].itemAmount,
        "1500",
      );
      return { status: 200, body: { accepted: true } };
    };
    const out = await executeAlgorandBatch(
      ledger,
      p,
      signer,
      send,
      async () => {},
    );
    assert.equal(out.status, 200);
    assert.deepEqual(
      await executeAlgorandBatch(ledger, p, signer, send, async () => {}),
      out,
    );
    assert.equal(signs, 1);
    assert.equal(sends, 1);
    const rows = new Map(
      p.raw.map((raw) => {
        const tx = decodeTransaction(raw);
        return [
          tx.txId(),
          {
            "confirmed-round": 1001,
            txn: { txn: transactionCodec.encode(tx, "json") },
          },
        ];
      }),
    );
    const result = await confirmAlgorandBatchOnce(
      p,
      "https://rpc.example",
      async (url, method) => {
        assert.equal(method, "GET");
        return {
          status: 200,
          headers: new Headers(),
          body: url.endsWith("/params")
            ? {
                "genesis-hash": f.request.buyer_limits.network.slice(9),
                "genesis-id": "mainnet-v1.0",
              }
            : rows.get(url.split("/").at(-1)!),
        };
      },
    );
    assert.equal(result.state, "confirmed");
  } finally {
    ledger.close();
  }
});
test("generic buyer rejects missing or weakened binding, per-item caps, jobs and resource before signer", () => {
  const i = input();
  for (const changed of [
    { ...i, profile: undefined },
    { ...i, buyerLimits: undefined },
    { ...i, buyerLimits: { ...i.buyerLimits, max_item_amount_atomic: "1499" } },
    {
      ...i,
      buyerLimits: {
        ...i.buyerLimits,
        job_hashes: ["aa".repeat(32), "bb".repeat(32)],
      },
    },
    { ...i, url: i.url + "&changed=1" },
    { ...i, manifest: { ...i.manifest, totalAmount: "2000" } },
  ])
    assert.throws(() => prepareAlgorandBatch(changed as any));
});
