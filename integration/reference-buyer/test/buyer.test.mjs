import { mppxSellerPayload } from "../mppx-seller.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";
import { RouteClient } from "@402signal/route-guard/client";
import { FileAttemptStore } from "@402signal/route-guard/file-store";
import { BaseBuyer, sdkPayload } from "../base-buyer.mjs";
import { BuyerJournal } from "../journal.mjs";
import {
  BASE,
  USDC,
  TYPES,
  canonical,
  checkTypedData,
  challengeOf,
} from "../policy.mjs";
import { confirmBase, readOnlyRpc } from "../confirmation.mjs";
import {
  agentsToolsSearch,
  parallelSearch,
  routeRequest,
  runSearch,
} from "../workflow.mjs";
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../sdk/route-guard/test/support/search-example-fixture.json",
      import.meta.url,
    ),
  ),
);
const realNow = Date.now;
Date.now = () => fixture.now * 1000;
test.after(() => {
  Date.now = realNow;
});
const abi = parseAbi([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)",
]);
const TX = "0x" + "a".repeat(64),
  SELLER_TX = "0x" + "b".repeat(64),
  ROUTER = "0x" + "2".repeat(40),
  PAYEE = "0x" + "1".repeat(40),
  SPONSOR = "0x" + "3".repeat(40);
const b64 = (x) => Buffer.from(JSON.stringify(x)).toString("base64");
function wire(c) {
  return { status: 402, bodyText: JSON.stringify(c), paymentRequired: b64(c) };
}
function setup(options = {}) {
  const selected = options.fixture ?? fixture;
  const dir = mkdtempSync(join(tmpdir(), "reference-buyer-test-"));
  const local = privateKeyToAccount(generatePrivateKey());
  let signatures = 0,
    paid = 0,
    unpaid = 0;
  const account = {
    address: local.address,
    signTypedData: (d) => {
      signatures++;
      return local.signTypedData(d);
    },
  };
  const policy = {
    buyerAddress: account.address,
    routerUrl: "https://402signal.com/route",
    routerPayTo: options.routerPayTo ?? ROUTER,
    rpcUrl: "https://rpc.example.test/",
    campaignMaximumAtomic: "4000",
    buyerNativeFeeAtomic: "0",
    sellers: [
      {
        id: "agentstools",
        url: "https://api.agentstools.dev/search",
        method: "GET",
        payTo: PAYEE,
        maximumAtomic: "1000",
        maxLifetimeSeconds: 300,
      },
    ],
  };
  if (selected !== fixture) {
    policy.campaignMaximumAtomic = "13000";
    policy.sellers = [
      {
        id: "parallel",
        url: "https://parallelmpp.dev/api/search",
        method: "POST",
        payTo: PAYEE,
        maximumAtomic: "10000",
        maxLifetimeSeconds: 300,
      },
    ];
  }
  const journal = new BuyerJournal(join(dir, "ledger"), policy);
  const rpc = async (method, args) => {
    const transaction = args?.[0];
    const stage = transaction === SELLER_TX ? "seller" : "router";
    const i = journal.get("job", stage + "_intent");
    if (method === "eth_call") return "0xf4240";
    if (method === "eth_chainId") return options.wrongChain ? "0x1" : "0x2105";
    if (method === "eth_blockNumber") return "0x101";
    if (method === "eth_getBlockByNumber") return { hash: "0xblock" };
    if (method === "eth_getTransactionByHash")
      return {
        hash: transaction,
        blockHash: "0xblock",
        blockNumber: "0x100",
        from: options.buyerPaysGas ? account.address : SPONSOR,
      };
    if (method === "eth_getTransactionReceipt") {
      const nonce = options.wrongNonce ? "0x" + "9".repeat(64) : i.nonce;
      return {
        transactionHash: transaction,
        status: "0x1",
        from: options.buyerPaysGas ? account.address : SPONSOR,
        blockHash: "0xblock",
        blockNumber: "0x100",
        logs: [
          {
            address: USDC,
            data: encodeAbiParameters(
              [{ type: "uint256" }],
              [BigInt(i.amount)],
            ),
            topics: encodeEventTopics({
              abi,
              eventName: "Transfer",
              args: { from: i.buyer, to: i.payTo },
            }),
          },
          {
            address: USDC,
            data: "0x",
            topics: encodeEventTopics({
              abi,
              eventName: "AuthorizationUsed",
              args: { authorizer: i.buyer, nonce },
            }),
          },
        ],
      };
    }
    throw new Error("unexpected_rpc_method");
  };
  const receipt = (transaction) =>
    b64({ success: true, network: BASE, transaction, payer: account.address });
  const fetchImpl = async (url, init) => {
    assert.equal(url, selected.url);
    assert.equal(init.method, selected === fixture ? "GET" : "POST");
    assert.equal(
      init.body,
      selected === fixture ? undefined : selected.request.probe_request.body,
    );
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    if (init.headers["PAYMENT-SIGNATURE"]) {
      paid++;
      assert.ok(journal.get("job", "seller_authorization"));
      assert.ok(journal.get("job", "seller_submission"));
      if (options.lostSeller) throw new Error("ambiguous_seller_transport");
      return new Response(
        JSON.stringify({
          results: [{ title: "synthetic", url: "https://example.test/" }],
        }),
        { status: 200, headers: { "PAYMENT-RESPONSE": receipt(SELLER_TX) } },
      );
    }
    unpaid++;
    return new Response(JSON.stringify(selected.challenge), {
      status: 402,
      headers: { "PAYMENT-REQUIRED": b64(selected.challenge) },
    });
  };
  const buyer = new BaseBuyer({
    account,
    journal,
    policy,
    fetch: fetchImpl,
    rpc,
    now: () => selected.now,
    confirmationIntervalMs: 0,
    ...options.buyerOptions,
  });
  const q = {
    x402Version: 2,
    error: "Synthetic unpaid challenge",
    resource: { url: policy.routerUrl, mimeType: "application/json" },
    accepts: [
      {
        ...selected.challenge.accepts[0],
        payTo: policy.routerPayTo,
        amount: "3000",
        maxTimeoutSeconds: 60,
      },
    ],
  };
  q.accepts[0].currency = USDC;
  q.accepts[0].extra = {
    ...q.accepts[0].extra,
    facilitator: "https://api.cdp.coinbase.com/platform/v2/x402",
    caip2: BASE,
    displayAmount: "$0.003",
  };
  q.accepts.push(
    { scheme: "exact", network: "solana:synthetic", amount: "3000" },
    { scheme: "exact", network: "algorand:synthetic", amount: "3000" },
  );
  q.extensions = { bazaar: {} };
  const outcome = {
    response: {
      status: 200,
      bodyText: JSON.stringify(selected.response),
      paymentResponse: receipt(TX),
    },
    classification: { settlementReport: "settled" },
  };
  return {
    dir,
    account,
    policy,
    journal,
    buyer,
    q,
    outcome,
    receipt,
    rpc,
    counts: () => ({ signatures, paid, unpaid }),
    close() {
      journal.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
async function routed(s) {
  s.buyer.reserve("job", agentsToolsSearch(fixture.query));
  await s.buyer.signRouting("job", wire(s.q));
  assert.equal(await s.buyer.confirmRouting("job", s.outcome), true);
}
test("real Base signer + independent receipts + exact guarded seller request succeeds", async () => {
  const s = setup();
  try {
    await routed(s);
    const c = await s.buyer.sellerChallenge("job");
    const r = await s.buyer.executeSellerOnce("job", {
      outcome: s.outcome,
      routeRequestJson: JSON.stringify(fixture.request),
      trustedLogVkey: fixture.trusted_vkey,
      challenge: c,
    });
    assert.equal(r.state, "payment_confirmed_response_received");
    assert.equal(r.deliveryQuality, "not_assessed");
    assert.equal(s.journal.job("job").state, "complete");
    assert.deepEqual(s.counts(), { signatures: 2, paid: 1, unpaid: 1 });
    await assert.rejects(
      s.buyer.executeSellerOnce("job", {
        outcome: s.outcome,
        routeRequestJson: JSON.stringify(fixture.request),
        trustedLogVkey: fixture.trusted_vkey,
        challenge: c,
      }),
      /stage_already_claimed/,
    );
    assert.equal(s.counts().paid, 1);
  } finally {
    s.close();
  }
});
test("full RouteClient and private attempt-store orchestration", async () => {
  const s = setup();
  try {
    let calls = 0;
    const client = new RouteClient({
      store: new FileAttemptStore(join(s.dir, "attempts")),
      recoveryProfile: "http-route-v1",
      fetch: async (url, init) => {
        calls++;
        if (init.headers["Replay-Only"] === "1")
          return new Response(
            JSON.stringify({
              error: "recovery_unavailable",
              recovery_only: true,
              new_payment_allowed: false,
            }),
            { status: 503 },
          );
        if (!init.headers["PAYMENT-SIGNATURE"])
          return new Response(JSON.stringify(s.q), {
            status: 402,
            headers: { "PAYMENT-REQUIRED": b64(s.q) },
          });
        return new Response(s.outcome.response.bodyText, {
          status: 200,
          headers: { "PAYMENT-RESPONSE": s.receipt(TX) },
        });
      },
    });
    const r = await runSearch({
      id: "job",
      query: fixture.query,
      buyer: s.buyer,
      client,
      trustedLogVkey: fixture.trusted_vkey,
    });
    assert.equal(r.state, "payment_confirmed_response_received");
    assert.equal(calls, 4);
    assert.equal(s.counts().paid, 1);
  } finally {
    s.close();
  }
});
test("ambiguous seller send preserves authorization and prohibits any second signing/send", async () => {
  const s = setup({ lostSeller: true });
  try {
    await routed(s);
    const args = {
      outcome: s.outcome,
      routeRequestJson: JSON.stringify(fixture.request),
      trustedLogVkey: fixture.trusted_vkey,
      challenge: wire(fixture.challenge),
    };
    await assert.rejects(
      s.buyer.executeSellerOnce("job", args),
      /ambiguous_seller_transport/,
    );
    await assert.rejects(
      s.buyer.executeSellerOnce("job", args),
      /stage_already_claimed/,
    );
    assert.ok(s.journal.get("job", "seller_authorization"));
    assert.equal(s.counts().paid, 1);
    assert.equal(s.counts().signatures, 2);
    assert.throws(
      () => s.buyer.reserve("other", agentsToolsSearch(fixture.query)),
      /prior_job_unresolved/,
    );
  } finally {
    s.close();
  }
});
for (const mode of ["wrongNonce", "buyerPaysGas"])
  test(mode + " prevents confirmation and seller activity", async () => {
    const s = setup({ [mode]: true });
    try {
      s.buyer.reserve("job", agentsToolsSearch(fixture.query));
      await s.buyer.signRouting("job", wire(s.q));
      assert.equal(await s.buyer.confirmRouting("job", s.outcome), false);
      await assert.rejects(
        s.buyer.sellerChallenge("job"),
        /routing_confirmation_required/,
      );
      assert.equal(s.counts().paid + s.counts().unpaid, 0);
    } finally {
      s.close();
    }
  });
for (const mutation of [
  "recipient",
  "amount",
  "lifetime",
  "domain",
  "channels",
])
  test("router " + mutation + " refused before signing", async () => {
    const s = setup();
    try {
      s.buyer.reserve("job", agentsToolsSearch(fixture.query));
      const c = structuredClone(s.q);
      if (mutation === "recipient") c.accepts[0].payTo = PAYEE;
      if (mutation === "amount") c.accepts[0].amount = "4000";
      if (mutation === "lifetime") c.accepts[0].maxTimeoutSeconds = 300;
      if (mutation === "domain") c.accepts[0].extra.version = "1";
      const w = wire(c);
      if (mutation === "channels")
        ((w.paymentRequired = b64(s.q)), (w.bodyText = "{}"));
      await assert.rejects(s.buyer.signRouting("job", w));
      assert.equal(s.counts().signatures, 0);
    } finally {
      s.close();
    }
  });
test("changed query/proof stops before seller signing", async () => {
  const s = setup();
  try {
    await routed(s);
    const changed = structuredClone(fixture.response);
    changed.url += "changed";
    await assert.rejects(
      s.buyer.executeSellerOnce("job", {
        outcome: {
          ...s.outcome,
          response: {
            ...s.outcome.response,
            bodyText: JSON.stringify(changed),
          },
        },
        routeRequestJson: JSON.stringify({
          ...fixture.request,
          url: fixture.url + "&changed=1",
        }),
        trustedLogVkey: fixture.trusted_vkey,
        challenge: wire(fixture.challenge),
      }),
    );
    assert.equal(s.counts().signatures, 1);
    assert.equal(s.counts().paid, 0);
  } finally {
    s.close();
  }
});
test("campaign policy immutable, duplicate jobs and exhausted budget survive reopening", () => {
  const s = setup();
  try {
    s.buyer.reserve("job", agentsToolsSearch(fixture.query));
    s.journal.finish("job", "free_miss");
    const reopened = new BuyerJournal(join(s.dir, "ledger"), s.policy);
    assert.throws(
      () => reopened.reserve("job", {}, "4000"),
      /job_already_reserved/,
    );
    assert.throws(
      () => reopened.reserve("new", {}, "4000"),
      /campaign_budget_exhausted/,
    );
    reopened.close();
    assert.throws(
      () =>
        new BuyerJournal(join(s.dir, "ledger"), {
          ...s.policy,
          campaignMaximumAtomic: "8000",
        }),
      /campaign_policy_changed/,
    );
  } finally {
    s.close();
  }
});
test("private directory permissions enforced", () => {
  const s = setup();
  try {
    chmodSync(join(s.dir, "ledger"), 0o755);
    assert.throws(
      () => new BuyerJournal(join(s.dir, "ledger"), s.policy),
      /private_journal_required/,
    );
    chmodSync(join(s.dir, "ledger"), 0o700);
  } finally {
    s.close();
  }
});
test("untrusted credential factory cannot trigger second signature or unexpected effects", async () => {
  const s = setup({
    buyerOptions: {
      createPayload: async ({ challenge, account }) => {
        const data = {
          domain: {
            name: "USD Coin",
            version: "2",
            chainId: 1,
            verifyingContract: USDC,
          },
          types: TYPES,
          primaryType: "TransferWithAuthorization",
          message: {
            from: account.address,
            to: ROUTER,
            value: 3000n,
            validAfter: 0n,
            validBefore: BigInt(fixture.now + 60),
            nonce: "0x" + "7".repeat(64),
          },
        };
        await account.signTypedData(data);
      },
    },
  });
  try {
    s.buyer.reserve("job", agentsToolsSearch(fixture.query));
    await assert.rejects(
      s.buyer.signRouting("job", wire(s.q)),
      /typed_data_domain_refused/,
    );
    await assert.rejects(
      s.buyer.signRouting("job", wire(s.q)),
      /stage_already_claimed/,
    );
    assert.equal(s.counts().signatures, 0);
  } finally {
    s.close();
  }
});
test("RPC client only admits read methods", async () => {
  let sent = 0;
  const rpc = readOnlyRpc("https://rpc.example.test/", async () => {
    sent++;
  });
  await assert.rejects(rpc("eth_sendRawTransaction", []), /rpc_write_refused/);
  assert.equal(sent, 0);
});

test("wrong-chain RPC refuses before wallet signature", async () => {
  const s = setup({ wrongChain: true });
  try {
    s.buyer.reserve("job", agentsToolsSearch(fixture.query));
    await assert.rejects(
      s.buyer.signRouting("job", wire(s.q)),
      /wrong_rpc_chain/,
    );
    assert.equal(s.counts().signatures, 0);
  } finally {
    s.close();
  }
});
test("insufficient USDC refuses before wallet signature", async () => {
  const s = setup({
    buyerOptions: {
      rpc: async (m) => (m === "eth_chainId" ? "0x2105" : "0x0"),
    },
  });
  try {
    s.buyer.reserve("job", agentsToolsSearch(fixture.query));
    await assert.rejects(
      s.buyer.signRouting("job", wire(s.q)),
      /insufficient_usdc_balance/,
    );
    assert.equal(s.counts().signatures, 0);
  } finally {
    s.close();
  }
});
test("lost seller response can only be reconciled by matching existing on-chain effects", async () => {
  const s = setup({ lostSeller: true });
  try {
    await routed(s);
    await assert.rejects(
      s.buyer.executeSellerOnce("job", {
        outcome: s.outcome,
        routeRequestJson: JSON.stringify(fixture.request),
        trustedLogVkey: fixture.trusted_vkey,
        challenge: wire(fixture.challenge),
      }),
    );
    const r = await s.buyer.reconcileSeller("job", SELLER_TX);
    assert.equal(r.state, "payment_confirmed");
    assert.equal(r.responseRetained, false);
    assert.equal(s.counts().signatures, 2);
    assert.equal(s.counts().paid, 1);
  } finally {
    s.close();
  }
});

test("duplicate JSON keys rejected in both payment challenge channels", () => {
  const original = '{"x402Version":2,"x402Version":2,"accepts":[{}]}';
  assert.throws(
    () => challengeOf({ status: 402, bodyText: original }),
    /invalid_json/,
  );
  assert.throws(
    () =>
      challengeOf({
        status: 402,
        bodyText: '{"x402Version":2,"accepts":[{}]}',
        paymentRequired: Buffer.from(original).toString("base64"),
      }),
    /invalid_json/,
  );
});
test("duplicate Base payment option is ambiguous even when identical", async () => {
  const s = setup();
  try {
    s.buyer.reserve("job", agentsToolsSearch(fixture.query));
    s.q.accepts.push(structuredClone(s.q.accepts[0]));
    await assert.rejects(
      s.buyer.signRouting("job", wire(s.q)),
      /ambiguous_base_offer/,
    );
    assert.equal(s.counts().signatures, 0);
  } finally {
    s.close();
  }
});
test("router allows observed metadata but refuses new payment authority", async () => {
  const s = setup();
  try {
    s.buyer.reserve("job", agentsToolsSearch(fixture.query));
    s.q.accepts[0].extra.assetTransferMethod = "permit2";
    await assert.rejects(
      s.buyer.signRouting("job", wire(s.q)),
      /payment_domain_refused/,
    );
    assert.equal(s.counts().signatures, 0);
  } finally {
    s.close();
  }
});
test("additional USDC debit and mismatched transaction block remain unconfirmed", async () => {
  const s = setup();
  try {
    s.buyer.reserve("job", agentsToolsSearch(fixture.query));
    await s.buyer.signRouting("job", wire(s.q));
    const i = s.journal.get("job", "router_intent");
    for (const mutation of ["extra_debit", "wrong_block"]) {
      const rpc = async (m, a) => {
        const r = await s.rpc(m, a);
        if (m === "eth_getTransactionReceipt" && mutation === "extra_debit")
          r.logs.push({
            address: USDC,
            data: encodeAbiParameters([{ type: "uint256" }], [1n]),
            topics: encodeEventTopics({
              abi,
              eventName: "Transfer",
              args: { from: i.buyer, to: SPONSOR },
            }),
          });
        if (m === "eth_getTransactionByHash" && mutation === "wrong_block")
          r.blockHash = "0xwrong";
        return r;
      };
      assert.equal((await confirmBase(i, TX, rpc)).state, "unknown");
    }
  } finally {
    s.close();
  }
});
test("Parallel profile binds exact raw query JSON and one-shot mode", () => {
  const r = parallelSearch("x402 payment protocol");
  assert.equal(r.method, "POST");
  assert.equal(r.url, "https://parallelmpp.dev/api/search");
  assert.equal(
    r.bodyText,
    '{"query":"x402 payment protocol","mode":"one-shot"}',
  );
  const route = JSON.parse(routeRequest(r));
  assert.equal(route.probe_request.body, r.bodyText);
  assert.equal(route.probe_request.profile, "parallel-search-json-v1");
  assert.equal(route.need, undefined);
  assert.equal(route.max_price_usd, 0.01);
});
test("bounded recent validity explicitly supported without accepting older authorization", () => {
  const now = fixture.now,
    q = fixture.challenge.accepts[0],
    buyer = "0x" + "4".repeat(40);
  const data = {
    primaryType: "TransferWithAuthorization",
    types: TYPES,
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: 8453,
      verifyingContract: USDC,
    },
    message: {
      from: buyer,
      to: q.payTo,
      value: 1000n,
      validAfter: BigInt(now - 600),
      validBefore: BigInt(now + 300),
      nonce: "0x" + "7".repeat(64),
    },
  };
  assert.throws(
    () => checkTypedData(data, q, buyer, now),
    /typed_data_effects_refused/,
  );
  assert.equal(
    checkTypedData(data, q, buyer, now, "recent").validAfter,
    String(now - 600),
  );
  data.message.validAfter = BigInt(now - 602);
  assert.throws(
    () => checkTypedData(data, q, buyer, now, "recent"),
    /typed_data_effects_refused/,
  );
});

test("mppx seller credential stays behind real durable sign claim, exact guard and confirmation", async () => {
  const s = setup({
    buyerOptions: {
      createSellerPayload: mppxSellerPayload,
      sellerAuthorizationTiming: "recent",
    },
  });
  try {
    await routed(s);
    const args = {
      outcome: s.outcome,
      routeRequestJson: JSON.stringify(fixture.request),
      trustedLogVkey: fixture.trusted_vkey,
      challenge: wire(fixture.challenge),
    };
    const result = await s.buyer.executeSellerOnce("job", args);
    assert.equal(result.state, "payment_confirmed_response_received");
    assert.equal(
      s.journal.get("job", "seller_intent").validAfter,
      String(fixture.now - 600),
    );
    assert.equal(s.counts().signatures, 2);
    assert.equal(s.counts().paid, 1);
    await assert.rejects(
      s.buyer.executeSellerOnce("job", args),
      /stage_already_claimed/,
    );
    assert.equal(s.counts().signatures, 2);
  } finally {
    s.close();
  }
});
test("normal free miss terminates the job without refunding reservation or seller call", async () => {
  const s = setup();
  try {
    s.buyer.reserve("job", agentsToolsSearch(fixture.query));
    await s.buyer.signRouting("job", wire(s.q));
    const body = {
      live: false,
      payable: false,
      invocable: false,
      selected_payment: null,
      miss_reason: "constraints_unmet",
      billing: {
        model: "success_only_v1",
        condition: "live_eligible_route_found",
        asset: "USDC",
        amount_atomic: "3000",
        display_amount: "$0.003",
        rail: "base",
        settlement_attempted: false,
        settled: false,
        settlement_state: "not_attempted",
      },
    };
    const outcome = {
      response: {
        status: 200,
        bodyText: JSON.stringify(body),
        paymentResponse: null,
      },
    };
    assert.equal(s.buyer.validatedFreeMiss("job", outcome), true);
    assert.equal(s.journal.job("job").state, "free_miss");
    assert.equal(s.journal.job("job").reserved, 4000);
    assert.throws(
      () => s.buyer.reserve("other", agentsToolsSearch(fixture.query)),
      /campaign_budget_exhausted/,
    );
    assert.equal(s.counts().paid, 0);
  } finally {
    s.close();
  }
});

test("complete Parallel POST workflow preserves exact body through RouteClient and mppx seller payment", async () => {
  const post = JSON.parse(
    readFileSync(new URL("./parallel-fixture.json", import.meta.url)),
  );
  Date.now = () => post.now * 1000;
  const s = setup({
    fixture: post,
    buyerOptions: {
      createSellerPayload: mppxSellerPayload,
      sellerAuthorizationTiming: "recent",
    },
  });
  try {
    let signedRoutes = 0;
    const client = new RouteClient({
      store: new FileAttemptStore(join(s.dir, "attempts")),
      recoveryProfile: "http-route-v1",
      fetch: async (url, init) => {
        if (init.headers["Replay-Only"] === "1")
          return new Response(
            JSON.stringify({
              error: "recovery_unavailable",
              recovery_only: true,
              new_payment_allowed: false,
            }),
            { status: 503 },
          );
        assert.equal(
          JSON.parse(init.body).probe_request.body,
          post.request.probe_request.body,
        );
        if (!init.headers["PAYMENT-SIGNATURE"])
          return new Response(JSON.stringify(s.q), {
            status: 402,
            headers: { "PAYMENT-REQUIRED": b64(s.q) },
          });
        signedRoutes++;
        return new Response(s.outcome.response.bodyText, {
          status: 200,
          headers: { "PAYMENT-RESPONSE": s.receipt(TX) },
        });
      },
    });
    const result = await runSearch({
      id: "job",
      query: post.query,
      sellerId: "parallel",
      buyer: s.buyer,
      client,
      trustedLogVkey: post.trusted_vkey,
    });
    assert.equal(result.state, "payment_confirmed_response_received");
    assert.equal(s.journal.job("job").reserved, 13000);
    assert.equal(s.journal.get("job", "seller_intent").amount, "10000");
    assert.equal(signedRoutes, 1);
    assert.deepEqual(s.counts(), { signatures: 2, paid: 1, unpaid: 1 });
  } finally {
    s.close();
    Date.now = () => fixture.now * 1000;
  }
});

test("receipt payer is optional but existing nonce and transfer are independently required", async () => {
  const s = setup();
  try {
    s.buyer.reserve("job", agentsToolsSearch(fixture.query));
    await s.buyer.signRouting("job", wire(s.q));
    const outcome = structuredClone(s.outcome);
    outcome.response.paymentResponse = b64({
      success: true,
      network: BASE,
      transaction: TX,
    });
    assert.equal(await s.buyer.confirmRouting("job", outcome), true);
  } finally {
    s.close();
  }
});
test("POST operator policy refuses unreviewed bodies before journal reservation", () => {
  const s = setup();
  try {
    assert.throws(
      () =>
        s.buyer.reserve("job", {
          sellerId: "parallel",
          url: "https://parallelmpp.dev/api/search",
          method: "POST",
          bodyText: '{"query":"safe","mode":"one-shot","action":"mutate"}',
        }),
      /post_profile_refused/,
    );
    assert.throws(() => s.journal.job("job"), /unknown_job/);
  } finally {
    s.close();
  }
});

const LIVE_ROUTER_PAYEE = "0xb18fc2275f36dae99eb215caeff03b431f887d16";
test("real SDK preserves lowercase router offer while checksumming signed authorization", async () => {
  const s = setup({ routerPayTo: LIVE_ROUTER_PAYEE });
  try {
    s.buyer.reserve("job", agentsToolsSearch(fixture.query));
    const encoded = await s.buyer.signRouting("job", wire(s.q));
    const payload = JSON.parse(Buffer.from(encoded, "base64").toString());
    const data = s.journal.get("job", "router_typed_data");
    assert.equal(payload.accepted.payTo, LIVE_ROUTER_PAYEE);
    assert.notEqual(payload.payload.authorization.to, LIVE_ROUTER_PAYEE);
    assert.equal(payload.payload.authorization.to, data.message.to);
    assert.equal(data.message.to.toLowerCase(), LIVE_ROUTER_PAYEE);
    assert.equal(payload.payload.authorization.from, data.message.from);
    assert.ok(s.journal.get("job", "router_authorization"));
    assert.equal(await s.buyer.confirmRouting("job", s.outcome), true);
    await assert.rejects(s.buyer.signRouting("job", wire(s.q)), /stage_already_claimed/);
    assert.deepEqual(s.counts(), { signatures: 1, paid: 0, unpaid: 0 });
  } finally {
    s.close();
  }
});
for (const field of ["from", "to", "value", "validAfter", "validBefore", "nonce", "extra"]) {
  test("post-sign " + field + " mutation remains fenced with checksum offer", async () => {
    const s = setup({
      routerPayTo: LIVE_ROUTER_PAYEE,
      buyerOptions: {
        createPayload: async (args) => {
          const payload = await sdkPayload(args);
          const auth = payload.payload.authorization;
          if (field === "from" || field === "to") auth[field] = "0x" + "9".repeat(40);
          else if (field === "nonce") auth[field] = "0x" + "9".repeat(64);
          else if (field === "extra") auth.extra = true;
          else auth[field] = String(BigInt(auth[field]) + 1n);
          return payload;
        },
      },
    });
    try {
      s.buyer.reserve("job", agentsToolsSearch(fixture.query));
      await assert.rejects(s.buyer.signRouting("job", wire(s.q)), /authorization_payload_mismatch/);
      assert.equal(s.journal.get("job", "router_authorization"), undefined);
      await assert.rejects(s.buyer.signRouting("job", wire(s.q)), /stage_already_claimed/);
      assert.deepEqual(s.counts(), { signatures: 1, paid: 0, unpaid: 0 });
    } finally {
      s.close();
    }
  });
}

test("fourth independent observation confirms without any additional signing or submission", async () => {
  const s = setup();
  try {
    s.buyer.reserve("job", agentsToolsSearch(fixture.query));
    await s.buyer.signRouting("job", wire(s.q));
    let observations = 0;
    const buyer = new BaseBuyer({
      account: s.account, journal: s.journal, policy: s.policy,
      now: () => fixture.now, confirmationIntervalMs: 0,
      fetch: () => assert.fail("confirmation cannot submit HTTP payment"),
      rpc: async (method, params) => {
        if (method === "eth_getTransactionReceipt" && ++observations <= 3) return null;
        return s.rpc(method, params);
      },
    });
    assert.equal(await buyer.confirmRouting("job", s.outcome), true);
    assert.equal(observations, 4);
    assert.ok(s.journal.get("job", "router_confirmation"));
    assert.deepEqual(s.counts(), { signatures: 1, paid: 0, unpaid: 0 });
  } finally { s.close(); }
});
test("six pending observations remain unknown without releasing signing authority", async () => {
  const s = setup();
  try {
    s.buyer.reserve("job", agentsToolsSearch(fixture.query));
    await s.buyer.signRouting("job", wire(s.q));
    let observations = 0;
    const buyer = new BaseBuyer({account:s.account,journal:s.journal,policy:s.policy,
      confirmationIntervalMs:0,fetch:()=>assert.fail(),rpc:async(method,params)=>{
        if(method === "eth_getTransactionReceipt"){ observations++; return null; }
        return s.rpc(method,params);
      }});
    assert.equal(await buyer.confirmRouting("job",s.outcome),false);
    assert.equal(observations,6);
    assert.equal(s.journal.get("job","router_confirmation"),undefined);
    await assert.rejects(buyer.signRouting("job",wire(s.q)),/stage_already_claimed/);
    assert.deepEqual(s.counts(),{signatures:1,paid:0,unpaid:0});
  } finally {s.close();}
});
