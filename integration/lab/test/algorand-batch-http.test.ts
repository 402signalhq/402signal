import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Address } from "@algorandfoundation/algokit-utils";
import {
  decodeTransaction,
  encodeSignedTransaction,
  bytesForSigning,
} from "@algorandfoundation/algokit-utils/transact";
import { server } from "../src/http-server.js";
import { Ledger } from "../src/ledger.js";
import type { Seller } from "../src/seller.js";
import { AlgorandBatchSeller } from "../src/algorand-batch-seller.js";
import {
  configuredAlgorandBatchSeller,
  ALGORAND_BATCH_OPT_IN,
} from "../src/algorand-batch-config.js";
import {
  algorandBatchManifest,
  prepareAlgorandBatch,
  buildAlgorandBatchTransactions,
  signAlgorandBatch,
} from "../src/algorand-batch.js";
import { railInfo } from "../src/config.js";
import { encode64 } from "../src/json.js";
const origin = "https://batch.example",
  path = "/algorand/batch/sha256?left=alpha&right=beta",
  url = origin + path;
const key = generateKeyPairSync("ed25519"),
  buyer = new Address(
    key.publicKey.export({ type: "spki", format: "der" }).subarray(-32),
  ).toString();
const addr = (n: number) => new Address(new Uint8Array(32).fill(n)).toString(),
  info = railInfo("algorand", "mainnet");
const req = {
  scheme: "exact",
  network: info.network,
  asset: info.asset,
  amount: "1000",
  payTo: addr(10),
  maxTimeoutSeconds: 60,
  extra: { feePayer: addr(3) },
};
async function header() {
  const plan = prepareAlgorandBatch({
    url,
    origin,
    requirement: req,
    buyer,
    raw: buildAlgorandBatchTransactions(req, buyer, 1000n, 1100n),
    maxSpendAtomic: "2000",
    manifest: algorandBatchManifest(url, origin, req),
  });
  const p = await signAlgorandBatch(plan, async (raw, indexes) =>
    raw.map((b, i) => {
      if (!indexes.includes(i)) return undefined;
      const txn = decodeTransaction(b);
      return encodeSignedTransaction({
        txn,
        sig: sign(null, bytesForSigning.transaction(txn), key.privateKey),
      });
    }),
  );
  return { value: encode64(p), plan };
}
const close = async (app: ReturnType<typeof server>) =>
  new Promise<void>((resolve) => {
    app.close(() => resolve());
    app.closeAllConnections();
  });
async function start(ledger: Ledger, enabled: boolean, provider: any) {
  const seller = {
    config: { origin, mode: "mainnet", priceAtomic: "1000" },
    ready: true,
    ledger,
  } as Seller;
  const app = server(
    seller,
    enabled
      ? new AlgorandBatchSeller(origin, req, ledger, provider)
      : undefined,
  );
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  return { app, port: (app.address() as any).port };
}
function get(
  port: number,
  headers: string[] = [],
  method = "GET",
  body?: string,
  p = path,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const r = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: p,
        method,
        headers: ["Host", "127.0.0.1", ...headers],
      },
      (res) => {
        let s = "";
        res.on("data", (b) => (s += b));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode!, body: s ? JSON.parse(s) : {} });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    r.on("error", reject);
    r.setTimeout(3000, () => r.destroy(new Error("test request deadline")));
    r.end(body);
  });
}
test("HTTP endpoint defaults off and invalid opt-in configuration refuses startup", async () => {
  const ledger = new Ledger(":memory:"),
    instance = await start(ledger, false, {});
  try {
    assert.equal((await get(instance.port)).status, 404);
    assert.equal(configuredAlgorandBatchSeller({} as Seller, {}), undefined);
    assert.throws(() =>
      configuredAlgorandBatchSeller({} as Seller, {
        LAB_ALGORAND_ATOMIC_BATCH: "true",
      }),
    );
    assert.throws(() =>
      configuredAlgorandBatchSeller(
        { ready: true, config: { mode: "offline" } } as Seller,
        { LAB_ALGORAND_ATOMIC_BATCH: ALGORAND_BATCH_OPT_IN },
      ),
    );
  } finally {
    await close(instance.app);
    ledger.close();
  }
});
test("HTTP unsigned, malformed headers, methods and bodies never verify or reserve", async () => {
  const ledger = new Ledger(":memory:");
  let verifies = 0,
    settles = 0;
  const instance = await start(ledger, true, {
    verify: async () => {
      verifies++;
    },
    settle: async () => {
      settles++;
    },
  });
  try {
    assert.equal((await get(instance.port, ["Replay-Only", "1"])).status, 503);
    const signed = await header();
    assert.equal(
      (
        await get(instance.port, [
          "Replay-Only",
          "1",
          "Payment-Signature",
          signed.value,
        ])
      ).status,
      503,
    );
    const unsigned = await get(instance.port);
    assert.equal(unsigned.status, 402);
    assert.equal(
      unsigned.body.extensions["402signal-atomic-batch"].totalAmount,
      "2000",
    );
    const bad = [
      get(instance.port, ["Payment-Signature", "a", "Payment-Signature", "b"]),
      get(instance.port, ["X-Payment", "a"]),
      get(instance.port, ["X-Payment-Signature", "a"]),
      get(instance.port, ["Payment-Payload", "a"]),
      get(instance.port, [], "POST"),
      get(instance.port, ["Content-Length", "2"], "GET", "{}"),
      get(instance.port, [], "GET", undefined, path + "&left=duplicate"),
      get(instance.port, [], "GET", undefined, path.replaceAll("alpha", "%FF")),
    ];
    for (const result of await Promise.all(bad))
      assert.ok(result.status >= 400);
    assert.equal(verifies, 0);
    assert.equal(settles, 0);
    assert.equal(
      (ledger.db.prepare("SELECT count(*) AS n FROM payments").get() as any).n,
      0,
    );
  } finally {
    await close(instance.app);
    ledger.close();
  }
});
test("full HTTP group is settled once under concurrency; cache survives merchant restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "avm-http-")),
    file = join(dir, "merchant.sqlite");
  let ledger = new Ledger(file),
    verifies = 0,
    settles = 0;
  const signed = await header();
  const provider = {
    verify: async () => {
      verifies++;
      await new Promise((r) => setTimeout(r, 10));
      return { isValid: true };
    },
    settle: async () => {
      settles++;
      return {
        success: true,
        transaction: signed.plan.group.transfers[0]!.transaction,
        network: req.network,
      };
    },
  };
  let instance = await start(ledger, true, provider);
  try {
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        get(instance.port, ["Payment-Signature", signed.value]),
      ),
    );
    const success = results.find((r) => r.status === 200)!;
    assert.ok(success);
    assert.equal(success.body.batch.items.length, 2);
    assert.equal(settles, 1);
    assert.equal(verifies, 1);
    assert.ok(results.every((r) => [200, 409, 429].includes(r.status)));
    await close(instance.app);
    ledger.close();
    ledger = new Ledger(file);
    instance = await start(ledger, true, provider);
    assert.deepEqual(
      await get(instance.port, [
        "Payment-Signature",
        signed.value,
        "Replay-Only",
        "1",
      ]),
      success,
    );
    assert.equal(settles, 1);
    assert.equal(verifies, 1);
  } finally {
    await close(instance.app);
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
