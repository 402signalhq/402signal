import test, { mock } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { request as httpRequest } from "node:http";
import { Address } from "@algorandfoundation/algokit-utils";
import {
  decodeTransaction,
  encodeSignedTransaction,
  bytesForSigning,
} from "@algorandfoundation/algokit-utils/transact";
import { x402ResourceServer } from "@x402/core/server";
import { ExactAvmScheme as AvmServer } from "@x402/avm/exact/server";
import { ExactAvmScheme as AvmFacilitator } from "@x402/avm/exact/facilitator";
import { Seller } from "../src/seller.js";
import { server as httpServer } from "../src/http-server.js";
import { configuredBatchHttpMerchants } from "../src/batch-http-config.js";
import {
  ALGORAND_MANIFEST_OPT_IN,
  ALGORAND_MANIFEST_PATHS,
} from "../src/algorand-manifest-config.js";
import { AlgorandManifestStore } from "../src/algorand-manifest-store.js";
import {
  buildAlgorandManifestTransactions,
  prepareAlgorandManifest,
  executeAlgorandManifest,
  recoverAlgorandManifest,
} from "../src/algorand-manifest.js";
import { digest, encode64, canonical } from "../src/json.js";
const NOW = 1800000000000,
  network = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
  origin = "https://merchant.example";
function key() {
  const k = generateKeyPairSync("ed25519");
  return {
    ...k,
    address: new Address(
      k.publicKey.export({ format: "der", type: "spki" }).subarray(-32),
    ).toString(),
  };
}
const buyer = key(),
  merchant = key(),
  sponsor = key();
const params = {
  "genesis-hash": network.slice(9),
  "genesis-id": "mainnet-v1.0",
  "last-round": 1000,
  "min-fee": 1000,
  fee: 0,
};
function signed(raw: Uint8Array, k = buyer) {
  const txn = decodeTransaction(raw);
  return encodeSignedTransaction({
    txn,
    sig: nodeSign(null, bytesForSigning.transaction(txn), k.privateKey),
  });
}
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "manifest-registration-"));
  let verifies = 0,
    settles = 0,
    sends = 0;
  const scheme = new AvmFacilitator({
    getAddresses: () => [sponsor.address],
    signTransaction: async (raw: Uint8Array) => signed(raw, sponsor),
    simulateTransactions: async () => ({ txnGroups: [{}] }),
    sendTransactions: async () => {
      sends++;
    },
    waitForConfirmation: async () => ({ confirmedRound: 1001 }),
  } as any);
  const sdk = new x402ResourceServer({
    getSupported: async () => ({
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network,
          extra: { feePayer: sponsor.address },
        },
      ],
      extensions: [],
      signers: {},
    }),
    verify: async (p: any, r: any) => {
      verifies++;
      return scheme.verify(p, r);
    },
    settle: async (p: any, r: any) => {
      settles++;
      return scheme.settle(p, r);
    },
  } as any);
  sdk.register(network, new AvmServer());
  await sdk.initialize();
  const seller = new Seller(
    {
      mode: "mainnet",
      origin,
      host: "127.0.0.1",
      port: 0,
      ledgerPath: join(dir, "lab.sqlite"),
      priceAtomic: "1000",
      rails: {
        algorand: {
          payTo: merchant.address,
          facilitatorUrl: "https://facilitator.example",
        },
        base: { payTo: "", facilitatorUrl: "" },
        solana: { payTo: "", facilitatorUrl: "" },
      },
    },
    { capacity: () => ({ ready: true, remaining: 20 }) } as any,
  );
  seller.ready = true;
  seller.servers.set("algorand", sdk);
  const campaigns = Object.entries(ALGORAND_MANIFEST_PATHS).map(
    ([profile, path], i) => ({
      campaignId: "synthetic-manifest-" + i,
      profile,
      url: origin + path,
      network,
      asset: "31566704",
      recipient: merchant.address,
      buyer: buyer.address,
      feePayer: sponsor.address,
      amountAtomic: i ? "3000" : "1000",
      maxTotalAmountAtomic: "3000",
      maxSponsorFeeMicroAlgo: i ? "2000" : "4000",
      jobHashes: [0, 1, 2].map((x) => digest("job" + x)),
      createdAt: NOW - 1000,
      expiresAt: NOW + 3600000,
    }),
  );
  const config = {
      version: 1,
      algodUrl: "https://rpc.example",
      facilitatorUrl: "https://facilitator.example",
      campaigns,
    },
    file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify(config));
  return {
    dir,
    config,
    file,
    seller,
    sdk,
    env: {
      LAB_ALGORAND_MANIFESTS: ALGORAND_MANIFEST_OPT_IN,
      LAB_ALGORAND_MANIFEST_CONFIG: file,
    },
    counts: () => ({ verifies, settles, sends }),
  };
}
test("Algorand gates default off and config terms/sponsor substitutions refuse before any RPC or payment", async () => {
  const clock = mock.method(Date, "now", () => NOW),
    f = await setup();
  let calls = 0;
  const fetch = mock.method(globalThis, "fetch", async () => {
    calls++;
    throw Error("no network");
  });
  try {
    assert.equal(
      (await configuredBatchHttpMerchants(f.seller, {})).merchants.length,
      0,
    );
    await assert.rejects(
      configuredBatchHttpMerchants(f.seller, {
        ...f.env,
        LAB_ALGORAND_MANIFESTS: "yes",
      }),
    );
    for (const change of [
      (c: any) => (c.facilitatorUrl = "https://other.example"),
      (c: any) => (c.algodUrl = "https://user@rpc.example"),
      (c: any) => (c.campaigns[0].feePayer = buyer.address),
      (c: any) => (c.campaigns[0].recipient = buyer.address),
      (c: any) => (c.campaigns[0].buyer = "invalid"),
      (c: any) => (c.campaigns[0].asset = "1"),
      (c: any) => (c.campaigns[0].network = "testnet"),
      (c: any) => (c.campaigns[0].campaignId = "../escape"),
      (c: any) => (c.campaigns[0].url += "?unbound=1"),
      (c: any) => (c.campaigns[0].amountAtomic = "01"),
      (c: any) => (c.campaigns[0].maxSponsorFeeMicroAlgo = "3999"),
      (c: any) => (c.campaigns[0].expiresAt = NOW + 86400000),
      (c: any) => (c.campaigns[1].campaignId = c.campaigns[0].campaignId),
      (c: any) => (c.campaigns[0].extra = true),
    ]) {
      const c = structuredClone(f.config);
      change(c);
      writeFileSync(f.file, JSON.stringify(c));
      await assert.rejects(configuredBatchHttpMerchants(f.seller, f.env));
    }
    writeFileSync(f.file, JSON.stringify(f.config));
    const original = f.sdk.buildPaymentRequirements.bind(f.sdk),
      bad = mock.method(
        f.sdk,
        "buildPaymentRequirements",
        async (input: any) => {
          const r = await original(input);
          return r.map((x) => ({ ...x, amount: "999" }));
        },
      );
    await assert.rejects(
      configuredBatchHttpMerchants(f.seller, f.env),
      /requirement_refused/,
    );
    bad.mock.restore();
    assert.equal(calls, 0);
    assert.deepEqual(f.counts(), { verifies: 0, settles: 0, sends: 0 });
    assert(!existsSync(join(f.dir, "algorand-manifests")));
  } finally {
    fetch.mock.restore();
    clock.mock.restore();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
test("Algorand config rejects duplicate fields oversized files and symlinks", async () => {
  const clock = mock.method(Date, "now", () => NOW),
    f = await setup();
  try {
    for (const raw of ['{"version":1,"version":1}', " ".repeat(16385)]) {
      writeFileSync(f.file, raw);
      await assert.rejects(configuredBatchHttpMerchants(f.seller, f.env));
    }
    writeFileSync(f.file, JSON.stringify(f.config));
    const link = join(f.dir, "link.json");
    symlinkSync(f.file, link);
    await assert.rejects(
      configuredBatchHttpMerchants(f.seller, {
        ...f.env,
        LAB_ALGORAND_MANIFEST_CONFIG: link,
      }),
    );
  } finally {
    clock.mock.restore();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
test("registered HTTP group and invoice use actual initialized SDK once and recover without credentials after restart/expiry", async () => {
  let now = NOW,
    reads = 0;
  const clock = mock.method(Date, "now", () => now),
    f = await setup(),
    fetch = mock.method(globalThis, "fetch", async (url: any, opt: any) => {
      reads++;
      assert.equal(url, "https://rpc.example/v2/transactions/params");
      assert.equal(opt.method, "GET");
      assert.equal(opt.body, undefined);
      assert.equal(opt.redirect, "error");
      return Response.json(params);
    });
  let loaded = await configuredBatchHttpMerchants(f.seller, f.env),
    app = httpServer(f.seller, undefined, loaded.merchants);
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const req = (path: string, headers: any = {}, method = "GET") =>
    new Promise<any>((resolve, reject) => {
      const q = httpRequest(
        {
          host: "127.0.0.1",
          port: (app.address() as any).port,
          path,
          headers,
          method,
        },
        (r) => {
          let b = "";
          r.on("data", (x) => (b += x));
          r.on("end", () =>
            resolve({
              status: r.statusCode,
              headers: r.headers,
              raw: b,
              body: b ? JSON.parse(b) : null,
            }),
          );
        },
      );
      q.on("error", reject);
      q.end();
    });
  const plans: any[] = [],
    journals: AlgorandManifestStore[] = [];
  let signs = 0,
    ordinary = 0;
  try {
    assert.equal(reads, 0);
    assert.equal((await req("/ready")).status, 200);
    assert.deepEqual(
      loaded.merchants.map((m) => m.path),
      Object.values(ALGORAND_MANIFEST_PATHS),
    );
    for (const [i, c] of f.config.campaigns.entries()) {
      const path = new URL(c.url).pathname,
        quote = await req(path);
      assert.equal(quote.status, 402);
      assert.equal(quote.raw, "");
      const envelope = JSON.parse(
          Buffer.from(quote.headers["payment-required"], "base64").toString(),
        ),
        manifest = envelope.extensions["402signal-atomic-batch"];
      assert.equal(
        manifest.feeQuote.expiresAt - manifest.feeQuote.observedAt,
        45,
      );
      const limits = {
        network,
        asset: "31566704",
        recipient: merchant.address,
        fee_payer: sponsor.address,
        max_total_amount_atomic: c.maxTotalAmountAtomic,
        max_sponsor_fee_micro_algo: c.maxSponsorFeeMicroAlgo,
        job_hashes: c.jobHashes,
        ...(i ? {} : { max_item_amount_atomic: c.amountAtomic }),
      };
      const plan = prepareAlgorandManifest({
          profile: c.profile as any,
          envelope,
          limits,
          buyer: buyer.address,
          raw: buildAlgorandManifestTransactions(
            c.profile as any,
            envelope,
            limits,
            buyer.address,
          ),
        }),
        journal = new AlgorandManifestStore(
          join(f.dir, "buyer-" + i + ".sqlite"),
        );
      plans.push(plan);
      journals.push(journal);
      const out = await executeAlgorandManifest(journal, "http", plan, {
        authorize: async () => {},
        readParams: async () => params,
        now: () => Math.floor(now / 1000),
        sign: async (raw, indexes) => {
          signs++;
          return raw.map((b, j) =>
            indexes.includes(j) ? signed(b) : undefined,
          );
        },
        send: async (u, p) => {
          ordinary++;
          const result = await req(new URL(u).pathname, {
            "Payment-Signature": encode64(p),
          });
          assert.equal(result.status, 200);
          assert.equal(result.body.batch.jobCount, 3);
          assert.equal(result.body.batch.paymentCount, i ? 1 : 3);
          throw Error("lost merchant HTTP acknowledgment");
        },
      });
      assert.equal(out.status, 503);
    }
    assert.deepEqual(f.counts(), { verifies: 2, settles: 2, sends: 2 });
    assert.equal(signs, 2);
    assert.equal(ordinary, 2);
    const before = reads;
    app.closeAllConnections();
    await new Promise<void>((resolve) => app.close(() => resolve()));
    await loaded.close();
    now += 7200000;
    loaded = await configuredBatchHttpMerchants(f.seller, f.env);
    app = httpServer(f.seller, undefined, loaded.merchants);
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    for (const [i, plan] of plans.entries()) {
      assert.equal(
        (await req(new URL(plan.envelope.resource.url).pathname)).status,
        503,
      );
      const out = await recoverAlgorandManifest(
        journals[i]!,
        "http",
        plan,
        async (q) => {
          assert.deepEqual(Object.keys(q).sort(), [
            "authorizationDigest",
            "groupId",
            "recoveryOnly",
            "requestDigest",
            "url",
          ]);
          const result = await req(new URL(q.url).pathname, {
            "Replay-Only": "1",
            "Manifest-Group-Id": q.groupId,
            "Manifest-Request-Digest": q.requestDigest,
            "Manifest-Authorization-Digest": q.authorizationDigest,
          });
          assert.equal(result.headers["replay-only"], "1");
          return {
            status: result.status,
            body: result.body,
            recoveryOnly: true as const,
          };
        },
      );
      assert.equal(out.status, 200);
      const path = new URL(plan.envelope.resource.url).pathname;
      assert.equal(
        (
          await req(path, {
            "Replay-Only": "1",
            "Payment-Signature": "executable",
          })
        ).status,
        400,
      );
      assert.equal((await req(path, { "Replay-Only": "1" })).status, 503);
      assert.equal((await req(path, {}, "POST")).status, 405);
    }
    assert.equal(reads, before);
    assert.deepEqual(f.counts(), { verifies: 2, settles: 2, sends: 2 });
    assert.equal(signs, 2);
    assert.equal(ordinary, 2);
    await loaded.close();
    const changed = structuredClone(f.config);
    changed.campaigns[0]!.expiresAt += 1000;
    writeFileSync(f.file, JSON.stringify(changed));
    await assert.rejects(
      configuredBatchHttpMerchants(f.seller, f.env),
      /journal_scope_conflict/,
    );
    loaded = { merchants: [], close: async () => {} };
  } finally {
    journals.forEach((j) => j.close());
    app.closeAllConnections();
    await new Promise<void>((resolve) => app.close(() => resolve()));
    await loaded.close();
    fetch.mock.restore();
    clock.mock.restore();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
