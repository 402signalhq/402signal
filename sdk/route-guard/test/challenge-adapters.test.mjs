import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {verifyRoute, withVerifiedRoute, RouteGuardError} from "../index.mjs";

const f = JSON.parse(
  readFileSync(new URL("../../../tests/fixtures/route-binding-get.json", import.meta.url)),
);

function options() {
  return {
    routeResponseJson: JSON.stringify(f.response),
    routeRequestJson: JSON.stringify(f.request),
    trustedLogVkey: f.trusted_vkey,
    request: {url: f.response.url, method: "GET", body: new Uint8Array()},
    challenge: {status: 402, bodyText: JSON.stringify(f.challenge)},
    now: f.now,
  };
}

function reject(o, code) {
  let calls = 0;
  assert.throws(
    () =>
      withVerifiedRoute(o, () => {
        calls++;
      }),
    (e) => e instanceof RouteGuardError && (!code || e.code === code),
  );
  assert.equal(calls, 0);
}

function header(env) {
  return Buffer.from(JSON.stringify(env)).toString("base64");
}

test("nested payment_required and catalog extras verify when the extracted challenge matches", () => {
  const o = options();
  const env = f.challenge;
  o.challenge.paymentRequired = header(env);
  o.challenge.bodyText = JSON.stringify({
    error: "payment_required",
    payment_required: env,
    catalog: {docs: "https://example.com/docs"},
  });
  const result = verifyRoute(o);
  assert.deepEqual(result.accepted, env.accepts[0]);
});

test("x402 wrapper and matching paymentRequirements alias project to the header", () => {
  const o = options();
  const env = f.challenge;
  o.challenge.paymentRequired = header(env);
  o.challenge.bodyText = JSON.stringify({
    error: {code: "PAYMENT_REQUIRED"},
    x402: {...env, paymentRequirements: env.accepts},
  });
  verifyRoute(o);
});

test("header/body accept-term disagreement stays ambiguous", () => {
  const o = options();
  o.challenge.paymentRequired = header(f.challenge);
  const body = structuredClone(f.challenge);
  body.accepts[0] = {...body.accepts[0], outputSchema: {type: "object"}};
  o.challenge.bodyText = JSON.stringify(body);
  reject(o, "ambiguous_challenge");
});

test("disagreeing paymentRequirements alias fails closed", () => {
  const o = options();
  const body = {...f.challenge, paymentRequirements: [{...f.challenge.accepts[0], amount: "1"}]};
  o.challenge.bodyText = JSON.stringify(body);
  reject(o, "ambiguous_challenge");
});

test("known extensions and outputSchema remain in the hashed challenge", () => {
  const o = options();
  const env = structuredClone(f.challenge);
  env.extensions = {
    bazaar: env.extensions?.bazaar || {},
    "builder-code": {info: {a: "app_one"}},
    "payment-identifier": {info: {required: false}},
  };
  env.accepts[0] = {...env.accepts[0], outputSchema: {type: "object"}};
  env.resource = {...env.resource, iconUrl: "https://example.com/icon"};
  o.challenge.bodyText = JSON.stringify(env);
  reject(o, "quote_changed");
});

test("unknown extensions still fail closed", () => {
  const o = options();
  const env = structuredClone(f.challenge);
  env.extensions = {bazaar: {}, "new-spending-mode": {}};
  o.challenge.bodyText = JSON.stringify(env);
  reject(o, "unsupported_extension");
});
