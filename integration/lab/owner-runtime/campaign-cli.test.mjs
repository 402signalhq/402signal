import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { main, requiredSources, runCampaign } from "./campaign-cli.mjs";
import { LocalBatchLedger } from "./local-ledger.mjs";
import {
  setup,
  payer,
  operator,
  args,
} from "../solana-session-contracts/test/campaign-cli-support.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(
  new URL("../../reference-buyer/package.json", import.meta.url),
);
const { privateKeyToAccount } = await import(
  pathToFileURL(require.resolve("viem/accounts"))
);
const { encodeAbiParameters, encodeEventTopics, parseAbi } = await import(
  pathToFileURL(require.resolve("viem"))
);
import {
  plan as basePlan,
  chain as baseChain,
  wallet as baseWallet,
} from "./campaign-cli-base-support.mjs";
const fixture = JSON.parse(
  readFileSync(new URL("./campaign-cli-fixture.json", import.meta.url)),
);
const realNow = Date.now;
let clock = fixture.now * 1000;
Date.now = () => clock;
test.after(() => (Date.now = realNow));
const SHA = (x) => createHash("sha256").update(x).digest("hex");
const b64 = (x) => Buffer.from(JSON.stringify(x)).toString("base64");
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo = "0x2222222222222222222222222222222222222222",
  tx = "0x" + "a".repeat(64);
const abi = parseAbi([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)",
]);
async function scenario(options = {}) {
  clock = fixture.now * 1000;
  const s = await setup(fixture.challenge.wwwAuthenticate),
    directory = join(s.dir, "cli-private");
  const owner = privateKeyToAccount("0x" + "01".repeat(32));
  let intent,
    routeSigns = 0,
    paid = 0,
    recoveries = 0,
    merchantCalls = 0,
    nativeSigns = 0;
  const q = {
    x402Version: 2,
    resource: {
      url: "https://402signal.com/route",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        asset: USDC,
        amount: "3000",
        payTo,
        maxTimeoutSeconds: 60,
        extra: { name: "USD Coin", version: "2" },
      },
    ],
  };
  const selected = options.finality
    ? fixture.baseFinality[0]
    : options.base
      ? JSON.parse(
          readFileSync(join(root, "tests/fixtures/batch-route-v5.json")),
        )[0]
      : fixture;
  let result = structuredClone(selected.response);
  const feeTransactions = new Map(),
    feeAuthorizations = new Map();
  result.billing = fixture.response.billing;
  if (options.badProof) result.batch_terms.session_cap_atomic = "999999";
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    assert.equal(req.method, "POST");
    const auth = req.headers["payment-signature"];
    if (raw === "{}") {
      assert.equal(req.headers["replay-only"], "1");
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "recovery_unavailable",
          recovery_only: true,
          new_payment_allowed: false,
        }),
      );
      return;
    }
    assert.deepEqual(JSON.parse(raw), selected.request);
    if (!auth) {
      res.writeHead(402, { "PAYMENT-REQUIRED": b64(q) });
      res.end(JSON.stringify(q));
      return;
    }
    const actual = JSON.parse(Buffer.from(auth, "base64"));
    assert.equal(actual.payload.authorization.value, "3000");
    const nonce = actual.payload.authorization.nonce;
    if (!feeAuthorizations.has(nonce))
      feeAuthorizations.set(nonce, feeAuthorizations.size + 1);
    const ordinal = feeAuthorizations.get(nonce),
      feeTx = "0x" + SHA(nonce);
    feeTransactions.set(feeTx, actual.payload.authorization);
    if (req.headers["replay-only"] === "1") recoveries++;
    else paid++;
    if (options.finality && ordinal === 2) {
      result = structuredClone(fixture.baseFinality[1].response);
      if (options.badSecondProof)
        result.batch_terms.call_amount_atomic = "9999";
    }
    res.writeHead(200, {
      "PAYMENT-RESPONSE": b64({
        success: true,
        network: "eip155:8453",
        transaction: feeTx,
        payer: owner.address,
      }),
    });
    res.end(JSON.stringify(result));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const target = "http://127.0.0.1:" + server.address().port;
  const bp = basePlan();
  if (options.emptyDeposit) bp.depositAtomic = "3000";
  const bc = baseChain(bp);
  let finalizedHeld = options.finality === true;
  let secondRecoveryUnavailable = options.secondRecoveryUnavailable;
  let recoveryFault = options.recoveryFault,
    merchantOrdinary = 0,
    merchantRecovery = 0;
  const cached = new Map(),
    savedAuth = new Map();
  let providerCalls = 0,
    providerVerify = 0,
    baseSigns = 0;
  const runtime = {
    routeAccount: {
      address: owner.address,
      signTypedData: async (d) => {
        routeSigns++;
        intent = { ...d.message };
        return owner.signTypedData(d);
      },
    },
    nativeBuyer: {
      address: payer.address,
      signTransactions: async (...a) => {
        nativeSigns++;
        return payer.signTransactions(...a);
      },
      signMessages: async (...a) => {
        nativeSigns++;
        return payer.signMessages(...a);
      },
    },
    nativeOperator: operator,
    baseRpc: async (method, params) => {
      if (method === "eth_chainId") return "0x2105";
      if (method === "eth_call") return "0xf4240";
      if (method === "eth_blockNumber") return "0x101";
      if (method === "eth_getBlockByNumber") return { hash: "0xblock" };
      const currentIntent = feeTransactions.get(params[0]);
      const transaction = {
        hash: params[0],
        blockHash: "0xblock",
        blockNumber: "0x100",
        from: "0x" + "3".repeat(40),
      };
      if (method === "eth_getTransactionByHash") return transaction;
      if (method === "eth_getTransactionReceipt")
        return {
          ...transaction,
          transactionHash: params[0],
          status: "0x1",
          logs: [
            {
              address: USDC,
              data: encodeAbiParameters(
                [{ type: "uint256" }],
                [BigInt(currentIntent.value)],
              ),
              topics: encodeEventTopics({
                abi,
                eventName: "Transfer",
                args: { from: currentIntent.from, to: currentIntent.to },
              }),
            },
            {
              address: USDC,
              data: "0x",
              topics: encodeEventTopics({
                abi,
                eventName: "AuthorizationUsed",
                args: {
                  authorizer: currentIntent.from,
                  nonce: currentIntent.nonce,
                },
              }),
            },
          ],
        };
      throw Error("unexpected synthetic RPC");
    },
    solanaRpc: async (method, params) => {
      if (method === "sendTransaction") {
        const l = new LocalBatchLedger(
          join(directory, "batch"),
          "native-cli-test",
        );
        try {
          const closing = await l.get("close:credential");
          if (closing) s.setClosing(closing);
        } finally {
          l.close();
        }
      }
      const result = await s.rpc(method, params);
      if (
        options.lostOpen &&
        method === "sendTransaction" &&
        !(await (async () => {
          const l = new LocalBatchLedger(
            join(directory, "batch"),
            "native-cli-test",
          );
          try {
            return await l.get("close:credential");
          } finally {
            l.close();
          }
        })())
      )
        throw Error("lost open ack");
      return result;
    },
    baseOwner: {
      address: baseWallet.address,
      signTypedData: async (d) => {
        baseSigns++;
        const signature = await baseWallet.signTypedData(d);
        if (options.slowSecondVoucher && baseSigns === 3) clock += 61000;
        return signature;
      },
    },
    cdpAuthorization: async () => ({ Authorization: "Bearer synthetic-only" }),
    fetch: async (url, init) => {
      assert.equal(init.redirect, "error");
      assert.equal(init.credentials, "omit");
      if (url === "https://402signal.com/route") {
        if (
          secondRecoveryUnavailable &&
          paid === 2 &&
          init.headers["Replay-Only"] === "1"
        )
          return new Response(
            JSON.stringify({
              error: "recovery_unavailable",
              recovery_only: true,
              new_payment_allowed: false,
            }),
            { status: 503 },
          );
        const fetched = await fetch(target, init);
        const response = new Response(await fetched.text(), {
          status: fetched.status,
          headers: fetched.headers,
        });
        if (
          (options.lostRoute || (options.lostSecondRoute && paid === 2)) &&
          init.headers["PAYMENT-SIGNATURE"] &&
          !init.headers["Replay-Only"]
        )
          throw Error("synthetic lost response");
        return response;
      }
      if (
        options.base &&
        url.startsWith("https://api.cdp.coinbase.com/platform/v2/x402/")
      ) {
        assert.equal(init.headers.Authorization, "Bearer synthetic-only");
        if (url.endsWith("/supported"))
          return new Response(
            JSON.stringify({
              kinds: [
                {
                  x402Version: 2,
                  network: "eip155:8453",
                  scheme: "batch-settlement",
                },
              ],
            }),
          );
        const body = JSON.parse(init.body);
        if (url.endsWith("/verify")) {
          providerVerify++;
          return new Response(JSON.stringify({ isValid: true }));
        }
        providerCalls++;
        return new Response(
          JSON.stringify({
            success: true,
            network: "eip155:8453",
            transaction: bc.append(body.paymentPayload.payload),
          }),
        );
      }
      const recovery = init.headers["Replay-Only"] === "1";
      if (recovery) merchantRecovery++;
      else merchantOrdinary++;
      merchantCalls++;
      const value =
        init.headers[options.base ? "PAYMENT-SIGNATURE" : "Authorization"];
      const credential = options.base
        ? JSON.parse(Buffer.from(value, "base64"))
        : JSON.parse(Buffer.from(value.slice(8), "base64url"));
      const kind = options.base ? "voucher" : credential.payload.action;
      const cumulative =
        credential.payload.voucher?.maxClaimableAmount ??
        credential.payload.voucher?.data?.cumulativeAmount;
      const key = kind + ":" + (cumulative ?? "open");
      if (!recovery) savedAuth.set(key, value);
      else
        assert.equal(
          value,
          savedAuth.get(key),
          "recovery must retain exact original credential",
        );
      let response;
      if (options.base) {
        assert.equal(url, bp.resource);
        if (recovery)
          response = cached.has(key)
            ? new Response(cached.get(key))
            : new Response("{}", { status: 503 });
        else {
          const body = JSON.stringify({
            channelId: credential.payload.voucher.channelId,
            billing: {
              settled: false,
              settlement_state: "voucher_accepted",
              chargedAmount: "1000",
              chargedCumulativeAmount: cumulative,
            },
          });
          cached.set(key, body);
          response = new Response(body);
        }
      } else {
        assert.equal(url, s.url);
        const fetched = await fetch(s.target, init);
        response = new Response(await fetched.text(), {
          status: fetched.status,
          headers: fetched.headers,
        });
      }
      if (recovery && recoveryFault === "miss")
        return new Response("{}", { status: 503 });
      if (recovery && recoveryFault === "lost")
        throw Error("synthetic lost recovery response");
      if (recovery && recoveryFault === "accounting") {
        const body = JSON.parse(await response.text());
        if (options.base) body.billing.chargedAmount = "9999";
        else body.chargedCumulativeAmount = "9999";
        return new Response(JSON.stringify(body));
      }
      if (recovery && recoveryFault === "mismatch") {
        const body = JSON.parse(await response.text());
        if (options.base) body.billing.chargedCumulativeAmount = "9999";
        else body.reference += ":wrong";
        return new Response(JSON.stringify(body));
      }
      if (
        !recovery &&
        ((options.lostDelivery &&
          kind === "voucher" &&
          cumulative === String(options.lostDelivery * 1000)) ||
          (options.lostRegister && kind === "open"))
      )
        throw Error("synthetic lost merchant acknowledgement");
      return response;
    },
  };
  const factory = join(s.dir, "factory.mjs"),
    key = randomUUID();
  globalThis.__ownerCliTests ??= new Map();
  globalThis.__ownerCliTests.set(key, runtime);
  writeFileSync(
    factory,
    `export const createRuntime=async()=>globalThis.__ownerCliTests.get(${JSON.stringify(key)});`,
    { mode: 0o600 },
  );
  const config = {
    version: 1,
    campaignId: "native-cli-test",
    profile: "solana-mpp-session-v1",
    directory,
    expiresAt: clock + 60000,
    maxCalls: 2,
    url: s.url,
    router: {
      url: "https://402signal.com/route",
      rpcUrl: "https://rpc.example/",
      buyerAddress: owner.address,
      payTo,
      feeAtomic: "3000",
      recoveryProfile: "http-route-v1",
    },
    trustedLogVkey: fixture.trusted_vkey,
    buyerLimits: fixture.request.buyer_limits,
    depositAtomic: "4000",
    perCallAtomic: "1000",
    nativePolicy: args().policy,
    budget: { maximumUSDCAtomic: "7000", maximumOperatorLamports: "5010000" },
    maximumCloseFeeLamports: "10000",
    sourceCommit: "a".repeat(40),
    sources: Object.fromEntries(
      requiredSources.map((p) => [p, SHA(readFileSync(join(root, p)))]),
    ),
    factorySha256: SHA(readFileSync(factory)),
  };
  if (options.base) {
    Object.assign(config, {
      profile: "base-x402-batch-v1",
      url: bp.resource,
      buyerLimits: selected.request.buyer_limits,
      trustedLogVkey: selected.trusted_vkey,
      basePlan: { ...bp, maxCalls: 3, expiresAt: config.expiresAt },
      depositAtomic: bp.depositAtomic,
      maxCalls: 3,
      maximumCloseFeeLamports: "0",
      budget: { maximumUSDCAtomic: "7000", maximumOperatorLamports: "0" },
    });
    delete config.nativePolicy;
    const feeRpc = runtime.baseRpc;
    runtime.baseRpc = (method, params) => {
      const isFee =
        method === "eth_blockNumber" ||
        (method === "eth_call" &&
          params[0]?.to?.toLowerCase() === USDC.toLowerCase()) ||
        (["eth_getTransactionReceipt", "eth_getTransactionByHash"].includes(
          method,
        ) &&
          feeTransactions.has(params[0])) ||
        (method === "eth_getBlockByNumber" && params[0] === "0x100");
      if (
        options.finality &&
        finalizedHeld &&
        method === "eth_getBlockByNumber" &&
        params[0] === "finalized"
      )
        return {
          number: "0x64",
          hash: "0x" + (1100).toString(16).padStart(64, "0"),
        };
      return isFee ? feeRpc(method, params) : bc.rpc(method, params);
    };
  }
  if (options.finality) {
    config.maxRouteObservations = 2;
    config.maxCalls = 2;
    config.basePlan.maxCalls = 2;
    config.expiresAt = clock + 3600000;
    config.basePlan.expiresAt = config.expiresAt;
    config.budget.maximumUSDCAtomic = "10000";
  }
  const configPath = join(s.dir, "config.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const env = { BATCH_OWNER_ACK: "reviewed-once-no-retry" };
  return {
    s,
    config,
    configPath,
    factory,
    env,
    run: (stage) => main([stage, configPath, factory], env),
    setSecondRecoveryUnavailable: (v) => {
      secondRecoveryUnavailable = v;
    },
    releaseFinality: () => {
      finalizedHeld = false;
    },
    setRecoveryFault: (value) => {
      recoveryFault = value;
    },
    counts: () => ({
      merchantOrdinary,
      merchantRecovery,
      routeSigns,
      routeAuthorizations: feeAuthorizations.size,
      paid,
      recoveries,
      merchantCalls,
      nativeSigns,
      providerCalls,
      providerVerify,
      baseSigns,
      ...s.counts(),
    }),
    close: async () => {
      globalThis.__ownerCliTests.delete(key);
      await new Promise((r) => server.close(r));
      await s.close();
    },
  };
}
test("actual CLI arguments: route SDK/signature, independent receipt, original v5 guard, owner open, two vouchers, cooperative refund and readonly recovery", async () => {
  const s = await scenario({ lostRoute: true });
  try {
    assert.equal((await s.run("plan")).paidActions, 0);
    assert.equal(s.counts().routeSigns, 0);
    assert.equal(
      (await s.run("route")).state,
      "routing_confirmed_and_verified",
    );
    await assert.rejects(s.run("route"), /route_already_attempted/);
    assert.equal((await s.run("preflight")).state, "ready");
    assert.equal(s.counts().nativeSigns, 0);
    assert.equal((await s.run("open")).state, "provider_ack");
    assert.equal((await s.run("confirm-open")).state, "chain_confirmed");
    await s.run("register");
    assert.equal((await s.run("deliver-1")).state, "voucher_accepted");
    assert.equal((await s.run("deliver-2")).state, "voucher_accepted");
    await assert.rejects(s.run("deliver-2"));
    assert.equal((await s.run("close")).state, "provider_ack");
    assert.equal((await s.run("confirm-close")).state, "chain_confirmed");
    const before = s.counts();
    assert.equal((await s.run("status")).state, "closed");
    await s.run("confirm-close");
    assert.equal(s.counts().routeSigns, before.routeSigns);
    assert.equal(s.counts().openCalls, 1);
    assert.equal(s.counts().closeCalls, 1);
    assert.equal(s.counts().paid, 1);
    assert.equal(s.counts().recoveries, 1);
    assert.equal(s.counts().merchantCalls, 3);
  } finally {
    await s.close();
  }
});
test("changed proof cannot reach merchant owner signing; route fee is not retried", async () => {
  const s = await scenario({ badProof: true });
  try {
    await assert.rejects(s.run("route"));
    await assert.rejects(s.run("open"));
    assert.equal(s.counts().nativeSigns, 0);
    assert.equal(s.counts().paid, 1);
    assert.equal(s.counts().merchantCalls, 0);
  } finally {
    await s.close();
  }
});
test("original proof expiry blocks new open even with later campaign cap; no renewal on restart", async () => {
  const s = await scenario();
  try {
    await s.run("route");
    await s.run("preflight");
    clock += 41000;
    await assert.rejects(s.run("open"));
    assert.equal(s.counts().nativeSigns, 0);
    assert.equal(s.counts().openCalls, 0);
  } finally {
    await s.close();
  }
});
test("configuration budget/source changes fail before signer import and preserve journal", async () => {
  const s = await scenario();
  try {
    await s.run("route");
    const changed = {
      ...s.config,
      budget: { ...s.config.budget, maximumUSDCAtomic: "8000" },
    };
    await assert.rejects(
      runCampaign({
        stage: "open",
        config: changed,
        factoryPath: s.factory,
        env: s.env,
      }),
      /immutable campaign conflict/,
    );
    const sourceChanged = structuredClone(s.config);
    sourceChanged.sources[requiredSources[0]] = "0".repeat(64);
    await assert.rejects(
      runCampaign({ stage: "plan", config: sourceChanged }),
      /source_pin_changed/,
    );
    assert.equal(s.counts().nativeSigns, 0);
  } finally {
    await s.close();
  }
});
test("funded but unregistered campaign closes full deposit with no payable voucher, after offer expiry", async () => {
  const s = await scenario();
  try {
    await s.run("route");
    await s.run("open");
    await s.run("confirm-open");
    clock += 65000;
    await s.run("refund-unused");
    assert.equal((await s.run("confirm-close")).state, "chain_confirmed");
    assert.equal(s.counts().nativeSigns, 1);
    assert.equal(s.counts().merchantCalls, 0);
    assert.equal(s.counts().closeCalls, 1);
  } finally {
    await s.close();
  }
});
test("command process prints no operator exception details", async () => {
  const s = await scenario();
  try {
    const secret = "synthetic-private-factory-exception";
    writeFileSync(s.factory, `throw Error(${JSON.stringify(secret)});`);
    s.config.factorySha256 = SHA(readFileSync(s.factory));
    writeFileSync(s.configPath, JSON.stringify(s.config));
    const result = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        new URL("./campaign-cli.mjs", import.meta.url).pathname,
        "preflight",
        s.configPath,
        s.factory,
      ],
      { env: { ...process.env, ...s.env }, encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stderr.includes(secret), false);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).newPaymentAllowed, false);
  } finally {
    await s.close();
  }
});

test("lost native broadcast acknowledgement retains signed identity; readonly confirmation recovers without a second signing or send", async () => {
  const s = await scenario({ lostOpen: true });
  try {
    await s.run("route");
    assert.equal((await s.run("open")).state, "unknown");
    await assert.rejects(s.run("open"));
    assert.equal((await s.run("confirm-open")).state, "chain_confirmed");
    assert.equal(s.counts().openCalls, 1);
    assert.equal(s.counts().nativeSigns, 1);
    await s.run("refund-unused");
    await s.run("confirm-close");
  } finally {
    await s.close();
  }
});
test("Base CLI actual pinned SDK deposit, three cumulative deliveries, claim, payout and remainder refund across fresh command instances", async () => {
  const s = await scenario({ base: true });
  try {
    await s.run("route");
    await s.run("preflight");
    await s.run("deposit");
    assert.equal((await s.run("confirm-deposit")).state, "chain_confirmed");
    for (let n = 1; n <= 3; n++)
      assert.equal((await s.run("deliver-" + n)).state, "voucher_accepted");
    await s.run("close");
    for (const stage of ["claim", "settle", "refund"]) {
      await s.run(stage);
      assert.equal((await s.run("confirm-" + stage)).state, "chain_confirmed");
    }
    assert.equal((await s.run("status")).state, "closed");
    assert.equal(s.counts().providerCalls, 4);
    assert.equal(s.counts().providerVerify, 1);
    assert.equal(s.counts().baseSigns, 4);
    assert.equal(s.counts().paid, 1);
    await assert.rejects(s.run("refund"));
    assert.equal(s.counts().providerCalls, 4);
  } finally {
    await s.close();
  }
});

test("two concurrent explicit opens consume only one durable signing and broadcast permit", async () => {
  const s = await scenario();
  try {
    await s.run("route");
    const outcomes = await Promise.allSettled([s.run("open"), s.run("open")]);
    assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(s.counts().nativeSigns, 1);
    assert.equal(s.counts().openCalls, 1);
    await s.run("confirm-open");
    await s.run("refund-unused");
    await s.run("confirm-close");
  } finally {
    await s.close();
  }
});
test("expired router evidence still supports independent readonly fee confirmation without another HTTP payment", async () => {
  const s = await scenario();
  try {
    await s.run("route");
    clock += 121000;
    assert.equal(
      (await s.run("confirm-route")).state,
      "routing_confirmed_observation_unusable",
    );
    assert.equal(s.counts().paid, 1);
    assert.equal(s.counts().routeSigns, 1);
    assert.equal(s.counts().nativeSigns, 0);
  } finally {
    await s.close();
  }
});

for (const base of [false, true])
  test(`${base ? "Base" : "native"} lost delivery receipt recovers only with identical Replay-Only authority, then permits safe close`, async () => {
    const s = await scenario({ base, lostDelivery: 1 });
    try {
      await s.run("route");
      await s.run(base ? "deposit" : "open");
      await s.run(base ? "confirm-deposit" : "confirm-open");
      if (!base) await s.run("register");
      assert.equal((await s.run("deliver-1")).state, "unknown");
      const before = s.counts();
      clock += 65000;
      for (const fault of ["miss", "mismatch", "accounting", "lost"]) {
        s.setRecoveryFault(fault);
        assert.equal((await s.run("recover-delivery-1")).state, "unknown");
        await assert.rejects(s.run("deliver-1"));
        await assert.rejects(s.run("close"));
      }
      s.setRecoveryFault(null);
      assert.equal(
        (await s.run("recover-delivery-1")).state,
        "voucher_accepted",
      );
      const after = s.counts();
      assert.equal(after.merchantOrdinary, before.merchantOrdinary);
      assert.equal(after.nativeSigns, before.nativeSigns);
      assert.equal(after.baseSigns, before.baseSigns);
      assert.equal(after.providerCalls, before.providerCalls);
      assert.equal(after.providerVerify, before.providerVerify);
      await s.run("recover-delivery-1");
      assert.equal(s.counts().merchantRecovery, after.merchantRecovery);
      clock += 65000;
      await s.run("close");
      if (base) {
        for (const x of ["claim", "settle", "refund"]) {
          await s.run(x);
          await s.run("confirm-" + x);
        }
      } else await s.run("confirm-close");
      assert.equal((await s.run("status")).state, "closed");
    } finally {
      await s.close();
    }
  });
test("native lost registration receipt recovers after original offer expiry without another ordinary GET or funding", async () => {
  const s = await scenario({ lostRegister: true });
  try {
    await s.run("route");
    await s.run("open");
    await s.run("confirm-open");
    assert.equal((await s.run("register")).state, "unknown");
    const before = s.counts();
    clock += 65000;
    assert.equal(
      (await s.run("recover-register")).state,
      "merchant_registered",
    );
    assert.equal(s.counts().merchantOrdinary, before.merchantOrdinary);
    assert.equal(s.counts().openCalls, 1);
    assert.equal(s.counts().nativeSigns, 1);
    await s.run("refund-unused");
    await s.run("confirm-close");
  } finally {
    await s.close();
  }
});
test("fully consumed Base deposit reaches closed without issuing a zero refund", async () => {
  const s = await scenario({ base: true, emptyDeposit: true });
  try {
    await s.run("route");
    await s.run("deposit");
    await s.run("confirm-deposit");
    for (let n = 1; n <= 3; n++) await s.run("deliver-" + n);
    await s.run("close");
    for (const x of ["claim", "settle"]) {
      await s.run(x);
      await s.run("confirm-" + x);
    }
    const before = s.counts();
    assert.equal((await s.run("close-empty")).state, "closed");
    assert.equal(s.counts().providerCalls, 3);
    assert.equal(s.counts().providerCalls, before.providerCalls);
    assert.equal((await s.run("status")).state, "closed");
  } finally {
    await s.close();
  }
});
async function interruptedTransition(s, stage, expected) {
  const original = LocalBatchLedger.prototype.transition;
  let fired = false;
  LocalBatchLedger.prototype.transition = async function (from, to) {
    if (!fired && from === expected) {
      fired = true;
      throw Error("synthetic interruption after durable confirmation");
    }
    return original.call(this, from, to);
  };
  try {
    await assert.rejects(s.run(stage));
    assert.equal(fired, true);
  } finally {
    LocalBatchLedger.prototype.transition = original;
  }
}
test("native open/close retained confirmations repair only their interrupted progress transition", async () => {
  const s = await scenario();
  try {
    await s.run("route");
    await s.run("open");
    await interruptedTransition(s, "confirm-open", "open-inflight");
    assert.equal((await s.run("confirm-open")).state, "chain_confirmed");
    assert.equal((await s.run("status")).state, "active:0");
    await s.run("refund-unused");
    await interruptedTransition(s, "confirm-close", "close-inflight");
    assert.equal((await s.run("confirm-close")).state, "chain_confirmed");
    assert.equal((await s.run("status")).state, "closed");
    assert.equal(s.counts().openCalls, 1);
    assert.equal(s.counts().closeCalls, 1);
  } finally {
    await s.close();
  }
});
test("Base deposit and claim confirmation survive both durable-record/CAS and operation-journal/record interruptions", async () => {
  const s = await scenario({ base: true });
  try {
    await s.run("route");
    await s.run("deposit");
    await interruptedTransition(s, "confirm-deposit", "deposit-inflight");
    await s.run("confirm-deposit");
    assert.equal((await s.run("status")).state, "active:0");
    await s.run("deliver-1");
    await s.run("close");
    await s.run("claim");
    const original = LocalBatchLedger.prototype.once;
    let fired = false;
    LocalBatchLedger.prototype.once = async function (stage, value) {
      if (!fired && stage === "claim:confirmed") {
        fired = true;
        throw Error("synthetic interruption after operation reconciliation");
      }
      return original.call(this, stage, value);
    };
    try {
      await assert.rejects(s.run("confirm-claim"));
      assert.equal(fired, true);
    } finally {
      LocalBatchLedger.prototype.once = original;
    }
    assert.equal((await s.run("confirm-claim")).state, "chain_confirmed");
    assert.equal((await s.run("status")).state, "claimed");
    await s.run("settle");
    await interruptedTransition(s, "confirm-settle", "settle-inflight");
    await s.run("confirm-settle");
    await s.run("refund");
    await interruptedTransition(s, "confirm-refund", "refund-inflight");
    await s.run("confirm-refund");
    assert.equal((await s.run("status")).state, "closed");
    assert.equal(s.counts().providerCalls, 4);
  } finally {
    await s.close();
  }
});
for (const base of [false, true])
  test(`${base ? "Base" : "native"} accepted receipt interrupted before CAS repairs locally without even a recovery HTTP call`, async () => {
    const s = await scenario({ base });
    try {
      await s.run("route");
      await s.run(base ? "deposit" : "open");
      await s.run(base ? "confirm-deposit" : "confirm-open");
      if (!base) await s.run("register");
      const original = LocalBatchLedger.prototype.transition;
      let fired = false;
      LocalBatchLedger.prototype.transition = async function (from, to) {
        if (
          !fired &&
          this.campaignId === "native-cli-test" &&
          from === (base ? "delivery-inflight:1" : "voucher-inflight:1")
        ) {
          fired = true;
          throw Error("synthetic accepted/CAS interruption");
        }
        return original.call(this, from, to);
      };
      try {
        assert.equal((await s.run("deliver-1")).state, "unknown");
        assert.equal(fired, true);
      } finally {
        LocalBatchLedger.prototype.transition = original;
      }
      const before = s.counts();
      assert.equal(
        (await s.run("recover-delivery-1")).state,
        "voucher_accepted",
      );
      assert.equal(s.counts().merchantCalls, before.merchantCalls);
      assert.equal((await s.run("status")).state, "active:1");
    } finally {
      await s.close();
    }
  });

test("Base15-minute finalized deposit requires a separately paid fresh observation; original expiry and funding signatures remain unchanged", async () => {
  const s = await scenario({
    base: true,
    finality: true,
    lostSecondRoute: true,
  });
  try {
    const plan = await s.run("plan");
    assert.equal(plan.maximumRouteObservations, 2);
    assert.equal(plan.maximumRouteFeesAtomic, "6000");
    await assert.rejects(s.run("route-after-deposit"));
    assert.equal(s.counts().paid, 0);
    await s.run("route");
    await s.run("deposit");
    assert.equal((await s.run("confirm-deposit")).state, "unknown");
    await assert.rejects(s.run("route-after-deposit"));
    assert.equal(s.counts().paid, 1);
    const ledger = new LocalBatchLedger(
      join(s.config.directory, "batch"),
      s.config.campaignId,
    );
    const original = await ledger.require("plan");
    ledger.close();
    clock += 900000;
    s.releaseFinality();
    assert.equal((await s.run("confirm-deposit")).state, "chain_confirmed");
    await assert.rejects(s.run("deliver-1"));
    await assert.rejects(s.run("deposit"));
    assert.equal(s.counts().baseSigns, 2);
    assert.equal(s.counts().providerCalls, 1);
    assert.equal(
      (await s.run("route-after-deposit")).state,
      "routing_confirmed_and_verified",
    );
    assert.equal(s.counts().paid, 2);
    assert.equal(s.counts().routeSigns, 2);
    assert.equal(s.counts().recoveries, 1);
    await assert.rejects(
      s.run("route-after-deposit"),
      /route_already_attempted/,
    );
    assert.equal((await s.run("deliver-1")).state, "voucher_accepted");
    assert.equal((await s.run("deliver-2")).state, "voucher_accepted");
    const retained = new LocalBatchLedger(
      join(s.config.directory, "batch"),
      s.config.campaignId,
    );
    assert.deepEqual(await retained.require("plan"), original);
    const permit = await retained.require("delivery:observation");
    assert.equal(permit.expiresAt - permit.observedAt, 60000);
    assert.equal(original.expiresAt < permit.observedAt, true);
    retained.close();
    await s.run("close");
    for (const stage of ["claim", "settle", "refund"]) {
      await s.run(stage);
      assert.equal((await s.run("confirm-" + stage)).state, "chain_confirmed");
    }
    assert.equal((await s.run("status")).state, "closed");
    assert.equal(s.counts().providerCalls, 4);
    assert.equal(s.counts().baseSigns, 3);
    assert.equal(s.counts().paid, 2);
  } finally {
    await s.close();
  }
});
test("expired or altered second proof never permits voucher delivery, second fee never retries, unused refund remains available", async () => {
  for (const badSecondProof of [false, true]) {
    const s = await scenario({ base: true, finality: true, badSecondProof });
    try {
      await s.run("route");
      await s.run("deposit");
      clock += 900000;
      s.releaseFinality();
      await s.run("confirm-deposit");
      if (badSecondProof) await assert.rejects(s.run("route-after-deposit"));
      else {
        await s.run("route-after-deposit");
        clock += 61000;
      }
      await assert.rejects(s.run("deliver-1"));
      await assert.rejects(s.run("route-after-deposit"));
      assert.equal(s.counts().paid, 2);
      assert.equal(s.counts().baseSigns, 2);
      assert.equal(s.counts().merchantOrdinary, 0);
      await s.run("refund-unused");
      assert.equal((await s.run("confirm-refund")).state, "chain_confirmed");
    } finally {
      await s.close();
    }
  }
});
test("second observation budget is immutable and opt-in; native/default campaigns cannot acquire a second payment", async () => {
  const s = await scenario();
  try {
    await assert.rejects(
      s.run("route-after-deposit"),
      /second_observation_not_enabled/,
    );
    assert.equal(s.counts().routeSigns, 0);
    const changed = { ...s.config, maxRouteObservations: 2 };
    await assert.rejects(
      runCampaign({ stage: "plan", config: changed }),
      /route_observation_bound/,
    );
  } finally {
    await s.close();
  }
  const b = await scenario({ base: true, finality: true });
  try {
    for (const amount of ["7000", "10001"]) {
      const changed = {
        ...b.config,
        budget: { ...b.config.budget, maximumUSDCAtomic: amount },
      };
      await assert.rejects(
        runCampaign({ stage: "plan", config: changed }),
        /reviewed_two_observation_budget/,
      );
    }
  } finally {
    await b.close();
  }
});

test("lost second paid observation remains fenced through unavailable recovery, then recovers readonly under its separate original identity", async () => {
  const s = await scenario({
    base: true,
    finality: true,
    lostSecondRoute: true,
    secondRecoveryUnavailable: true,
  });
  try {
    await s.run("route");
    await s.run("deposit");
    clock += 900000;
    s.releaseFinality();
    await s.run("confirm-deposit");
    assert.equal(
      (await s.run("route-after-deposit")).state,
      "routing_unresolved_or_unpaid",
    );
    await assert.rejects(s.run("route-after-deposit"));
    await assert.rejects(s.run("deliver-1"));
    assert.equal(
      (await s.run("recover-route-after-deposit")).state,
      "routing_unresolved_or_unpaid",
    );
    assert.equal(s.counts().paid, 2);
    assert.equal(s.counts().routeSigns, 2);
    s.setSecondRecoveryUnavailable(false);
    assert.equal(
      (await s.run("recover-route-after-deposit")).state,
      "routing_confirmed_and_verified",
    );
    assert.equal(s.counts().paid, 2);
    assert.equal(s.counts().routeSigns, 2);
    assert.equal(s.counts().routeAuthorizations, 2);
    assert.equal((await s.run("deliver-1")).state, "voucher_accepted");
  } finally {
    await s.close();
  }
});
test("a signing callback that outlives the fresh second observation never transmits that voucher or enables a third fee", async () => {
  const s = await scenario({
    base: true,
    finality: true,
    slowSecondVoucher: true,
  });
  try {
    await s.run("route");
    await s.run("deposit");
    clock += 900000;
    s.releaseFinality();
    await s.run("confirm-deposit");
    await s.run("route-after-deposit");
    await s.run("deliver-1");
    assert.equal((await s.run("deliver-2")).state, "unknown");
    assert.equal(s.counts().merchantOrdinary, 1);
    assert.equal(s.counts().baseSigns, 3);
    await assert.rejects(s.run("deliver-2"));
    await assert.rejects(s.run("route-after-deposit"));
    await assert.rejects(s.run("refund-unused"));
    await assert.rejects(s.run("close"));
    assert.equal(s.counts().paid, 2);
    assert.equal(s.counts().providerCalls, 1);
  } finally {
    await s.close();
  }
});
