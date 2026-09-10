#!/usr/bin/env node
/** Verify a packed route-guard archive against signed chk_grp and historical fixtures. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const archive = resolve(
  process.argv[2] || "402signal-route-guard-0.7.2.tgz",
);
const root = resolve(new URL("..", import.meta.url).pathname);
const dir = mkdtempSync(join(tmpdir(), "route-guard-archive-"));
try {
  execFileSync("npm", ["install", "--ignore-scripts", archive], {
    cwd: dir,
    stdio: "pipe",
  });
  const { verifyBatchRoute } = await import(
    pathToFileURL(join(dir, "node_modules/@402signal/route-guard/batch.mjs"))
      .href
  );
  const pkg = JSON.parse(
    readFileSync(
      join(dir, "node_modules/@402signal/route-guard/package.json"),
      "utf8",
    ),
  );
  assert.equal(pkg.version, "0.7.2");
  const options = (v) => ({
    routeResponseJson: JSON.stringify(v.response),
    routeRequestJson: JSON.stringify(v.request),
    trustedLogVkey: v.trusted_vkey,
    challenge: v.challenge,
    now: v.now,
  });
  const chkGrp = JSON.parse(
    readFileSync(join(root, "tests/fixtures/batch-chk-grp-v5.json"), "utf8"),
  );
  const historical = JSON.parse(
    readFileSync(join(root, "tests/fixtures/batch-route-v5.json"), "utf8"),
  );
  const codecs = new Set();
  for (const v of chkGrp) {
    assert.equal(Object.hasOwn(v.request, "merchant_profile"), false);
    const out = verifyBatchRoute(options(v));
    assert.equal(out.profile, v.profile);
    codecs.add(v.codec);
  }
  assert.deepEqual([...codecs].sort(), ["atom", "exact", "inv", "mpp", "sess"]);
  for (const v of historical) {
    assert.ok(v.request.merchant_profile);
    const out = verifyBatchRoute(options(v));
    assert.equal(out.profile, v.request.merchant_profile);
  }
  const drifted = structuredClone(chkGrp[0]);
  drifted.response.codec = "sess";
  assert.throws(() => verifyBatchRoute(options(drifted)));
  console.log(
    JSON.stringify({
      archive,
      version: pkg.version,
      chk_grp: chkGrp.length,
      historical: historical.length,
      codecs: [...codecs].sort(),
    }),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
