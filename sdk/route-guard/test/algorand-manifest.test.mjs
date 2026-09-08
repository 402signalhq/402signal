import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { verifyBatchRoute, withVerifiedBatchRoute } from "../batch.mjs";
import { validateAlgorandManifestProfile } from "../batch-profiles/algorand-manifest.mjs";
const cases = JSON.parse(
  fs.readFileSync(
    new URL(
      "../../../tests/fixtures/algorand-manifest-v2.json",
      import.meta.url,
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
for (const v of cases) {
  test(
    v.request.merchant_profile +
      " jobs=" +
      v.request.buyer_limits.job_hashes.length +
      " independently verifies Python proof",
    () => {
      const out = verifyBatchRoute(options(v));
      assert.equal(out.profile, v.request.merchant_profile);
      assert.equal(out.expires_at, v.now + 45);
      assert.equal(
        out.terms.jobCount,
        v.request.buyer_limits.job_hashes.length,
      );
      assert(Buffer.byteLength(JSON.stringify(v.response)) <= 65536);
    },
  );
}
test("every new profile refuses term, ordering, fee quote, resource, cap and receipt mutations before callback", async () => {
  for (const source of [cases[2], cases.at(-1)]) {
    for (const change of [
      (v) => v.request.buyer_limits.job_hashes.reverse(),
      (v) => (v.request.buyer_limits.max_total_amount_atomic = "1"),
      (v) => (v.request.buyer_limits.max_sponsor_fee_micro_algo = "1000"),
      (v) => (v.request.url += "&new=1"),
      (v) => v.response.batch_terms.paymentCount++,
      (v) =>
        (v.response.batch_binding.terms.feeQuote.sponsorFeeMicroAlgo = "1000"),
      (v) => v.response.batch_binding.expires_at++,
      (v) => (v.now += 45),
      (v) => (v.challenge.paymentRequired += "="),
      (v) => (v.request.buyer_limits.max_item_amount_atomic = "1000"),
    ]) {
      const v = structuredClone(source);
      change(v);
      if (JSON.stringify(v) === JSON.stringify(source)) continue;
      let calls = 0;
      await assert.rejects(withVerifiedBatchRoute(options(v), () => calls++));
      assert.equal(calls, 0);
    }
  }
});
test("quote parity rejects every network, count, fee, expiry and manifest contradiction", () => {
  for (const v of cases) {
    const e = JSON.parse(
        Buffer.from(v.challenge.paymentRequired, "base64").toString(),
      ),
      ctx = v.response.batch_binding.request,
      l = v.request.buyer_limits,
      p = v.request.merchant_profile;
    validateAlgorandManifestProfile(e, ctx, l, p);
    for (const [field, value] of [
      ["transactionCount", 1],
      ["genesisId", "testnet-v1.0"],
      ["minFeeMicroAlgo", "999"],
      ["feePerByteMicroAlgo", "1"],
      ["sponsorFeeMicroAlgo", "99999"],
      ["expiresAt", v.now + 61],
      ["firstValid", "00"],
      ["lastValid", "999999999"],
    ]) {
      const bad = structuredClone(e);
      bad.extensions["402signal-atomic-batch"].feeQuote[field] = value;
      assert.throws(() => validateAlgorandManifestProfile(bad, ctx, l, p));
    }
    assert.equal(
      e.extensions["402signal-atomic-batch"].perJobAmount,
      p === "algorand-aggregate-invoice-v1" ? null : "1000",
    );
  }
});
