import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { verifyBatchRoute, withVerifiedBatchRoute } from "../batch.mjs";
const fixtures = JSON.parse(
  fs.readFileSync(
    new URL("../../../tests/fixtures/batch-route-v5.json", import.meta.url),
  ),
);
fixtures.push(
  JSON.parse(
    fs.readFileSync(
      new URL(
        "../../../tests/fixtures/algorand-generic-v5.json",
        import.meta.url,
      ),
    ),
  ),
);
const options = (v) => ({
  routeResponseJson: JSON.stringify(v.response),
  routeRequestJson: JSON.stringify(v.request),
  trustedLogVkey: v.trusted_vkey,
  challenge: v.challenge,
  now: v.now,
});
for (const fixture of fixtures) {
  const profile = fixture.request.merchant_profile;
  test(
    profile + " independently verifies Python v5 proof before callback",
    async () => {
      let calls = 0;
      const result = await withVerifiedBatchRoute(options(fixture), (v) => {
        calls++;
        return v;
      });
      assert.equal(calls, 1);
      assert.equal(result.profile, profile);
      assert.equal(result.request.method, "GET");
      assert.deepEqual(result.buyer_limits, fixture.request.buyer_limits);
    },
  );
  test(
    profile +
      " every private binding member and public proof mutation blocks callback",
    async () => {
      const mutations = [
        (v) => (v.response.batch_binding.terms = {}),
        (v) => (v.response.batch_terms = {}),
        (v) => (v.response.live = false),
        (v) => (v.response.selected_payment = {}),
        (v) =>
          v.response.pq_trust.transparency.reveal.evidence.batch_binding
            .observed_at--,
        (v) =>
          v.response.pq_trust.transparency.reveal.evidence.batch_binding
            .expires_at++,
        (v) =>
          (v.response.pq_trust.transparency.reveal.evidence.batch_binding.buyer_limits =
            {}),
        (v) =>
          (v.response.pq_trust.transparency.reveal.evidence.batch_binding.request.method =
            "POST"),
        (v) =>
          (v.response.pq_trust.transparency.reveal.evidence.batch_binding.request.body_sha256 =
            "00".repeat(32)),
        (v) =>
          (v.response.pq_trust.transparency.reveal.evidence.batch_binding.challenge.bodyText +=
            " "),
        (v) => (v.response.pq_trust.transparency.reveal.salt = "00".repeat(32)),
        (v) => (v.response.pq_trust.transparency.receipt.index = true),
        (v) =>
          (v.response.pq_trust.transparency.receipt.leaf_hash = "00".repeat(
            32,
          )),
        (v) =>
          (v.response.pq_trust.transparency.receipt.checkpoint =
            v.response.pq_trust.transparency.receipt.checkpoint.replace(
              "— ",
              "— wrong",
            )),
        (v) => (v.request.url += "?other=1"),
        (v) =>
          (v.request.url = v.request.url.replace("https://", "https://wrong.")),
        (v) => (v.request.buyer_limits = {}),
        (v) => (v.challenge.bodyText += " "),
        (v) => (v.challenge.status = 200),
        (v) => (v.trusted_vkey = ""),
        (v) => (v.now = v.response.batch_binding.expires_at),
        (v) => v.now--,
      ];
      for (const mutate of mutations) {
        const v = structuredClone(fixture);
        mutate(v);
        let calls = 0;
        await assert.rejects(() =>
          withVerifiedBatchRoute(options(v), () => calls++),
        );
        assert.equal(calls, 0);
      }
    },
  );
  test(
    profile +
      " repeated JSON, query mutations and profile confusion fail closed",
    () => {
      const opts = options(fixture);
      assert.throws(() =>
        verifyBatchRoute({
          ...opts,
          routeRequestJson: ('{"merchant_profile":null,' + opts.routeRequestJson.slice(1)),
        }),
      );
      for (const change of [
        "?left=alpha&right=beta",
        "?right=beta&left=alpha",
        "?left=%61lpha&right=beta",
        "?left=other&right=beta",
        "/other",
      ]) {
        const v = structuredClone(fixture);
        v.request.url = v.request.url.split("?")[0] + change;
        if (v.request.url !== fixture.request.url)
          assert.throws(() => verifyBatchRoute(options(v)));
      }
      const v = structuredClone(fixture);
      v.request.merchant_profile = "exact-v4";
      assert.throws(() => verifyBatchRoute(options(v)));
    },
  );
}
test("native Solana cap remains explicitly non-price and original blockhash is retained", () => {
  const v = verifyBatchRoute(options(fixtures[1]));
  assert.equal(v.terms.per_call_amount_atomic, null);
  assert.equal(v.terms.session_cap_atomic, "10000");
  assert.equal(v.expires_at, fixtures[1].now + 40);
  assert.equal(v.terms.recent_blockhash, "11111111111111111111111111111111");
});

test("exact URL parity: default443, empty query, percent encoding and ordering", () => {
  const vectors = JSON.parse(
    fs.readFileSync(
      new URL(
        "../../../tests/fixtures/batch-url-parity-v5.json",
        import.meta.url,
      ),
    ),
  );
  for (const v of vectors) {
    assert.equal(verifyBatchRoute(options(v)).request.url, v.request.url);
    for (const url of [
      v.request.url + "&extra=1",
      v.request.url.replace("merchant.example", "merchant.example:444"),
      "https://merchant.example:65536/batch",
      "https://merchant.example:bad/batch",
    ]) {
      const bad = structuredClone(v);
      bad.request.url = url;
      assert.throws(() => verifyBatchRoute(options(bad)));
    }
  }
});

test("generic Algorand dynamic item and total caps, job pins and sponsor threshold", async () => {
  const { validateAlgorandGenericProfile } = await import(
    "../batch-profiles/algorand-generic.mjs"
  );
  const v = fixtures[3],
    env = JSON.parse(v.challenge.bodyText),
    ctx = v.response.batch_binding.request,
    l = v.request.buyer_limits;
  assert.equal(validateAlgorandGenericProfile(env, ctx, l).totalAmount, "3000");
  for (const changes of [
    { max_item_amount_atomic: "1499" },
    { max_total_amount_atomic: "2999" },
    { max_sponsor_fee_micro_algo: "14999" },
    { job_hashes: [...l.job_hashes].reverse() },
  ])
    assert.throws(() =>
      validateAlgorandGenericProfile(env, ctx, { ...l, ...changes }),
    );
  for (const [key, value] of [
    ["itemAmount", "1000"],
    ["totalAmount", "1500"],
    ["paymentIndices", [2, 1]],
    ["sponsorIndex", 1],
    ["requestHash", "00".repeat(32)],
  ]) {
    const bad = structuredClone(env);
    bad.extensions["402signal-atomic-batch"][key] = value;
    assert.throws(() => validateAlgorandGenericProfile(bad, ctx, l));
  }
  const bad = structuredClone(env);
  bad.accepts[0].amount = String(2n ** 64n - 1n);
  assert.throws(() => validateAlgorandGenericProfile(bad, ctx, l));
});

test("bounded observational metadata counts UTF8 bytes in Python and JS profiles", async () => {
  const { validateBaseBatchProfile } = await import(
    "../batch-profiles/base.mjs"
  );
  const { validateAlgorandGenericProfile } = await import(
    "../batch-profiles/algorand-generic.mjs"
  );
  for (const [index, validate] of [
    [0, validateBaseBatchProfile],
    [3, validateAlgorandGenericProfile],
  ]) {
    const v = fixtures[index],
      e = JSON.parse(v.challenge.bodyText);
    e.resource.description = "é".repeat(2048);
    validate(e, v.response.batch_binding.request, v.request.buyer_limits);
    e.resource.description += "é";
    assert.throws(() =>
      validate(e, v.response.batch_binding.request, v.request.buyer_limits),
    );
  }
});
