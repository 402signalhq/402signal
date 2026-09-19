import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  BASE_NETWORK,
  BASE_USDC,
  MppGuardError,
  challengeTerms,
  defaultLimits,
  defaultRequest,
  mppGuard,
  parseChallengeHeader,
  sameTerms,
} from "../mpp.mjs";

const fixture = JSON.parse(
  fs.readFileSync(new URL("../../../tests/fixtures/base-native-mpp-v5.json", import.meta.url)),
);
const header = fixture.challenge.wwwAuthenticate;
const url = fixture.request.url;
const ROUTER = "https://402signal.com/route";

function liveChallenge(overrides = {}) {
  const [parsed] = parseChallengeHeader(header);
  return {
    id: parsed.id,
    realm: parsed.realm,
    method: parsed.method,
    intent: parsed.intent,
    expires: parsed.expires,
    request: { ...parsed.request, ...overrides },
  };
}

function routerFetch(status = 200, body = fixture.response) {
  const calls = [];
  const fetchWithPayment = async (target, init) => {
    calls.push({ url: target, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  fetchWithPayment.calls = calls;
  return fetchWithPayment;
}

function received(challenge, input = url) {
  return {
    challenge,
    input,
    init: { method: "GET" },
    response: new Response("Payment required", { status: 402, headers: { "www-authenticate": header } }),
  };
}

function makeGuard(extra = {}) {
  return mppGuard({
    fetchWithPayment: routerFetch(),
    trustedLogVkey: fixture.trusted_vkey,
    maxCallAmountAtomic: "1000",
    // The fixture evidence was recorded with the lab-only merchant_profile field.
    requestFor: () => fixture.request,
    now: fixture.now,
    ...extra,
  });
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof MppGuardError, `expected MppGuardError, got ${error && error.constructor.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

test("parseChallengeHeader decodes the Payment challenge like mppx does", () => {
  const [parsed] = parseChallengeHeader(header);
  assert.equal(parsed.id, "base-native-synthetic");
  assert.equal(parsed.realm, "merchant.example");
  assert.equal(parsed.method, "evm");
  assert.equal(parsed.intent, "charge");
  assert.equal(parsed.expires, "2026-09-08T17:01:00.000Z");
  assert.equal(parsed.request.amount, "1000");
  assert.equal(parsed.request.recipient, "0x1111111111111111111111111111111111111111");
  assert.equal(parsed.request.methodDetails.chainId, 8453);
  assert.ok(parsed.raw.startsWith("Payment id="));
  assert.throws(() => parseChallengeHeader("Basic realm=\"x\""));
});

test("challengeTerms, defaultLimits and defaultRequest derive the hosted check from the challenge and the buyer cap", () => {
  const challenge = liveChallenge();
  assert.deepEqual(challengeTerms(challenge), {
    realm: "merchant.example",
    method: "evm",
    intent: "charge",
    amount: "1000",
    currency: BASE_USDC,
    recipient: "0x1111111111111111111111111111111111111111",
    chainId: 8453,
  });
  const limits = defaultLimits(challenge, "1000");
  assert.deepEqual(limits, fixture.request.buyer_limits);
  assert.equal(limits.network, BASE_NETWORK);
  const { merchant_profile, ...expected } = fixture.request;
  assert.deepEqual(defaultRequest(url, limits), expected);
  assert.equal(defaultLimits(liveChallenge({ currency: "0x000000000000000000000000000000000000dead" }), "1000"), null);
  assert.equal(defaultLimits({ ...liveChallenge(), method: "tempo" }, "1000"), null);
  assert.equal(defaultLimits({ ...liveChallenge(), intent: "session" }, "1000"), null);
  assert.equal(defaultLimits(liveChallenge(), "0"), null);
  assert.equal(defaultLimits(liveChallenge(), "12.5"), null);
});

test("sameTerms compares the live challenge with the verified terms on economic fields only", () => {
  const terms = fixture.response.batch_terms;
  assert.equal(sameTerms(terms, liveChallenge()), true);
  assert.equal(sameTerms(terms, { ...liveChallenge(), id: "another-id", expires: "2027-01-01T00:00:00.000Z" }), true);
  assert.equal(sameTerms(terms, liveChallenge({ amount: "1001" })), false);
  assert.equal(sameTerms(terms, liveChallenge({ recipient: "0x2222222222222222222222222222222222222222" })), false);
  assert.equal(sameTerms(terms, liveChallenge({ currency: "0x000000000000000000000000000000000000dead" })), false);
  assert.equal(sameTerms(terms, liveChallenge({ methodDetails: { chainId: 1 } })), false);
  assert.equal(sameTerms(terms, { ...liveChallenge(), intent: "session" }), false);
  assert.equal(sameTerms(null, liveChallenge()), false);
});

test("the observer records the URL and onChallenge lets a verified, matching payment through", async () => {
  const fetchWithPayment = routerFetch();
  const results = [];
  const guard = makeGuard({ fetchWithPayment, onResult: (result) => results.push(result) });
  const challenge = liveChallenge();
  assert.equal(guard.onChallengeReceived(received(challenge)), undefined);
  assert.equal(await guard.onChallenge(challenge, { createCredential: async () => "unused" }), undefined);
  assert.equal(fetchWithPayment.calls.length, 1);
  assert.equal(fetchWithPayment.calls[0].url, ROUTER);
  assert.equal(fetchWithPayment.calls[0].init.method, "POST");
  assert.equal(fetchWithPayment.calls[0].init.redirect, "error");
  assert.equal(fetchWithPayment.calls[0].init.body, JSON.stringify(fixture.request));
  assert.equal(results.length, 1);
  assert.equal(results[0].aborted, null);
  assert.equal(results[0].skipped, null);
  assert.equal(results[0].verified.profile, "base-mpp-charge-v1");
  assert.equal(results[0].verified.request.url, url);
  assert.equal(results[0].text, JSON.stringify(fixture.response));
});

test("the default request sends the buyer caps derived from the challenge", async () => {
  const fetchWithPayment = routerFetch();
  const guard = mppGuard({ fetchWithPayment, trustedLogVkey: fixture.trusted_vkey, maxCallAmountAtomic: "1000", now: fixture.now });
  const challenge = liveChallenge();
  guard.onChallengeReceived(received(challenge, url));
  // The fixture evidence carries merchant_profile, so verification of this
  // request must fail on the request binding, never on the sent shape.
  await rejectsWith(guard.onChallenge(challenge), "mpp_guard_verification_failed");
  const { merchant_profile, ...expected } = fixture.request;
  assert.deepEqual(JSON.parse(fetchWithPayment.calls[0].init.body), expected);

  // A string URL is bound byte for byte; a URL object contributes its href.
  const asObject = mppGuard({ fetchWithPayment: routerFetch(), trustedLogVkey: fixture.trusted_vkey, maxCallAmountAtomic: "1000", now: fixture.now });
  const other = { ...challenge, id: "object-input" };
  asObject.onChallengeReceived(received(other, new URL("https://merchant.example/api?x=1")));
  const sent = [];
  const probe = mppGuard({
    fetchWithPayment: async (target, init) => { sent.push(JSON.parse(init.body).url); return new Response("{}", { status: 503 }); },
    trustedLogVkey: fixture.trusted_vkey, maxCallAmountAtomic: "1000", onMiss: "allow",
  });
  probe.onChallengeReceived(received(other, new URL("https://merchant.example/api?x=1")));
  await probe.onChallenge(other);
  assert.deepEqual(sent, ["https://merchant.example/api?x=1"]);
});

test("a changed price or recipient in the live challenge aborts after a valid check", async () => {
  for (const overrides of [{ amount: "1001" }, { recipient: "0x2222222222222222222222222222222222222222" }]) {
    const guard = makeGuard();
    const challenge = liveChallenge(overrides);
    guard.onChallengeReceived(received(challenge));
    await rejectsWith(guard.onChallenge(challenge), "mpp_guard_terms_changed");
  }
});

test("a miss aborts by default and is advisory with onMiss allow", async () => {
  const miss = { ...fixture.response, live: false, payable: false, miss_reason: "no_candidates", batch_binding: undefined, pq_trust: undefined };
  const challenge = liveChallenge();
  const strict = makeGuard({ fetchWithPayment: routerFetch(200, miss) });
  strict.onChallengeReceived(received(challenge));
  await rejectsWith(strict.onChallenge(challenge), "mpp_guard_no_qualifying_offer");

  const results = [];
  const lenient = makeGuard({ fetchWithPayment: routerFetch(200, miss), onMiss: "allow", onResult: (r) => results.push(r) });
  lenient.onChallengeReceived(received(challenge));
  assert.equal(await lenient.onChallenge(challenge), undefined);
  assert.match(results[0].skipped, /no_candidates/);

  const busy = makeGuard({ fetchWithPayment: routerFetch(503, { error: "server busy" }) });
  busy.onChallengeReceived(received(challenge));
  await rejectsWith(busy.onChallenge(challenge), "mpp_guard_no_qualifying_offer");
});

test("challenges the router cannot observe abort by default and pass with onUnsupported allow", async () => {
  const tempo = { ...liveChallenge(), method: "tempo", request: { amount: "1000", currency: "0x20c0000000000000000000000000000000000001", recipient: "0x1111111111111111111111111111111111111111" } };
  const strict = mppGuard({ fetchWithPayment: routerFetch(), trustedLogVkey: fixture.trusted_vkey, maxCallAmountAtomic: "1000" });
  strict.onChallengeReceived(received(tempo));
  await rejectsWith(strict.onChallenge(tempo), "mpp_guard_unsupported_challenge");

  const fetchWithPayment = routerFetch();
  const lenient = mppGuard({ fetchWithPayment, trustedLogVkey: fixture.trusted_vkey, maxCallAmountAtomic: "1000", onUnsupported: "allow" });
  lenient.onChallengeReceived(received(tempo));
  assert.equal(await lenient.onChallenge(tempo), undefined);
  assert.equal(fetchWithPayment.calls.length, 0);
});

test("an unknown challenge id needs urlFor, and 402Signal's own fee challenge is never checked", async () => {
  const challenge = liveChallenge();
  const bare = makeGuard();
  await rejectsWith(bare.onChallenge(challenge), "mpp_guard_url_unknown");

  const withUrl = makeGuard({ urlFor: () => url });
  assert.equal(await withUrl.onChallenge(challenge), undefined);

  const fetchWithPayment = routerFetch();
  const guard = makeGuard({ fetchWithPayment });
  guard.onChallengeReceived(received({ ...challenge, id: "fee-challenge" }, ROUTER));
  assert.equal(await guard.onChallenge({ ...challenge, id: "fee-challenge" }), undefined);
  assert.equal(fetchWithPayment.calls.length, 0);
});

test("a tampered check response fails verification and aborts", async () => {
  const tampered = JSON.parse(JSON.stringify(fixture.response));
  tampered.batch_binding.terms.per_call_amount_atomic = "1";
  tampered.batch_terms.per_call_amount_atomic = "1";
  const guard = makeGuard({ fetchWithPayment: routerFetch(200, tampered) });
  const challenge = liveChallenge();
  guard.onChallengeReceived(received(challenge));
  await rejectsWith(guard.onChallenge(challenge), "mpp_guard_verification_failed");

  const broken = makeGuard({ fetchWithPayment: routerFetch(200, "{not json") });
  broken.onChallengeReceived(received(challenge));
  await rejectsWith(broken.onChallenge(challenge), "mpp_guard_check_failed");
});

test("check() works without mppx and options are validated", async () => {
  const guard = makeGuard();
  const outcome = await guard.check(url, liveChallenge());
  assert.equal(outcome.verified.profile, "base-mpp-charge-v1");
  assert.throws(() => mppGuard({ trustedLogVkey: "k", maxCallAmountAtomic: "1" }), /fetchWithPayment/);
  assert.throws(() => mppGuard({ fetchWithPayment: async () => new Response(""), maxCallAmountAtomic: "1" }), /trustedLogVkey/);
  assert.throws(() => mppGuard({ fetchWithPayment: async () => new Response(""), trustedLogVkey: "k" }), /maxCallAmountAtomic/);
  assert.throws(() => mppGuard({ fetchWithPayment: async () => new Response(""), trustedLogVkey: "k", maxCallAmountAtomic: "1", onMiss: "maybe" }), /onMiss/);
  assert.throws(() => mppGuard({ fetchWithPayment: async () => new Response(""), trustedLogVkey: "k", maxCallAmountAtomic: "1", router: "http://example.com/route" }), /https/);
});
