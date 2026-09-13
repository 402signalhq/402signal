import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { defaultRequest, fetchChallenge, sameTerms, signalGuard } from "../x402.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("../../../tests/fixtures/route-binding-v1.json", import.meta.url)),
);
const c = fixture.cases[0];
const ROUTER = "https://402signal.com/route";

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
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

test("402Signal's own fee challenge is allowed through without a check", async () => {
  const { calls, fetchWithPayment } = fakeFetch(jsonResponse(200, c.response));
  const hook = guard(fetchWithPayment);
  const ctx = context();
  ctx.paymentRequired.resource = { url: ROUTER };
  assert.equal(await hook(ctx), undefined);
  assert.equal(calls.length, 0);
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
