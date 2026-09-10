#!/usr/bin/env node
/** Verify a packed route-guard archive, not the source tree.
 *
 * Default: 0.7.2 chk_grp without buyer merchant_profile, historical leaves
 * that still name merchant_profile, and refuse-on-drift.
 * --historical-verifier tests the published 0.7.1 path: historical leaves
 * still verify; current chk_grp requests without merchant_profile fail closed.
 * Archive arguments may be a local tgz or an https:// download URL.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(new URL("..", import.meta.url).pathname);
const arguments_ = process.argv.slice(2);
let candidate = "402signal-route-guard-0.7.2.tgz";
let historical;
const rest = [];
for (let i = 0; i < arguments_.length; i++) {
  if (arguments_[i] === "--historical-verifier") {
    historical = arguments_[++i];
    continue;
  }
  rest.push(arguments_[i]);
}
if (rest.length) candidate = rest[0];

const options = (v) => ({
  routeResponseJson: JSON.stringify(v.response),
  routeRequestJson: JSON.stringify(v.request),
  trustedLogVkey: v.trusted_vkey,
  challenge: v.challenge,
  now: v.now,
});

async function materialize(spec, dir, name) {
  if (spec.startsWith("https://")) {
    const response = await fetch(spec, { redirect: "follow" });
    assert.equal(response.ok, true, `download ${spec} ${response.status}`);
    const dest = join(dir, name);
    writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
    return dest;
  }
  return resolve(spec);
}

async function install(archive, dir) {
  execFileSync("npm", ["install", "--ignore-scripts", archive], {
    cwd: dir,
    stdio: "pipe",
  });
  return await import(
    pathToFileURL(join(dir, "node_modules/@402signal/route-guard/batch.mjs")).href
  );
}

function packageVersion(dir) {
  return JSON.parse(
    readFileSync(join(dir, "node_modules/@402signal/route-guard/package.json"), "utf8"),
  ).version;
}

const chkGrp = JSON.parse(
  readFileSync(join(root, "tests/fixtures/batch-chk-grp-v5.json"), "utf8"),
);
const historicalLeaves = JSON.parse(
  readFileSync(join(root, "tests/fixtures/batch-route-v5.json"), "utf8"),
);

const work = mkdtempSync(join(tmpdir(), "route-guard-archive-"));
try {
  const archive = await materialize(candidate, work, "candidate.tgz");
  const currentDir = mkdtempSync(join(work, "current-"));
  const { verifyBatchRoute } = await install(archive, currentDir);
  const version = packageVersion(currentDir);
  assert.equal(version, "0.7.2");
  const codecs = new Set();
  for (const v of chkGrp) {
    assert.equal(Object.hasOwn(v.request, "merchant_profile"), false);
    const out = verifyBatchRoute(options(v));
    assert.equal(out.profile, v.profile);
    codecs.add(v.codec);
  }
  assert.deepEqual([...codecs].sort(), ["atom", "exact", "inv", "mpp", "sess"]);
  for (const v of historicalLeaves) {
    assert.ok(v.request.merchant_profile);
    const out = verifyBatchRoute(options(v));
    assert.equal(out.profile, v.request.merchant_profile);
  }
  const drifted = structuredClone(chkGrp[0]);
  drifted.response.codec = "sess";
  assert.throws(() => verifyBatchRoute(options(drifted)));

  const report = {
    archive,
    version,
    chk_grp: chkGrp.length,
    historical: historicalLeaves.length,
    codecs: [...codecs].sort(),
    refuse_on_drift: true,
  };

  if (historical) {
    const histArchive = await materialize(historical, work, "historical.tgz");
    if (historical.startsWith("https://")) {
      const expected = JSON.parse(
        readFileSync(join(root, "live402/static/capabilities.json"), "utf8"),
      ).packages.find((entry) => entry.tag === "route-guard-v0.7.1");
      const digest = createHash("sha256").update(readFileSync(histArchive)).digest("hex");
      assert.equal(digest, expected.sha256);
    }
    const histDir = mkdtempSync(join(work, "historical-"));
    const hist = await install(histArchive, histDir);
    assert.equal(packageVersion(histDir), "0.7.1");
    for (const v of historicalLeaves) {
      assert.ok(v.request.merchant_profile);
      const out = hist.verifyBatchRoute(options(v));
      assert.equal(out.profile, v.request.merchant_profile);
    }
    let refused = 0;
    for (const v of chkGrp) {
      assert.equal(Object.hasOwn(v.request, "merchant_profile"), false);
      try {
        hist.verifyBatchRoute(options(v));
      } catch {
        refused += 1;
      }
    }
    assert.equal(refused, chkGrp.length);
    const histDrift = structuredClone(historicalLeaves[0]);
    histDrift.response.merchant_profile = "solana-mpp-session-v1";
    assert.throws(() => hist.verifyBatchRoute(options(histDrift)));
    report.historical_verifier = {
      archive: histArchive,
      version: "0.7.1",
      historical: historicalLeaves.length,
      chk_grp_without_merchant_profile_refused: refused,
      refuse_on_drift: true,
    };
  }

  console.log(JSON.stringify(report));
} finally {
  rmSync(work, { recursive: true, force: true });
}
