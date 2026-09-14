import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import test from "node:test";
import { DEFAULT_FEE_RECIPIENTS, DEFAULT_FEE_TERMS, defaultRequest, fetchChallenge, sameTerms, signalGuard } from "../x402.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("../../../tests/fixtures/route-binding-v1.json", import.meta.url)),
);
const c = fixture.cases[0];
const ROUTER = "https://402signal.com/route";

// A response double without a body stream, the way a minimal adapter answers:
// it declares its length, as real transports do, so the bounded reader accepts it.
function jsonResponse(status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const all = { "content-length": String(new TextEncoder().encode(text).byteLength), ...headers };
  return {
    status,
    headers: { get: (name) => all[name.toLowerCase()] ?? null },
    text: async () => text,
  };
}

// A payment-capable fetch double: records calls and answers the check.
function fakeFetch(answer) {
  const calls = [];
  const fetchWithPayment = async (url, init) => {
    calls.push({ url, init });
    return typeof answer === "function" ? answer(url, init) : answer;
  };
  return { calls, fetchWithPayment };
}

// The x402 client hands the hook its parsed 402 (which may drop unknown
// fields), so the adapter re-reads the seller's raw challenge separately.
function context(overrides = {}) {
  const paymentRequired = structuredClone(c.challenge);
  paymentRequired.resource = { url: c.response.url, mimeType: "application/json" };
  return {
    paymentRequired,
    selectedRequirements: structuredClone(c.challenge.accepts[0]),
    ...overrides,
  };
}

const rawChallenge = () => ({ status: 402, bodyText: JSON.stringify(c.challenge) });

function guard(fetchWithPayment, extra = {}) {
  return signalGuard({
    fetchWithPayment,
    trustedLogVkey: fixture.trusted_vkey,
    router: ROUTER,
    requestFor: () => c.request,
    challengeFor: rawChallenge,
    now: c.now,
    ...extra,
  });
}

test("a verified matching offer lets the payment proceed and pays the check through the buyer's fetch", async () => {
  const { calls, fetchWithPayment } = fakeFetch(jsonResponse(200, c.response));
  const results = [];
  const hook = guard(fetchWithPayment, { onResult: (r) => results.push(r) });
  const decision = await hook(context());
  assert.equal(decision, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ROUTER);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.body, JSON.stringify(c.request));
  assert.equal(results.length, 1);
  assert.equal(results[0].aborted, null);
  assert.equal(results[0].verified.model, "proof_carrying_route_v1");
  assert.deepEqual(results[0].verified.accepted, c.challenge.accepts[0]);
});

test("without challengeFor the seller challenge is re-read with the plain fetch, redirects refused", async () => {
  const { fetchWithPayment } = fakeFetch(jsonResponse(200, c.response));
  const rawCalls = [];
  const rawFetch = async (url, init) => {
    rawCalls.push({ url, init });
    return jsonResponse(402, c.challenge);
  };
  const decision = await signalGuard({
    fetchWithPayment,
    rawFetch,
    trustedLogVkey: fixture.trusted_vkey,
    router: ROUTER,
    requestFor: () => c.request,
    now: c.now,
  })(context());
  assert.equal(decision, undefined);
  assert.equal(rawCalls.length, 1);
  assert.equal(rawCalls[0].url, c.response.url);
  assert.equal(rawCalls[0].init.method, "GET");
  assert.equal(rawCalls[0].init.redirect, "error");
});

test("fetchChallenge captures both header channels and the body", async () => {
  const rawFetch = async () => jsonResponse(402, c.challenge, { "payment-required": "abc", "x-payment-required": "def" });
  const challenge = await fetchChallenge(rawFetch, "https://seller.example/x402");
  assert.equal(challenge.status, 402);
  assert.equal(challenge.bodyText, JSON.stringify(c.challenge));
  assert.equal(challenge.paymentRequired, "abc");
  assert.equal(challenge.xPaymentRequired, "def");
});

test("a seller challenge that claims the checker's own url is refused, never exempted (S1)", async () => {
  const { calls, fetchWithPayment } = fakeFetch(jsonResponse(200, c.response));
  const hook = guard(fetchWithPayment);
  const ctx = context();
  ctx.paymentRequired.resource = { url: ROUTER };
  const decision = await hook(ctx);
  assert.equal(decision.abort, true);
  assert.match(decision.reason, /checker's own url/);
  assert.equal(calls.length, 0);
  const elsewhere = context();
  elsewhere.paymentRequired.resource = { url: "https://402signal.com/anything" };
  assert.equal((await hook(elsewhere)).abort, true);
  // onMiss "allow" does not soften it.
  assert.equal((await guard(fetchWithPayment, { onMiss: "allow" })(ctx)).abort, true);
});

test("the hook's own fee is exempt only while its check is in flight, to a 402Signal recipient, at most the fee (S1)", async () => {
  let hook;
  const seen = [];
  const feeContext = (patch) => {
    const fee = context();
    fee.paymentRequired.resource = { url: ROUTER };
    fee.selectedRequirements = { ...fee.selectedRequirements, ...patch };
    return fee;
  };
  const fetchWithPayment = async () => {
    // The x402 client now sees the router's own 402 and consults the hook again.
    seen.push(await hook(feeContext({ payTo: DEFAULT_FEE_RECIPIENTS[0], amount: "3000" })));
    seen.push(await hook(feeContext({ payTo: DEFAULT_FEE_RECIPIENTS[0].toUpperCase().replace("0X", "0x"), amount: "5000" })));
    seen.push(await hook(feeContext({ amount: "3000" }))); // the seller's own recipient
    seen.push(await hook(feeContext({ payTo: DEFAULT_FEE_RECIPIENTS[0], amount: "5001" })));
    // The published fee terms are part of the bound: another asset, network or scheme is a seller's.
    seen.push(await hook(feeContext({ payTo: DEFAULT_FEE_RECIPIENTS[0], amount: "3000", asset: "0x000000000000000000000000000000000000dead" })));
    seen.push(await hook(feeContext({ payTo: DEFAULT_FEE_RECIPIENTS[0], amount: "3000", network: "eip155:137" })));
    seen.push(await hook(feeContext({ payTo: DEFAULT_FEE_RECIPIENTS[0], amount: "3000", scheme: "upto" })));
    return jsonResponse(200, c.response);
  };
  hook = guard(fetchWithPayment);
  assert.equal(await hook(context()), undefined);
  assert.equal(seen[0], undefined);
  assert.equal(seen[1], undefined);
  assert.equal(seen[2].abort, true);
  assert.equal(seen[3].abort, true);
  assert.equal(seen[4].abort, true);
  assert.equal(seen[5].abort, true);
  assert.equal(seen[6].abort, true);
  // Outside a fee call the same fee-shaped challenge is refused.
  assert.equal((await hook(feeContext({ payTo: DEFAULT_FEE_RECIPIENTS[0], amount: "3000" }))).abort, true);
  // Trusted configuration can name the recipients.
  const pinned = guard(fetchWithPayment, { feeRecipients: ["0x000000000000000000000000000000000000beef"] });
  seen.length = 0;
  assert.equal(await pinned(context()), undefined);
  assert.equal(seen[0].abort, true);
  // Trusted configuration can name the fee terms too: the default asset is then a seller's.
  assert.equal(DEFAULT_FEE_TERMS["eip155:8453"].asset, c.challenge.accepts[0].asset);
  const rotated = guard(fetchWithPayment, { feeTerms: { "eip155:8453": { scheme: "exact", asset: "0x000000000000000000000000000000000000cafe" } } });
  seen.length = 0;
  assert.equal(await rotated(context()), undefined);
  assert.equal(seen[0].abort, true);
  assert.throws(() => guard(fetchWithPayment, { feeTerms: {} }), /feeTerms/);
  assert.throws(() => guard(fetchWithPayment, { feeTerms: { "eip155:8453": { scheme: "exact" } } }), /feeTerms/);
});

test("fetchChallenge refuses an oversized body and a stalled read before parsing (S2)", async () => {
  const big = "x".repeat(64 * 1024 + 1);
  await assert.rejects(() => fetchChallenge(async () => jsonResponse(402, big), "https://seller.example/x402"), /challenge_too_large/);
  const streamed = async (_url, init) => ({
    status: 402,
    headers: { get: () => null },
    body: new ReadableStream({
      start(controller) {
        for (let i = 0; i < 65; i++) controller.enqueue(new Uint8Array(1024));
        controller.close();
      },
    }),
    text: async () => big,
    signal: init.signal,
  });
  await assert.rejects(() => fetchChallenge(streamed, "https://seller.example/x402"), /challenge_too_large/);
  const stalled = () => new Promise(() => {});
  await assert.rejects(() => fetchChallenge(stalled, "https://seller.example/x402", "GET", { timeoutMs: 20 }), /challenge_timeout/);
  const trickle = async () => ({
    status: 402,
    headers: { get: () => null },
    body: new ReadableStream({ pull: () => new Promise(() => {}) }),
  });
  await assert.rejects(() => fetchChallenge(trickle, "https://seller.example/x402", "GET", { timeoutMs: 20 }), /challenge_timeout/);
  const seen = [];
  const ok = await fetchChallenge(async (_url, init) => { seen.push(init.signal); return jsonResponse(402, c.challenge); }, "https://seller.example/x402");
  assert.equal(ok.bodyText, JSON.stringify(c.challenge));
  assert.ok(seen[0] instanceof AbortSignal);
  // The hook's built-in reread is the bounded one.
  const { fetchWithPayment } = fakeFetch(jsonResponse(200, c.response));
  const decision = await signalGuard({
    fetchWithPayment, rawFetch: async () => jsonResponse(402, big), trustedLogVkey: fixture.trusted_vkey, router: ROUTER,
    requestFor: () => c.request, now: c.now,
  })(context());
  assert.equal(decision.abort, true);
  assert.match(decision.reason, /challenge_too_large/);
});

test("fetchChallenge meters Node readable bodies and refuses an unmetered transport (S2 refresh)", async () => {
  const body = JSON.stringify(c.challenge);
  const nodeStream = (chunks) => async () => ({ status: 402, headers: { get: () => null }, body: Readable.from(chunks) });
  const streamed = await fetchChallenge(nodeStream([Buffer.from(body.slice(0, 10)), Buffer.from(body.slice(10))]), "https://seller.example/x402");
  assert.equal(streamed.bodyText, body);
  const chunks = Array.from({ length: 65 }, () => Buffer.alloc(1024, 120));
  await assert.rejects(() => fetchChallenge(nodeStream(chunks), "https://seller.example/x402"), /challenge_too_large/);
  // No stream and no declared length: nothing bounds text(), so the read is refused before it starts.
  let read = 0;
  const unmetered = async () => ({ status: 402, headers: { get: () => null }, text: async () => { read += 1; return body; } });
  await assert.rejects(() => fetchChallenge(unmetered, "https://seller.example/x402"), /challenge_unbounded_transport/);
  assert.equal(read, 0);
  // A declared length over the bound is refused without reading; a length that lies is caught after.
  const declares = (length, text) => async () => ({ status: 402, headers: { get: (n) => (n === "content-length" ? String(length) : null) }, text: async () => { read += 1; return text; } });
  await assert.rejects(() => fetchChallenge(declares(64 * 1024 + 1, body), "https://seller.example/x402"), /challenge_too_large/);
  assert.equal(read, 0);
  await assert.rejects(() => fetchChallenge(declares(10, "x".repeat(64 * 1024 + 1)), "https://seller.example/x402"), /challenge_too_large/);
  assert.equal((await fetchChallenge(declares(body.length, body), "https://seller.example/x402")).bodyText, body);
  // Through the hook the refusal is a completed abort, whatever onMiss says.
  const { fetchWithPayment } = fakeFetch(jsonResponse(200, c.response));
  const decision = await signalGuard({
    fetchWithPayment, rawFetch: unmetered, trustedLogVkey: fixture.trusted_vkey, router: ROUTER, requestFor: () => c.request, now: c.now, onMiss: "allow",
  })(context());
  assert.equal(decision.abort, true);
  assert.match(decision.reason, /challenge_unbounded_transport/);
});

test("POST needs the exact body supplied by the buyer (F5)", () => {
  assert.throws(
    () => signalGuard({ fetchWithPayment: async () => null, trustedLogVkey: "k", method: "POST" }),
    /POST needs challengeFor, requestFor and bodyFor/,
  );
  assert.doesNotThrow(() => signalGuard({
    fetchWithPayment: async () => null, trustedLogVkey: "k", method: "POST",
    challengeFor: async () => ({ status: 402, bodyText: "{}" }), requestFor: () => ({}), bodyFor: () => new Uint8Array(),
  }));
});

test("a completed miss aborts the payment by default and can be allowed explicitly", async () => {
  const miss = { live: false, payable: false, selected_payment: null, miss_reason: "no_402_envelope" };
  const { fetchWithPayment } = fakeFetch(jsonResponse(200, miss));
  const decision = await guard(fetchWithPayment)(context());
  assert.deepEqual(decision, { abort: true, reason: "402signal: no qualifying offer (no_402_envelope)" });
  const allowed = await guard(fetchWithPayment, { onMiss: "allow" })(context());
  assert.equal(allowed, undefined);
});

test("binding unavailable is reported as a completed answer, not a crash", async () => {
  const body = { live: false, binding_error: "route_binding_unavailable", miss_reason: "no_402_envelope" };
  const { fetchWithPayment } = fakeFetch(jsonResponse(503, body));
  const decision = await guard(fetchWithPayment)(context());
  assert.equal(decision.abort, true);
  assert.match(decision.reason, /route_binding_unavailable/);
});

test("a tampered receipt aborts the payment", async () => {
  const tampered = structuredClone(c.response);
  tampered.selected_payment.amount_atomic = 999999;
  tampered.decision_binding.quote_sha256 = "0".repeat(64);
  const { fetchWithPayment } = fakeFetch(jsonResponse(200, tampered));
  const decision = await guard(fetchWithPayment)(context());
  assert.equal(decision.abort, true);
  assert.match(decision.reason, /receipt verification failed/);
});

test("a seller challenge that changed since the check aborts the payment", async () => {
  const { fetchWithPayment } = fakeFetch(jsonResponse(200, c.response));
  const changed = structuredClone(c.challenge);
  changed.accepts[0].amount = "999999";
  const decision = await guard(fetchWithPayment, {
    challengeFor: () => ({ status: 402, bodyText: JSON.stringify(changed) }),
  })(context());
  assert.equal(decision.abort, true);
  assert.match(decision.reason, /receipt verification failed/);
});

test("requirements that differ from the verified offer abort the payment", async () => {
  const { fetchWithPayment } = fakeFetch(jsonResponse(200, c.response));
  const ctx = context();
  ctx.selectedRequirements.payTo = "0x000000000000000000000000000000000000dead";
  const decision = await guard(fetchWithPayment)(ctx);
  assert.deepEqual(decision, {
    abort: true,
    reason: "402signal: selected requirements differ from the verified offer",
  });
});

test("network failures, invalid JSON and missing resource urls abort rather than pass", async () => {
  const failing = async () => {
    throw new Error("boom");
  };
  const decision = await guard(failing)(context());
  assert.equal(decision.abort, true);
  assert.match(decision.reason, /check request failed/);
  const { fetchWithPayment } = fakeFetch(jsonResponse(200, "not json"));
  assert.equal((await guard(fetchWithPayment)(context())).abort, true);
  const noUrl = context();
  noUrl.paymentRequired.resource = {};
  assert.equal((await guard(fetchWithPayment)(noUrl)).abort, true);
  const ok = fakeFetch(jsonResponse(200, c.response));
  const noChallenge = await guard(ok.fetchWithPayment, {
    challengeFor: async () => {
      throw new Error("seller down");
    },
  })(context());
  assert.equal(noChallenge.abort, true);
  assert.match(noChallenge.reason, /seller challenge unavailable/);
});

test("the default request binds the exact resource url and the selected rail", () => {
  const request = defaultRequest("https://seller.example/x402?q=1", { network: "eip155:8453" }, { max_price_usd: 0.02 });
  assert.deepEqual(request, {
    url: "https://seller.example/x402?q=1",
    require_route_binding: true,
    networks: ["base"],
    max_price_usd: 0.02,
  });
  assert.deepEqual(defaultRequest("https://s.example/a", { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }).networks, ["solana"]);
  assert.equal("networks" in defaultRequest("https://s.example/a", { network: "stellar:pubnet" }), false);
});

test("sameTerms compares economic fields and EVM addresses case-insensitively", () => {
  const accepted = c.challenge.accepts[0];
  assert.equal(sameTerms(accepted, { ...accepted, payTo: accepted.payTo.toUpperCase() }), true);
  assert.equal(sameTerms(accepted, { ...accepted, amount: "10001" }), false);
  assert.equal(sameTerms(accepted, { ...accepted, network: "eip155:137" }), false);
  assert.equal(sameTerms(accepted, null), false);
});

test("constructor validates its options", () => {
  assert.throws(() => signalGuard({}), /fetchWithPayment/);
  assert.throws(() => signalGuard({ fetchWithPayment: async () => null }), /trustedLogVkey/);
  assert.throws(
    () => signalGuard({ fetchWithPayment: async () => null, trustedLogVkey: "k", router: "http://evil.example/route" }),
    /https/,
  );
  assert.throws(
    () => signalGuard({ fetchWithPayment: async () => null, trustedLogVkey: "k", onMiss: "ignore" }),
    /onMiss/,
  );
});
