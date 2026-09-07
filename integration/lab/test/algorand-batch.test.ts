import test from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
  createPublicKey,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Address } from "@algorandfoundation/algokit-utils";
import {
  bytesForSigning,
  decodeTransaction,
  decodeSignedTransaction,
  encodeSignedTransaction,
  encodeTransactionRaw,
  transactionCodec,
} from "@algorandfoundation/algokit-utils/transact";
import { ExactAvmScheme } from "@x402/avm/exact/facilitator";
import type { PaymentRequirements } from "@x402/core/types";
import {
  ALGORAND_BATCH_EXTENSION,
  algorandBatchManifest,
  algorandBatchRequest,
  buildAlgorandBatchTransactions,
  prepareAlgorandBatch,
  signAlgorandBatch,
  executeAlgorandBatch,
  confirmAlgorandBatchOnce,
} from "../src/algorand-batch.js";
import { AlgorandBatchSeller } from "../src/algorand-batch-seller.js";
import { Ledger } from "../src/ledger.js";
import { canonical, encode64 } from "../src/json.js";
import { railInfo } from "../src/config.js";

// Generated synthetic identities, no imported wallets or network access.
function key() {
  const pair = generateKeyPairSync("ed25519");
  const publicBytes = pair.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  return { ...pair, address: new Address(publicBytes).toString() };
}
const buyer = key(),
  sponsor = key(),
  recipient = key();
const origin = "https://batch.example",
  url = origin + "/algorand/batch/sha256?left=alpha&right=beta";
const info = railInfo("algorand", "mainnet");
const requirement: PaymentRequirements = {
  scheme: "exact",
  network: info.network,
  asset: info.asset,
  amount: "1000",
  payTo: recipient.address,
  maxTimeoutSeconds: 60,
  extra: { feePayer: sponsor.address },
};
function plan() {
  return prepareAlgorandBatch({
    url,
    origin,
    requirement,
    buyer: buyer.address,
    raw: buildAlgorandBatchTransactions(
      requirement,
      buyer.address,
      1000n,
      1100n,
    ),
    maxSpendAtomic: "2000",
    manifest: algorandBatchManifest(url, origin, requirement),
  });
}
function signature(raw: Uint8Array, k = buyer) {
  const txn = decodeTransaction(raw);
  return encodeSignedTransaction({
    txn,
    sig: nodeSign(null, bytesForSigning.transaction(txn), k.privateKey),
  });
}
async function sign(raw: Uint8Array[], indexes: number[]) {
  assert.deepEqual(indexes, [1, 2]);
  return raw.map((b, i) => (i === 0 ? undefined : signature(b)));
}
function provider() {
  let sends = 0,
    simulates = 0,
    verifies = 0;
  const scheme = new ExactAvmScheme({
    getAddresses: () => [sponsor.address],
    signTransaction: async (raw: Uint8Array) => signature(raw, sponsor),
    simulateTransactions: async (raw: Uint8Array[]) => {
      simulates++;
      assert.equal(raw.length, 3);
      for (const bytes of raw) {
        const s = decodeSignedTransaction(bytes);
        const pub = createPublicKey({
          key: Buffer.concat([
            Buffer.from("302a300506032b6570032100", "hex"),
            s.txn.sender.publicKey,
          ]),
          format: "der",
          type: "spki",
        });
        assert.equal(
          nodeVerify(null, bytesForSigning.transaction(s.txn), pub, s.sig!),
          true,
        );
      }
      return { txnGroups: [{}] };
    },
    sendTransactions: async (raw: Uint8Array[]) => {
      sends++;
      assert.equal(raw.length, 3);
    },
    waitForConfirmation: async () => ({ confirmedRound: 1001 }),
  } as any);
  return {
    adapter: {
      verify: async (p: any, r: any) => {
        verifies++;
        return scheme.verify(p, r);
      },
      settle: scheme.settle.bind(scheme),
    },
    counts: () => ({ sends, simulates, verifies }),
  };
}

test("explicit manifest binds every job, total, recipient, resource, asset and sponsor", () => {
  const p = plan();
  assert.equal(p.group.totalAtomic, "2000");
  assert.equal(p.group.transfers.length, 2);
  assert.notEqual(
    p.group.transfers[0]!.transaction,
    p.group.transfers[1]!.transaction,
  );
  for (const [field, value] of Object.entries({
    totalAmount: "1000",
    itemCount: 1,
    recipient: buyer.address,
    resource: url + "&x=y",
    jobHashes: ["bad", "bad"],
    paymentIndices: [2, 1],
    feePayer: buyer.address,
  })) {
    assert.throws(() =>
      prepareAlgorandBatch({
        url,
        origin,
        requirement,
        buyer: buyer.address,
        raw: p.raw,
        maxSpendAtomic: "2000",
        manifest: { ...p.manifest, [field]: value } as any,
      }),
    );
  }
  assert.throws(() =>
    prepareAlgorandBatch({
      url,
      origin,
      requirement,
      buyer: buyer.address,
      raw: p.raw,
      maxSpendAtomic: "1999",
      manifest: p.manifest,
    }),
  );
  assert.throws(() => algorandBatchRequest(url + "&left=duplicate", origin));
  assert.throws(() =>
    algorandBatchRequest(url.replace("batch.example", "other.example"), origin),
  );
  assert.throws(() =>
    algorandBatchRequest(url.replace("left=alpha", "left="), origin),
  );
});

test("buyer signing verifies both signatures and refuses sponsor signing or mutation", async () => {
  const p = plan(),
    payment = await signAlgorandBatch(p, sign);
  assert.equal((payment.payload as any).paymentGroup.length, 3);
  assert.equal(
    canonical(payment.extensions![ALGORAND_BATCH_EXTENSION]),
    canonical(p.manifest),
  );
  await assert.rejects(
    signAlgorandBatch(p, async (raw) => raw.map((b) => signature(b))),
  );
  await assert.rejects(
    signAlgorandBatch(p, async (raw) => [
      undefined,
      signature(raw[1]!),
      signature(raw[2]!, sponsor),
    ]),
  );
  await assert.rejects(
    signAlgorandBatch(p, async (raw) => [
      undefined,
      signature(raw[2]!),
      signature(raw[1]!),
    ]),
  );
});

test("official AVM2.25 facilitator settles the entire valid group once and merchant returns two indexed results", async () => {
  const ledger = new Ledger(":memory:"),
    f = provider(),
    seller = new AlgorandBatchSeller(origin, requirement, ledger, f.adapter);
  try {
    const challenge = seller.challenge(url);
    assert.equal(
      challenge.body.extensions[ALGORAND_BATCH_EXTENSION].totalAmount,
      "2000",
    );
    const payment = await signAlgorandBatch(plan(), sign),
      header = encode64(payment);
    const a = await seller.request(url, header);
    assert.equal(a.status, 200);
    assert.equal(a.body.batch.items.length, 2);
    assert.equal(a.body.billing.amount_atomic, "2000");
    assert.equal(a.body.billing.settlement_state, "provider_ack");
    assert.equal(
      a.body.evidence.chain_confirmation,
      "not_independently_checked",
    );
    assert.deepEqual(await seller.request(url, header), a);
    assert.equal(f.counts().sends, 1);
    for (const changed of [
      { ...payment, extensions: {} },
      { ...payment, payload: { ...payment.payload, paymentIndex: 2 } },
    ]) {
      await assert.rejects(seller.request(url, encode64(changed)));
    }
    assert.equal(f.counts().sends, 1);
  } finally {
    ledger.close();
  }
});

test("unaware single-payment and wrong extension are refused before facilitator calls", async () => {
  const ledger = new Ledger(":memory:"),
    f = provider(),
    seller = new AlgorandBatchSeller(origin, requirement, ledger, f.adapter);
  try {
    const payment = await signAlgorandBatch(plan(), sign);
    await assert.rejects(
      seller.request(url, encode64({ ...payment, extensions: undefined })),
    );
    await assert.rejects(
      seller.request(
        url,
        encode64({
          ...payment,
          payload: {
            ...payment.payload,
            paymentGroup: (payment.payload as any).paymentGroup.slice(0, 2),
          },
        }),
      ),
    );
    assert.deepEqual(f.counts(), { sends: 0, simulates: 0, verifies: 0 });
  } finally {
    ledger.close();
  }
});

test("buyer concurrent attempts authorize independently but sign/send only once; proof rejection signs nothing", async () => {
  const ledger = new Ledger(":memory:");
  let signatures = 0,
    sends = 0;
  try {
    const signer = async (raw: Uint8Array[], indexes: number[]) => {
      signatures++;
      return sign(raw, indexes);
    };
    const send = async () => {
      sends++;
      return { status: 200, body: { ack: true } };
    };
    await assert.rejects(
      executeAlgorandBatch(ledger, plan(), signer, send, async () => {
        throw new Error("proof refused");
      }),
    );
    assert.equal(signatures, 0);
    assert.equal(sends, 0);
    await Promise.all(
      Array.from({ length: 12 }, () =>
        executeAlgorandBatch(ledger, plan(), signer, send, async () => {}),
      ),
    );
    assert.equal(signatures, 1);
    assert.equal(sends, 1);
  } finally {
    ledger.close();
  }
});

test("merchant timeout after possible full-group send persists unknown after reopen; no automatic retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "avm-batch-")),
    path = join(dir, "merchant.sqlite");
  let ledger = new Ledger(path),
    sends = 0;
  const f = {
    verify: async () => ({ isValid: true }),
    settle: async () => {
      sends++;
      throw new Error("lost after possible chain send");
    },
  };
  try {
    const payment = await signAlgorandBatch(plan(), sign),
      header = encode64(payment);
    const result = await new AlgorandBatchSeller(
      origin,
      requirement,
      ledger,
      f as any,
    ).request(url, header);
    assert.equal(result.status, 503);
    assert.equal(result.body.billing.settled, null);
    ledger.close();
    ledger = new Ledger(path);
    assert.deepEqual(
      await new AlgorandBatchSeller(
        origin,
        requirement,
        ledger,
        f as any,
      ).request(url, header),
      result,
    );
    assert.equal(sends, 1);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buyer lost wallet/send acknowledgement remains blocked after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "avm-buyer-")),
    path = join(dir, "buyer.sqlite");
  let ledger = new Ledger(path),
    sends = 0,
    signatures = 0;
  const signer = async (raw: Uint8Array[], indexes: number[]) => {
    signatures++;
    return sign(raw, indexes);
  };
  const send = async () => {
    sends++;
    throw new Error("lost response");
  };
  try {
    const result = await executeAlgorandBatch(
      ledger,
      plan(),
      signer,
      send,
      async () => {},
    );
    assert.equal(result.status, 503);
    ledger.close();
    ledger = new Ledger(path);
    assert.deepEqual(
      await executeAlgorandBatch(ledger, plan(), signer, send, async () => {}),
      result,
    );
    assert.equal(sends, 1);
    assert.equal(signatures, 1);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("independent confirmation checks network and all three exact transactions in one round", async () => {
  const p = plan();
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
  let calls = 0;
  const send: any = async (u: string, method: string) => {
    calls++;
    assert.equal(method, "GET");
    return {
      status: 200,
      body: u.endsWith("/params")
        ? {
            "genesis-hash": Buffer.from(
              decodeTransaction(p.raw[0]!).genesisHash!,
            ).toString("base64"),
            "genesis-id": "mainnet-v1.0",
          }
        : rows.get(u.split("/").at(-1)!),
    };
  };
  const result = await confirmAlgorandBatchOnce(p, "https://rpc.example", send);
  assert.equal(result.state, "confirmed");
  assert.equal(calls, 4);
  if (result.state === "confirmed") {
    assert.equal(result.totalAtomic, "2000");
    assert.equal(result.sponsorFeeMicroAlgo, "3000");
    assert.equal(result.buyerNativeFeeAtomic, "0");
  }
  const second = rows.get(decodeTransaction(p.raw[2]!).txId())!;
  second["confirmed-round"] = 1002;
  assert.equal(
    (await confirmAlgorandBatchOnce(p, "https://rpc.example", send)).state,
    "unknown",
  );
  second["confirmed-round"] = 1001;
  rows.delete(decodeTransaction(p.raw[0]!).txId());
  assert.equal(
    (await confirmAlgorandBatchOnce(p, "https://rpc.example", send)).state,
    "unknown",
  );
});

test("completed buyer replay is retrievable after route proof expiry without new authorization", async () => {
  const ledger = new Ledger(":memory:");
  let authorizations = 0;
  try {
    const authorize = async () => {
      authorizations++;
      if (authorizations > 1) throw new Error("expired proof");
    };
    const send = async () => ({ status: 200, body: { ack: true } });
    const result = await executeAlgorandBatch(
      ledger,
      plan(),
      sign,
      send,
      authorize,
    );
    assert.deepEqual(
      await executeAlgorandBatch(ledger, plan(), sign, send, authorize),
      result,
    );
    assert.equal(authorizations, 1);
  } finally {
    ledger.close();
  }
});
