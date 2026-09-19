import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  RouteGuardError,
  isUnsettledRouteMiss,
  verifyRoute,
  withVerifiedRoute,
} from "../index.mjs";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../tests/fixtures/route-binding-v1.json", import.meta.url),
  ),
);
const cases = [...fixture.cases, ...fixture.historical_inclusions];
const encode = (object) => JSON.stringify(object);
const clone = (object) => structuredClone(object);
function options(c = cases[0]) {
  return {
    routeResponseJson: encode(c.response),
    routeRequestJson: encode(c.request),
    trustedLogVkey: fixture.trusted_vkey,
    request: {
      url: c.response.url,
      method: c.method,
      body: Buffer.from(c.body),
    },
    challenge: { status: 402, bodyText: encode(c.challenge) },
    now: c.now,
  };
}
function rejected(o, code) {
  let called = 0;
  assert.throws(
    () =>
      withVerifiedRoute(o, () => {
        called++;
      }),
    (e) => {
      assert.ok(e instanceof RouteGuardError);
      if (code) assert.equal(e.code, code);
      return true;
    },
  );
  assert.equal(called, 0, "no buyer callback on a rejected proof");
}
function changeResponse(o, edit) {
  const r = JSON.parse(o.routeResponseJson);
  edit(r);
  o.routeResponseJson = encode(r);
}

for (const [i, c] of cases.entries()) {
  test(`Python signed fixture ${i}: ${c.rail}, ${c.method}, index ${c.response.pq_trust.transparency.receipt.index}`, () => {
    const actual = verifyRoute(options(c));
    assert.deepEqual(actual.accepted, c.challenge.accepts[0]);
    assert.equal(actual.request.url, c.response.url);
    assert.equal(actual.model, "proof_carrying_route_v1");
    assert.equal(actual.expires_at, c.response.decision_binding.expires_at);
  });
}

test("all economic terms and the whole envelope are binding on every rail", () => {
  for (const c of cases.slice(0, 3)) {
    const changes = {
      amount: "999999",
      payTo: "different-recipient",
      network: "different-chain",
      asset: "different-token",
      currency: "different-token",
      scheme: "upto",
      maxTimeoutSeconds: 600,
      extra: { feePayer: "different-fee-payer" },
    };
    for (const [key, value] of Object.entries(changes)) {
      const o = options(c),
        env = clone(c.challenge);
      env.accepts[0][key] = value;
      o.challenge.bodyText = encode(env);
      rejected(o);
    }
    for (const change of [
      { error: "different-message" },
      { accepts: [...c.challenge.accepts, ...c.challenge.accepts] },
      { resource: { url: c.response.url + "?other=1" } },
      { extensions: { "unknown-spend-extension": {} } },
      { x402Version: 1 },
    ]) {
      const o = options(c);
      o.challenge.bodyText = encode({ ...c.challenge, ...change });
      rejected(o);
    }
  }
});

test("resource, method, body and actual HTTP status must match", () => {
  for (const change of [
    { url: cases[0].response.url + "?x=1" },
    { url: "http://example.com/api" },
    { url: "https://user:password@example.com/api" },
    { url: "https://example.com/api#part" },
    { method: "POST" },
    { method: "DELETE" },
    { body: Buffer.from("other") },
  ]) {
    const o = options();
    Object.assign(o.request, change);
    rejected(o);
  }
  for (const status of [200, "402", 503]) {
    const o = options();
    o.challenge.status = status;
    rejected(o, "not_402");
  }
  const o = options(cases[3]);
  o.request.body = Buffer.from("{ }");
  rejected(o, "resource_changed");
});

test("expiry is original observation time, never reset by replay or human approval", () => {
  const b = cases[0].response.decision_binding;
  verifyRoute({ ...options(), now: b.expires_at - 1 });
  for (const now of [
    b.observed_at - 1,
    b.expires_at,
    b.expires_at + 1000,
    NaN,
    Infinity,
    "1",
  ]) {
    rejected({ ...options(), now }, "quote_expired");
  }
  const o = options();
  changeResponse(o, (r) => {
    r.decision_binding.expires_at += 60;
  });
  rejected(o, "binding_mismatch");
});

test("signatures, pinning, origin, reveal, commitment and inclusion reject tampering", () => {
  for (const edit of [
    (r) => {
      r.pq_trust.transparency.reveal.salt = "ff".repeat(32);
    },
    (r) => {
      r.pq_trust.transparency.reveal.commitment = "00".repeat(32);
    },
    (r) => {
      r.pq_trust.transparency.reveal.nonce = "00".repeat(32);
    },
    (r) => {
      r.pq_trust.transparency.reveal.evidence.request_json = '{"need":"other"}';
    },
    (r) => {
      r.pq_trust.transparency.reveal.evidence.binding.observed_at += 1;
    },
    (r) => {
      r.pq_trust.transparency.reveal.evidence.extra = "unreviewed";
    },
    (r) => {
      r.pq_trust.transparency.receipt.leaf_hash = "00".repeat(32);
    },
    (r) => {
      r.pq_trust.transparency.receipt.index = true;
    },
    (r) => {
      r.pq_trust.transparency.receipt.index = -1;
    },
    (r) => {
      r.pq_trust.transparency.receipt.index = 100;
    },
    (r) => {
      r.pq_trust.transparency.receipt.inclusion_path.push(
        Buffer.alloc(32).toString("base64"),
      );
    },
    (r) => {
      r.pq_trust.transparency.receipt.checkpoint =
        r.pq_trust.transparency.receipt.checkpoint.replace(
          /\n[1-9][0-9]*\n/,
          "\n999\n",
        );
    },
    (r) => {
      r.pq_trust.transparency.receipt.checkpoint =
        "other-origin\n" +
        r.pq_trust.transparency.receipt.checkpoint
          .split("\n")
          .slice(1)
          .join("\n");
    },
    (r) => {
      r.pq_trust.transparency.reveal.event_version =
        "402signal.route_decision.v3";
    },
  ]) {
    const o = options();
    changeResponse(o, edit);
    rejected(o);
  }
  for (const trustedLogVkey of [
    "",
    undefined,
    fixture.trusted_vkey.replace(/\+[0-9a-f]{8}\+/, "+00000000+"),
  ]) {
    rejected({ ...options(), trustedLogVkey });
  }
  // A non-last leaf under a later checkpoint has a multi-element path.
  const o = options(fixture.historical_inclusions[0]);
  assert.ok(o.routeResponseJson.includes('"inclusion_path"'));
  changeResponse(o, (r) => {
    assert.ok(r.pq_trust.transparency.receipt.inclusion_path.length >= 2);
    r.pq_trust.transparency.receipt.inclusion_path.reverse();
  });
  rejected(o, "invalid_inclusion");
});

test("caller policy is bound and booleans are never coerced to numeric constraints", () => {
  for (const request of [
    { ...cases[0].request, need: "other" },
    { ...cases[0].request, max_price_usd: true },
    { ...cases[0].request, networks: ["algorand"] },
    { ...cases[0].request, require_route_binding: false },
  ])
    rejected(
      { ...options(), routeRequestJson: encode(request) },
      "request_mismatch",
    );
  verifyRoute({
    ...options(),
    routeRequestJson:
      '{"max_price_usd":2e-2,"require_route_binding":true,"need":"weather"}',
  });
});

test("duplicate keys, unsupported lexical numbers, malformed UTF8 and size/depth limits fail closed", () => {
  for (const raw of [
    '{"x402Version":2,"x402Version":2}',
    '{"x":NaN}',
    '{"x":1e100}',
    '{"x":9007199254740992}',
    '{"x":"\\ud800"}',
    '{"x":0,}',
    "[".repeat(25) + "0" + "]".repeat(25),
    " ".repeat(65537),
    encode(cases[0].challenge).replace(
      '"maxTimeoutSeconds":60',
      '"maxTimeoutSeconds":6e1',
    ),
  ]) {
    const o = options();
    o.challenge.bodyText = raw;
    rejected(o);
  }
  const o = options();
  o.routeResponseJson = '{"extra":1,"extra":2,' + o.routeResponseJson.slice(1);
  rejected(o, "invalid_json");
  const dupPolicy = {
    ...options(),
    routeRequestJson: '{"need":"weather","need":"weather"}',
  };
  rejected(dupPolicy, "invalid_json");
  const utf8 = options();
  utf8.challenge.paymentRequired = Buffer.from([255]).toString("base64");
  rejected(utf8);
});

test("decimal values in a seller challenge bind by value (0.7.4)", () => {
  const c = cases.find(
    (k) => k.challenge.extensions?.bazaar?.info?.output?.example?.price === 67234.12,
  );
  assert.ok(c, "the Python-signed fixture carries the decimal case");
  const verified = verifyRoute(options(c));
  assert.equal(verified.model, "proof_carrying_route_v1");
  assert.deepEqual(verified.accepted, c.challenge.accepts[0]);
  // The lexical form of a number is not part of the quote: 1.0 is 1, 1e-7 is
  // 0.0000001. The server hashes the same bytes for every spelling.
  const spelled = options(c);
  spelled.challenge.bodyText = encode(c.challenge)
    .replace('"supply":1,', '"supply":1.0,')
    .replace('"tick":1e-7', '"tick":0.0000001')
    .replace('"ratio":0.000001', '"ratio":1e-6')
    .replace('"count":42', '"count":42.0');
  assert.notEqual(spelled.challenge.bodyText, encode(c.challenge));
  assert.equal(verifyRoute(spelled).model, "proof_carrying_route_v1");
  // A different value is a different quote.
  const drift = options(c);
  drift.challenge.bodyText = encode(c.challenge).replace(
    '"price":67234.12',
    '"price":67234.13',
  );
  rejected(drift, "quote_changed");
  // Beyond the profile still fails closed.
  for (const raw of [
    '"price":1e400',
    '"price":9007199254740993',
    '"price":9007199254740992.5',
    '"price":NaN',
    '"price":-Infinity',
  ]) {
    const o = options(c);
    o.challenge.bodyText = encode(c.challenge).replace('"price":67234.12', raw);
    rejected(o, "invalid_json");
  }
});

test("HTTP 503 binding_unavailable is a completed unpaid miss; HTTP 200 is not", () => {
  const body = {
    url: "https://seller.example/x",
    live: false,
    payable: false,
    selected_payment: null,
    has_402_challenge: true,
    error: "route_binding_unavailable",
    binding_error: "route_binding_unavailable",
    binding_error_reason: "invalid_json",
    miss_reason: "binding_unavailable",
    stop_reason: "candidate_set_exhausted",
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
  const routeResponseJson = JSON.stringify(body);
  assert.equal(
    isUnsettledRouteMiss({ httpStatus: 503, routeResponseJson, paymentResponseHeader: null }),
    true,
  );
  assert.equal(
    isUnsettledRouteMiss({ httpStatus: 200, routeResponseJson, paymentResponseHeader: null }),
    false,
  );
  assert.equal(
    isUnsettledRouteMiss({ httpStatus: 503, routeResponseJson, paymentResponseHeader: "x" }),
    false,
  );
  const settled = JSON.stringify({ ...body, billing: { ...body.billing, settled: true } });
  assert.equal(
    isUnsettledRouteMiss({ httpStatus: 503, routeResponseJson: settled, paymentResponseHeader: null }),
    false,
  );
});

test("header/body disagreement and malformed companion channels cannot be hidden", () => {
  const o = options();
  o.challenge.paymentRequired = Buffer.from(o.challenge.bodyText).toString(
    "base64",
  );
  verifyRoute(o);
  verifyRoute({
    ...o,
    challenge: { status: 402, paymentRequired: o.challenge.paymentRequired },
  });
  for (const change of [
    { xPaymentRequired: Buffer.from('{"x402Version":1}').toString("base64") },
    { bodyText: "not-json" },
    { paymentRequired: "" },
    { paymentRequired: o.challenge.paymentRequired + "=" },
  ])
    rejected({ ...o, challenge: { ...o.challenge, ...change } });
});

test("uncommitted display fields never control the callback terms", () => {
  const o = options();
  changeResponse(o, (r) => {
    r.selected_payment = { payTo: "attacker", amount: "999999" };
    r.envelope = { accepts: [{ payTo: "attacker" }] };
    r.score = 1e3;
  });
  assert.deepEqual(verifyRoute(o).accepted, cases[0].challenge.accepts[0]);
});

test("valid handoff is detached, deeply frozen and does not retry the caller", async () => {
  let calls = 0;
  const o = options();
  const value = await withVerifiedRoute(o, async (action) => {
    calls++;
    assert.ok(Object.isFrozen(action));
    assert.ok(Object.isFrozen(action.request));
    assert.ok(Object.isFrozen(action.accepted));
    assert.throws(() => {
      action.accepted.payTo = "attacker";
    }, TypeError);
    return "caller-owned-result";
  });
  assert.equal(value, "caller-owned-result");
  assert.equal(calls, 1);
  assert.throws(
    () =>
      withVerifiedRoute(o, () => {
        calls++;
        throw new Error("caller failure");
      }),
    /caller failure/,
  );
  assert.equal(calls, 2);
});

test("errors contain only coarse codes and never echo payment or seller data", () => {
  const sentinel = "PRIVATE_PAYMENT_MATERIAL_NEVER_LOG";
  const o = options();
  o.challenge.bodyText = sentinel;
  try {
    verifyRoute(o);
    assert.fail();
  } catch (e) {
    assert.ok(e instanceof RouteGuardError);
    assert.ok(!e.message.includes(sentinel));
    assert.deepEqual(Object.keys(e).sort(), ["code", "name"]);
  }
});
