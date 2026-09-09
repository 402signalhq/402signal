import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyReceipt, verifyRoute, RouteGuardError } from "../index.mjs";
import { verifyBatchRoute, RouteGuardError as BatchRouteGuardError } from "../batch.mjs";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../tests/fixtures/route-binding-v1.json", import.meta.url),
  ),
);
const sample = fixture.cases.find((c) => c.rail === "base" && c.method === "GET");
const pin = fixture.trusted_vkey;
const offered = pin.replace(/\+[0-9a-f]{8}\+/, "+00000000+");

function receiptOptions(response, trustedLogVkey) {
  return {
    routeResponseJson: JSON.stringify(response),
    routeRequestJson: JSON.stringify(sample.request),
    trustedLogVkey,
  };
}

function routeOptions(response, trustedLogVkey) {
  return {
    ...receiptOptions(response, trustedLogVkey),
    request: {
      url: sample.response.url,
      method: sample.method,
      body: Buffer.from(sample.body),
    },
    challenge: { status: 402, bodyText: JSON.stringify(sample.challenge) },
    now: sample.now,
  };
}

function withOfferedKey(response, key = offered) {
  const r = structuredClone(response);
  r.vkey = key;
  r.trustedLogVkey = key;
  r.log_vkey = key;
  r.pq_trust.vkey = key;
  r.pq_trust.log_signature = { vkey: key };
  r.pq_trust.transparency.vkey = key;
  r.pq_trust.transparency.trustedLogVkey = key;
  r.pq_trust.transparency.receipt.vkey = key;
  return r;
}

test("pinned key verifies even when the response offers a conflicting key", () => {
  const response = withOfferedKey(sample.response, offered);
  const receipt = verifyReceipt(receiptOptions(response, pin));
  assert.equal(receipt.proof, "signature_and_inclusion_verified");
  const action = verifyRoute(routeOptions(response, pin));
  assert.equal(action.model, "proof_carrying_route_v1");
});

test("response-offered signing key cannot replace a conflicting pin", () => {
  const response = withOfferedKey(sample.response, pin);
  assert.throws(
    () => verifyReceipt(receiptOptions(response, offered)),
    (e) => e instanceof RouteGuardError,
  );
  assert.throws(
    () => verifyRoute(routeOptions(response, offered)),
    (e) => e instanceof RouteGuardError,
  );
});

test("rotation requires an explicit pin update; empty pin does not adopt an offered key", () => {
  const response = withOfferedKey(sample.response, pin);
  for (const trustedLogVkey of ["", "   ", undefined, null]) {
    assert.throws(
      () => verifyReceipt(receiptOptions(response, trustedLogVkey)),
      (e) => e instanceof RouteGuardError,
    );
    assert.throws(
      () => verifyRoute(routeOptions(response, trustedLogVkey)),
      (e) => e instanceof RouteGuardError,
    );
  }
});

test("batch guard keeps the pin when the response offers another key", () => {
  const batch = JSON.parse(
    readFileSync(
      new URL("../../../tests/fixtures/batch-route-v5.json", import.meta.url),
    ),
  )[0];
  const response = withOfferedKey(batch.response, offered);
  const observed = verifyBatchRoute({
    routeResponseJson: JSON.stringify(response),
    routeRequestJson: JSON.stringify(batch.request),
    trustedLogVkey: batch.trusted_vkey,
    challenge: batch.challenge,
    now: batch.now,
  });
  assert.equal(observed.profile, batch.request.merchant_profile);
  assert.throws(
    () =>
      verifyBatchRoute({
        routeResponseJson: JSON.stringify(withOfferedKey(batch.response, batch.trusted_vkey)),
        routeRequestJson: JSON.stringify(batch.request),
        trustedLogVkey: batch.trusted_vkey.replace(/\+[0-9a-f]{8}\+/, "+00000000+"),
        challenge: batch.challenge,
        now: batch.now,
      }),
    (e) => e instanceof BatchRouteGuardError,
  );
});
