import test from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
  createPublicKey,
} from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { Address } from "@algorandfoundation/algokit-utils";
import {
  bytesForSigning,
  decodeTransaction,
  decodeSignedTransaction,
  encodeSignedTransaction,
  encodeTransactionRaw,
  transactionCodec,
  groupTransactions,
} from "@algorandfoundation/algokit-utils/transact";
import { ExactAvmScheme } from "@x402/avm/exact/facilitator";
import {
  quoteAlgorandManifestFees,
  checkCurrentAlgorandManifestQuote,
  createAlgorandManifestOffer,
  buildAlgorandManifestTransactions,
  prepareAlgorandManifest,
  signAlgorandManifest,
  checkSignedAlgorandManifest,
  executeAlgorandManifest,
  recoverAlgorandManifest,
  confirmAlgorandManifestOnce,
  type AlgorandManifestProfile,
  type AlgorandManifestPlan,
} from "../src/algorand-manifest.js";
import {
  AlgorandManifestSeller,
  algorandManifestHttpHandler,
} from "../src/algorand-manifest-seller.js";
import { AlgorandManifestStore } from "../src/algorand-manifest-store.js";
import { digest, canonical, encode64 } from "../src/json.js";
process.env.LIVE402_FIXTURE = "1";
const NOW = 1800000000,
  ATOMIC = "algorand-atomic-multi-item-v1",
  INVOICE = "algorand-aggregate-invoice-v1";
function key() {
  const p = generateKeyPairSync("ed25519");
  return {
    ...p,
    address: new Address(
      p.publicKey.export({ format: "der", type: "spki" }).subarray(-32),
    ).toString(),
  };
}
const buyer = key(),
  sponsor = key(),
  merchant = key();
const params = {
  "genesis-hash": "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
  "genesis-id": "mainnet-v1.0",
  "last-round": 1000,
  fee: 0,
  "min-fee": 1000,
};
const url = "https://merchant.example/v2/jobs?order=original&value=%61";
function setup(profile: AlgorandManifestProfile = ATOMIC, jobs = 3) {
  const payments = profile === ATOMIC ? jobs : 1,
    amount = profile === ATOMIC ? "1000" : "2500";
  const requirement = {
    scheme: "exact",
    network: ("algorand:" + params["genesis-hash"]) as `${string}:${string}`,
    asset: "31566704",
    amount,
    payTo: merchant.address,
    maxTimeoutSeconds: 60,
    extra: { feePayer: sponsor.address },
  };
  const limits = {
    network: requirement.network,
    asset: requirement.asset,
    recipient: merchant.address,
    fee_payer: sponsor.address,
    max_total_amount_atomic: String(BigInt(amount) * BigInt(payments)),
    max_sponsor_fee_micro_algo: String((payments + 1) * 1000),
    job_hashes: Array.from({ length: jobs }, (_, i) => digest("job-" + i)),
    ...(profile === ATOMIC ? { max_item_amount_atomic: amount } : {}),
  };
  const envelope = createAlgorandManifestOffer(
    profile,
    url,
    requirement,
    limits,
    quoteAlgorandManifestFees(params, payments, NOW),
  );
  const plan = prepareAlgorandManifest({
    profile,
    envelope,
    limits,
    buyer: buyer.address,
    raw: buildAlgorandManifestTransactions(
      profile,
      envelope,
      limits,
      buyer.address,
    ),
  });
  return {
    profile,
    requirement,
    limits,
    envelope,
    plan,
    config: {
      offerId: "synthetic-" + profile + "-" + jobs,
      profile,
      url,
      requirement,
      limits,
      buyer: buyer.address,
    },
  };
}
function signature(raw: Uint8Array, k = buyer) {
  const txn = decodeTransaction(raw);
  return encodeSignedTransaction({
    txn,
    sig: nodeSign(null, bytesForSigning.transaction(txn), k.privateKey),
  });
}
async function signer(raw: Uint8Array[], indexes: number[]) {
  assert.deepEqual(
    indexes,
    raw.slice(1).map((_, i) => i + 1),
  );
  return raw.map((b, i) => (i ? signature(b) : undefined));
}
function recoveryRequest(plan: AlgorandManifestPlan, payment: any) {
  return {
    recoveryOnly: true as const,
    url: plan.envelope.resource.url,
    groupId: plan.group.groupId,
    requestDigest: plan.scope,
    authorizationDigest: digest(canonical(payment)),
  };
}
function provider(size: number, lose = false) {
  let sends = 0,
    verifies = 0,
    simulates = 0;
  const scheme = new ExactAvmScheme({
    getAddresses: () => [sponsor.address],
    signTransaction: async (raw: Uint8Array) => signature(raw, sponsor),
    simulateTransactions: async (raw: Uint8Array[]) => {
      simulates++;
      assert.equal(raw.length, size);
      for (const b of raw) {
        const s = decodeSignedTransaction(b),
          pub = createPublicKey({
            key: Buffer.concat([
              Buffer.from("302a300506032b6570032100", "hex"),
              s.txn.sender.publicKey,
            ]),
            format: "der",
            type: "spki",
          });
        assert(
          nodeVerify(null, bytesForSigning.transaction(s.txn), pub, s.sig!),
        );
      }
      return { txnGroups: [{}] };
    },
    sendTransactions: async (raw: Uint8Array[]) => {
      sends++;
      assert.equal(raw.length, size);
      if (lose) throw Error("synthetic lost broadcast acknowledgment");
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
    counts: () => ({ sends, verifies, simulates }),
  };
}
for (const [profile, jobs] of [
  [ATOMIC, 2],
  [ATOMIC, 3],
  [ATOMIC, 15],
  [INVOICE, 2],
  [INVOICE, 64],
] as [AlgorandManifestProfile, number][]) {
  test(`actual SDK ${profile} ${jobs} jobs binds all payments and settles once`, async () => {
    const s = setup(profile, jobs),
      journal = new AlgorandManifestStore(":memory:"),
      f = provider(s.plan.raw.length),
      seller = new AlgorandManifestSeller(
        s.config,
        journal,
        f.adapter,
        async () => params,
        () => NOW,
      );
    try {
      const quote = await seller.challenge(url);
      assert.equal(quote.status, 402);
      assert.equal(canonical(quote.body), canonical(s.envelope));
      const payment = await signAlgorandManifest(s.plan, signer, NOW),
        header = encode64(payment);
      assert(header.length <= 16384);
      const checked = await checkSignedAlgorandManifest(
        profile,
        s.envelope,
        s.limits,
        buyer.address,
        payment,
      );
      assert.equal(checked.group.groupId, s.plan.group.groupId);
      const out = await seller.request(url, header);
      assert.equal(out.status, 200);
      assert.equal(out.body.batch.jobCount, jobs);
      assert.equal(out.body.batch.paymentCount, s.plan.raw.length - 1);
      assert.equal(
        out.body.billing.amount_atomic,
        s.limits.max_total_amount_atomic,
      );
      assert.equal(
        out.body.billing.sponsor_fee_micro_algo,
        String(s.plan.raw.length * 1000),
      );
      assert.equal(
        canonical(await seller.recover(recoveryRequest(s.plan, payment))),
        canonical({ ...out, recoveryOnly: true }),
      );
      assert.equal(f.counts().sends, 1);
      console.log(
        JSON.stringify({
          profile,
          jobs,
          transactions: s.plan.raw.length,
          paymentHeaderBytes: header.length,
        }),
      );
    } finally {
      journal.close();
    }
  });
}
test("quote fee and round changes, congestion, cap and unknown per-job allocation refuse before signing", () => {
  const s = setup();
  for (const patch of [
    { fee: 1 },
    { "min-fee": 999 },
    { "min-fee": 5001 },
    { "genesis-id": "testnet-v1.0" },
    { "last-round": 0 },
  ])
    assert.throws(() =>
      quoteAlgorandManifestFees({ ...params, ...patch }, 3, NOW),
    );
  for (const patch of [
    { "min-fee": 2000 },
    { "last-round": 999 },
    { "last-round": 1102 },
  ])
    assert.throws(() =>
      checkCurrentAlgorandManifestQuote(
        s.plan.manifest.feeQuote,
        { ...params, ...patch },
        NOW,
      ),
    );
  assert.throws(() =>
    checkCurrentAlgorandManifestQuote(
      s.plan.manifest.feeQuote,
      params,
      NOW + 45,
    ),
  );
  const invoice = setup(INVOICE, 64);
  assert.equal(invoice.plan.manifest.perJobAmount, null);
  assert.throws(() =>
    createAlgorandManifestOffer(
      INVOICE,
      url,
      invoice.requirement,
      { ...invoice.limits, max_item_amount_atomic: "2500" },
      invoice.plan.manifest.feeQuote,
    ),
  );
  assert.throws(() =>
    prepareAlgorandManifest({
      ...s.plan,
      limits: { ...s.limits, max_sponsor_fee_micro_algo: "3999" },
    }),
  );
});
test("unsigned exact byte/order/group/fee/recipient/asset/note policies reject every mutation", () => {
  const s = setup();
  for (const mutate of [
    (t: any[]) => t.reverse(),
    (t: any[]) => (t[1].assetTransfer.amount = 999n),
    (t: any[]) =>
      (t[1].assetTransfer.receiver = Address.fromString(buyer.address)),
    (t: any[]) => (t[1].assetTransfer.assetId = 1n),
    (t: any[]) => (t[1].fee = 1n),
    (t: any[]) => (t[0].fee = 3000n),
    (t: any[]) => (t[0].fee = 5000n),
    (t: any[]) => (t[1].note = Buffer.from("unbound")),
    (t: any[]) => (t[1].firstValid = 1002n),
    (t: any[]) => (t[1].rekeyTo = Address.fromString(sponsor.address)),
    (t: any[]) =>
      (t[1].assetTransfer.closeRemainderTo = Address.fromString(
        sponsor.address,
      )),
    (t: any[]) =>
      (t[1].assetTransfer.assetSender = Address.fromString(sponsor.address)),
  ]) {
    const tx = s.plan.raw.map(decodeTransaction);
    mutate(tx);
    assert.throws(() =>
      prepareAlgorandManifest({ ...s.plan, raw: tx.map(encodeTransactionRaw) }),
    );
  }
});
test("all buyer signatures and sponsor role are checked before provider calls", async () => {
  const s = setup(ATOMIC, 15);
  for (const bad of [
    async (raw: Uint8Array[]) => raw.map((b) => signature(b)),
    async (raw: Uint8Array[]) =>
      raw.map((b, i) =>
        i ? signature(b, i === 15 ? sponsor : buyer) : undefined,
      ),
    async (raw: Uint8Array[]) =>
      raw.map((b, i) =>
        i ? signature(raw[i === 1 ? 2 : i === 2 ? 1 : i]!) : undefined,
      ),
  ])
    await assert.rejects(signAlgorandManifest(s.plan, bad, NOW));
  const signed = await signAlgorandManifest(s.plan, signer, NOW),
    bad = structuredClone(signed);
  bad.payload.paymentIndex = 2;
  await assert.rejects(
    checkSignedAlgorandManifest(
      s.profile,
      s.envelope,
      s.limits,
      buyer.address,
      bad,
    ),
  );
});
test("independent connections compete for one signing/send claim and recovery after lost HTTP ACK survives restart/expiry", async () => {
  const d = mkdtempSync(join(tmpdir(), "manifest-")),
    bp = join(d, "buyer.sqlite"),
    mp = join(d, "merchant.sqlite"),
    s = setup(INVOICE, 64),
    f = provider(2);
  let a = new AlgorandManifestStore(bp),
    b = new AlgorandManifestStore(bp),
    m = new AlgorandManifestStore(mp),
    clock = NOW,
    signs = 0,
    sends = 0;
  let seller = new AlgorandManifestSeller(
    s.config,
    m,
    f.adapter,
    async () => params,
    () => clock,
  );
  try {
    await seller.challenge(url);
    const options = {
      authorize: async () => {},
      readParams: async () => params,
      now: () => clock,
      sign: async (raw: Uint8Array[], i: number[]) => {
        signs++;
        return signer(raw, i);
      },
      send: async (u: string, p: any) => {
        sends++;
        await seller.request(u, encode64(p));
        throw Error("lost HTTP acknowledgment");
      },
    };
    await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        executeAlgorandManifest(i % 2 ? a : b, "operation", s.plan, options),
      ),
    );
    assert.equal(
      (await executeAlgorandManifest(a, "different-operation", s.plan, options))
        .status,
      503,
    );
    assert.equal(signs, 1);
    assert.equal(sends, 1);
    assert.equal(f.counts().sends, 1);
    a.close();
    b.close();
    m.close();
    a = new AlgorandManifestStore(bp);
    b = new AlgorandManifestStore(bp);
    m = new AlgorandManifestStore(mp);
    seller = new AlgorandManifestSeller(
      s.config,
      m,
      f.adapter,
      async () => {
        throw Error("recovery must not RPC");
      },
      () => (clock = NOW + 1000),
    );
    assert.equal(
      (await executeAlgorandManifest(a, "operation", s.plan, options)).status,
      503,
    );
    for (const read of [
      async () => ({ status: 503, body: {}, recoveryOnly: true as const }),
      async () => {
        throw Error("lost recovery ACK");
      },
      async (request: any) => {
        const out = await seller.recover(request);
        out.body.batch.items[0].jobHash = "00".repeat(32);
        return out;
      },
    ])
      assert.equal(
        (await recoverAlgorandManifest(a, "operation", s.plan, read)).status,
        503,
      );
    const out = await recoverAlgorandManifest(
      a,
      "operation",
      s.plan,
      async (request) => {
        assert.equal(request.recoveryOnly, true);
        assert.deepEqual(Object.keys(request).sort(), [
          "authorizationDigest",
          "groupId",
          "recoveryOnly",
          "requestDigest",
          "url",
        ]);
        assert(!JSON.stringify(request).includes("Payment-Signature"));
        return seller.recover(request);
      },
    );
    assert.equal(out.status, 200);
    assert.equal(signs, 1);
    assert.equal(sends, 1);
    assert.equal(f.counts().sends, 1);
    assert.equal(statSync(bp).mode & 0o777, 0o600);
  } finally {
    a.close();
    b.close();
    m.close();
    rmSync(d, { recursive: true, force: true });
  }
});
test("lost signer or provider acknowledgment stays fenced; expired after signing sends nothing", async () => {
  for (const mode of ["signer", "provider", "expired"]) {
    const s = setup(),
      a = new AlgorandManifestStore(":memory:"),
      m = new AlgorandManifestStore(":memory:"),
      f = provider(4, mode === "provider");
    let clock = NOW,
      signs = 0,
      sends = 0;
    const seller = new AlgorandManifestSeller(
      s.config,
      m,
      f.adapter,
      async () => params,
      () => clock,
    );
    try {
      await seller.challenge(url);
      const options = {
        authorize: async () => {},
        readParams: async () => params,
        now: () => clock,
        sign: async (raw: Uint8Array[], i: number[]) => {
          signs++;
          if (mode === "signer") throw Error("wallet result lost");
          const p = await signer(raw, i);
          if (mode === "expired") clock += 60;
          return p;
        },
        send: async (u: string, p: any) => {
          sends++;
          return seller.request(u, encode64(p));
        },
      };
      assert.equal(
        (await executeAlgorandManifest(a, "once", s.plan, options)).status,
        503,
      );
      assert.equal(
        (await executeAlgorandManifest(a, "once", s.plan, options)).status,
        503,
      );
      assert.equal(signs, 1);
      assert.equal(sends, mode === "provider" ? 1 : 0);
      assert(f.counts().sends <= 1);
    } finally {
      a.close();
      m.close();
    }
  }
});
test("independent chain confirmation checks all16 exact transaction effects and round", async () => {
  const s = setup(ATOMIC, 15),
    rows = new Map(
      s.plan.raw.map((raw) => {
        const t = decodeTransaction(raw);
        return [
          t.txId(),
          {
            "confirmed-round": 1001,
            txn: { txn: transactionCodec.encode(t, "json") },
          },
        ];
      }),
    );
  let reads = 0;
  const read = async (u: string) => {
    reads++;
    return {
      status: 200,
      body: u.endsWith("/params") ? params : rows.get(u.split("/").at(-1)!),
    };
  };
  assert.equal(
    (await confirmAlgorandManifestOnce(s.plan, "https://rpc.example", read))
      .state,
    "confirmed",
  );
  assert.equal(reads, 17);
  rows.get(decodeTransaction(s.plan.raw[15]!).txId())!["confirmed-round"] =
    1002;
  assert.equal(
    (await confirmAlgorandManifestOnce(s.plan, "https://rpc.example", read))
      .state,
    "unknown",
  );
});
test("actual HTTP maximum manifests, recovery headers and exact request target are bounded", async () => {
  for (const [profile, jobs] of [
    [ATOMIC, 15],
    [INVOICE, 64],
  ] as [AlgorandManifestProfile, number][]) {
    const s = setup(profile, jobs),
      m = new AlgorandManifestStore(":memory:"),
      f = provider(s.plan.raw.length),
      seller = new AlgorandManifestSeller(
        s.config,
        m,
        f.adapter,
        async () => params,
        () => NOW,
      ),
      server = createServer(
        { maxHeaderSize: 32768 },
        algorandManifestHttpHandler(seller, url),
      );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as any).port;
    const req = (
      headers: any = {},
      path = new URL(url).pathname + new URL(url).search,
      method = "GET",
    ) =>
      new Promise<{ status: number; body: string; headers: any }>(
        (resolve, reject) => {
          const q = httpRequest(
            { host: "127.0.0.1", port, path, method, headers },
            (r) => {
              let body = "";
              r.on("data", (b) => (body += b));
              r.on("end", () =>
                resolve({ status: r.statusCode!, body, headers: r.headers }),
              );
            },
          );
          q.on("error", reject);
          q.end();
        },
      );
    try {
      const quote = await req();
      assert.equal(quote.status, 402);
      assert.equal(quote.body, "");
      assert.equal(
        canonical(
          JSON.parse(
            Buffer.from(quote.headers["payment-required"], "base64").toString(),
          ),
        ),
        canonical(s.envelope),
      );
      const header = encode64(await signAlgorandManifest(s.plan, signer, NOW));
      assert.equal((await req({ "Payment-Signature": header })).status, 200);
      assert.equal(
        (await req({ "Payment-Signature": header, "Replay-Only": "1" })).status,
        400,
      );
      assert.equal((await req({ "Replay-Only": "1" })).status, 503);
      const recovered = await req({
        "Replay-Only": "1",
        "Manifest-Group-Id": s.plan.group.groupId,
        "Manifest-Request-Digest": s.plan.scope,
        "Manifest-Authorization-Digest": digest(
          canonical(JSON.parse(Buffer.from(header, "base64").toString())),
        ),
      });
      assert.equal(recovered.status, 200);
      assert.equal(
        JSON.parse(recovered.body).batch.groupId,
        s.plan.group.groupId,
      );
      assert.equal(
        (await req({ "Payment-Signature": "x".repeat(16385) })).status,
        431,
      );
      assert.equal(
        (await req({ "Payment-Signature": header, "Replay-Only": ["1", "1"] }))
          .status,
        400,
      );
      assert.equal((await req({}, "/wrong")).status, 400);
      assert.equal((await req({}, undefined, "POST")).status, 405);
      assert.equal(f.counts().sends, 1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      m.close();
    }
  }
});

test("oversized eventual credential is refused before wallet signing", () => {
  const s = setup(ATOMIC, 15),
    envelope = structuredClone(s.envelope);
  (envelope.resource as any).description = "x".repeat(4096);
  const raw = buildAlgorandManifestTransactions(
    s.profile,
    envelope,
    s.limits,
    buyer.address,
  );
  assert.throws(
    () => prepareAlgorandManifest({ ...s.plan, envelope, raw }),
    /header_too_large/,
  );
});

test("pre-sign exact signature sizing rejects near-boundary offers the omitted-zero wrapper accepted", () => {
  const s = setup(ATOMIC, 15),
    envelope = structuredClone(s.envelope);
  // This lies between the old zero-signature estimate and the actual signed wire.
  (envelope.resource as any).description = "x".repeat(2300);
  const raw = buildAlgorandManifestTransactions(
    s.profile,
    envelope,
    s.limits,
    buyer.address,
  );
  const size = (fill: number) =>
    encode64({
      x402Version: 2,
      resource: envelope.resource,
      accepted: envelope.accepts[0],
      extensions: envelope.extensions,
      payload: {
        paymentGroup: raw.map((b, i) =>
          Buffer.from(
            i
              ? encodeSignedTransaction({
                  txn: decodeTransaction(b),
                  sig: new Uint8Array(64).fill(fill),
                })
              : b,
          ).toString("base64"),
        ),
        paymentIndex: 1,
      },
    }).length;
  assert(size(0) <= 16384);
  assert(size(1) > 16384);
  assert.throws(
    () => prepareAlgorandManifest({ ...s.plan, envelope, raw }),
    /header_too_large/,
  );
  console.log(
    JSON.stringify({
      oldZeroSignatureEstimate: size(0),
      actualSignedEstimate: size(1),
    }),
  );
});

test("recovery callback never gets payment authority and requires an explicit read-only result", async () => {
  const s = setup(),
    db = new AlgorandManifestStore(":memory:"),
    merchantDb = new AlgorandManifestStore(":memory:"),
    f = provider(4),
    seller = new AlgorandManifestSeller(
      s.config,
      merchantDb,
      f.adapter,
      async () => params,
      () => NOW,
    );
  let signs = 0,
    sends = 0;
  try {
    await seller.challenge(url);
    await executeAlgorandManifest(db, "lost", s.plan, {
      authorize: async () => {},
      readParams: async () => params,
      now: () => NOW,
      sign: async (...args) => {
        signs++;
        return signer(...args);
      },
      send: async (u, p) => {
        sends++;
        await seller.request(u, encode64(p));
        throw Error("lost");
      },
    });
    const ignored = await recoverAlgorandManifest(
      db,
      "lost",
      s.plan,
      async (q) => {
        assert.deepEqual(Object.keys(q).sort(), [
          "authorizationDigest",
          "groupId",
          "recoveryOnly",
          "requestDigest",
          "url",
        ]);
        assert(!JSON.stringify(q).includes("paymentGroup"));
        const out = await seller.recover(q);
        return { status: out.status, body: out.body } as any;
      },
    );
    assert.equal(ignored.status, 503);
    for (const field of ["groupId", "requestDigest", "authorizationDigest"]) {
      assert.equal(
        (
          await recoverAlgorandManifest(db, "lost", s.plan, async (q) =>
            seller.recover({
              ...q,
              [field]:
                field === "groupId"
                  ? Buffer.alloc(32, 1).toString("base64")
                  : "00".repeat(32),
            }),
          )
        ).status,
        503,
      );
    }
    assert.equal(
      (
        await recoverAlgorandManifest(db, "lost", s.plan, (q) =>
          seller.recover(q),
        )
      ).status,
      200,
    );
    assert.equal(signs, 1);
    assert.equal(sends, 1);
    assert.equal(f.counts().sends, 1);
    const changed = structuredClone(s.envelope);
    (changed.resource as any).description =
      "same group different request metadata";
    const alternate = prepareAlgorandManifest({ ...s.plan, envelope: changed });
    assert.equal(alternate.group.groupId, s.plan.group.groupId);
    assert.notEqual(alternate.scope, s.plan.scope);
    await assert.rejects(
      executeAlgorandManifest(db, "lost", alternate, {
        authorize: async () => {},
        readParams: async () => params,
        now: () => NOW,
        sign: signer,
        send: async () => {
          throw Error("no new send");
        },
      }),
    );
  } finally {
    db.close();
    merchantDb.close();
  }
});

test("merchant restart pins immutable buyer limits and recipient before provider or RPC work", () => {
  const dir = mkdtempSync(join(tmpdir(), "manifest-config-")),
    path = join(dir, "merchant.sqlite"),
    s = setup();
  let calls = 0;
  const noCalls = async () => {
    calls++;
    throw Error("no external work");
  };
  const provider = { verify: noCalls, settle: noCalls };
  let db = new AlgorandManifestStore(path);
  try {
    new AlgorandManifestSeller(s.config, db, provider, noCalls, () => NOW);
    db.close();
    db = new AlgorandManifestStore(path);
    assert.doesNotThrow(
      () =>
        new AlgorandManifestSeller(s.config, db, provider, noCalls, () => NOW),
    );
    for (const change of [
      (c: any) => (c.buyer = sponsor.address),
      (c: any) => (c.limits.max_total_amount_atomic = "4000"),
      (c: any) => (c.requirement.payTo = buyer.address),
    ]) {
      const c = structuredClone(s.config);
      change(c);
      const lax = {
        get: db.get.bind(db),
        once: (k: string, v: any) => (db.get(k) ? false : db.once(k, v)),
      };
      assert.throws(
        () => new AlgorandManifestSeller(c, lax, provider, noCalls, () => NOW),
        /manifest_config_conflict/,
      );
      assert.throws(
        () => new AlgorandManifestSeller(c, db, provider, noCalls, () => NOW),
        /manifest_config_conflict|journal_scope_conflict/,
      );
    }
    assert.equal(calls, 0);
    assert.doesNotThrow(
      () =>
        new AlgorandManifestSeller(s.config, db, provider, noCalls, () => NOW),
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
