// The browser verifier must agree with the conformance fixture and fail closed on tampering.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { canonical, verifyReceipt, verifyRouteReceipt, ReceiptError } from "../../live402/static/verify.js";

const fixture = JSON.parse(fs.readFileSync(new URL("../../tests/fixtures/route-binding-v1.json", import.meta.url)));
const vkey = fixture.trusted_vkey;
const clone = (value) => JSON.parse(JSON.stringify(value));

test("every conformance case verifies in the browser verifier", async () => {
  for (const item of fixture.cases) {
    const out = await verifyRouteReceipt(item.response, vkey);
    assert.equal(out.origin, "402signal.com/pq/log");
    assert.equal(out.eventVersion, "402signal.route_decision.v4");
    assert.equal(out.index, item.response.pq_trust.transparency.receipt.index);
    assert.equal(out.evidence.binding.request.url, item.response.url);
  }
});

test("the receipt alone verifies signature and inclusion", async () => {
  const receipt = fixture.cases[0].response.pq_trust.transparency.receipt;
  const out = await verifyReceipt(receipt, vkey);
  assert.equal(out.treeSize, 1);
  assert.equal(out.leafHash, receipt.leaf_hash);
});

test("tampering fails closed with a typed code", async () => {
  const base = fixture.cases[0].response;
  const mutations = {
    leaf_hash_mismatch: (tr) => { tr.receipt.leaf_hash = "00".repeat(32); },
    corrupt_proof: (tr) => { tr.receipt.index = 1; },
    checkpoint_signature_failed: (tr) => { tr.receipt.checkpoint = tr.receipt.checkpoint.replace("bMKV", "cMKV"); },
    reveal_mismatch: (tr) => { tr.reveal.evidence.binding.selected_index = 1; },
    invalid_reveal: (tr) => { tr.reveal.extra = 1; },
    unsupported_event_version: (tr) => { tr.reveal.event_version = "402signal.route_decision.v3"; tr.reveal.type = "402signal.route_decision.v3"; },
  };
  for (const [code, mutate] of Object.entries(mutations)) {
    const copy = clone(base);
    mutate(copy.pq_trust.transparency);
    // A corrupted signature blob may also break its embedded key id; both refusals are correct.
    const accepted = code === "checkpoint_signature_failed" ? new Set([code, "no_signature_from_trusted_key"]) : new Set([code]);
    await assert.rejects(verifyRouteReceipt(copy, vkey), (error) => error instanceof ReceiptError && accepted.has(error.code), code);
  }
  await assert.rejects(verifyRouteReceipt(base, ""), (e) => e.code === "untrusted_log_origin");
  const renamed = "evil.example/log" + vkey.slice("402signal.com/pq/log".length);
  await assert.rejects(verifyRouteReceipt(base, renamed), (e) => e.code === "invalid_vkey" || e.code === "no_signature_from_trusted_key" || e.code === "untrusted_log_origin");
});

test("canonical JSON matches RFC 8785 for the shapes the log uses", () => {
  assert.equal(canonical({ b: 1, a: "x", c: [true, null, 2.5] }), '{"a":"x","b":1,"c":[true,null,2.5]}');
  assert.equal(canonical({ "é": "ü" }), '{"é":"ü"}');
  assert.throws(() => canonical({ n: Infinity }));
});
