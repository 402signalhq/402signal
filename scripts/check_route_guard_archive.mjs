#!/usr/bin/env node
/** Verify a packed route-guard archive, not the source tree.
 *
 * Candidate 0.7.3 packed bytes are digest-checked against the reviewed
 * expected pair before npm install or import. SHA256SUMS is checked the same
 * way: file digest plus contents vs the tarball hash. Mismatch fails closed.
 * 0.7.3 is pending (provisional candidate digest, not a published archive).
 * Default verify: current chk_grp without buyer merchant_profile, historical
 * leaves that still name merchant_profile, and refuse-on-drift.
 * --historical-verifier tests the published 0.7.1 path: historical leaves
 * still verify; current chk_grp requests without merchant_profile fail closed.
 * Archive arguments may be a local tgz or an https:// download URL.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(new URL("..", import.meta.url).pathname);
const CANDIDATE_TAG = "route-guard-v0.7.3";
const CANDIDATE_TGZ = "402signal-route-guard-0.7.3.tgz";
const REVIEWED_PACK_SHA256 =
  "af0e556b3754d1e0439bb3cecbe38ac5e8de95f660f012adde9a3a7dfd78e9fb";
const REVIEWED_SUMS_SHA256 =
  "bed3bdb06e9e4e4a8eded2fa1e0eb9a60abb2d05b2c650b0ca252b3362f2face";

const arguments_ = process.argv.slice(2);
let candidate = CANDIDATE_TGZ;
let historical;
let checksumFile;
const rest = [];
for (let i = 0; i < arguments_.length; i++) {
  if (arguments_[i] === "--historical-verifier") {
    historical = arguments_[++i];
    continue;
  }
  if (arguments_[i] === "--checksum-file") {
    checksumFile = arguments_[++i];
    continue;
  }
  rest.push(arguments_[i]);
}
if (rest.length) candidate = rest[0];

const capabilities = JSON.parse(
  readFileSync(join(root, "live402/static/capabilities.json"), "utf8"),
);

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function reviewedCandidateDigests() {
  const entry = capabilities.packages.find((row) => row.tag === CANDIDATE_TAG);
  assert.ok(entry, `missing ${CANDIDATE_TAG} capabilities row`);
  const pack = entry.sha256 ?? entry.provisional_pack_sha256;
  const sums = entry.checksum_file_sha256 ?? entry.provisional_sums_sha256;
  assert.equal(pack, REVIEWED_PACK_SHA256);
  assert.equal(sums, REVIEWED_SUMS_SHA256);
  return { pack: REVIEWED_PACK_SHA256, sums: REVIEWED_SUMS_SHA256 };
}

function checksumSpec(archiveSpec) {
  if (checksumFile) return checksumFile;
  if (archiveSpec.startsWith("https://")) {
    return archiveSpec.replace(/[^/]+$/, "SHA256SUMS");
  }
  return join(dirname(resolve(archiveSpec)), "SHA256SUMS");
}

function assertSumsMatchTarball(sumsBody, packSha256) {
  const lines = sumsBody.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 1, "SHA256SUMS must name exactly the candidate tarball");
  const match = /^([0-9a-f]{64})  (.+)$/.exec(lines[0]);
  assert.ok(match, "SHA256SUMS must be GNU sha256sum format");
  assert.equal(match[2], CANDIDATE_TGZ);
  assert.equal(match[1], packSha256, "SHA256SUMS contents must match the tarball hash");
}

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
  const expected = reviewedCandidateDigests();
  const archive = await materialize(candidate, work, "candidate.tgz");
  const sha256 = sha256File(archive);
  assert.equal(sha256, expected.pack, "candidate 0.7.3 digest must match the reviewed expected digest before install");

  const sumsSpec = checksumSpec(candidate);
  if (!sumsSpec.startsWith("https://")) {
    assert.equal(existsSync(sumsSpec), true, `missing SHA256SUMS ${sumsSpec}`);
  }
  const sumsPath = await materialize(sumsSpec, work, "SHA256SUMS");
  const checksumFileSha256 = sha256File(sumsPath);
  assert.equal(
    checksumFileSha256,
    expected.sums,
    "SHA256SUMS digest must match the reviewed expected digest before install",
  );
  assertSumsMatchTarball(readFileSync(sumsPath, "utf8"), sha256);

  const currentDir = mkdtempSync(join(work, "current-"));
  const { verifyBatchRoute } = await install(archive, currentDir);
  const version = packageVersion(currentDir);
  assert.equal(version, "0.7.3");
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
    sha256,
    checksum_file_sha256: checksumFileSha256,
    chk_grp: chkGrp.length,
    historical: historicalLeaves.length,
    codecs: [...codecs].sort(),
    refuse_on_drift: true,
  };

  if (historical) {
    const histArchive = await materialize(historical, work, "historical.tgz");
    if (historical.startsWith("https://")) {
      const published = capabilities.packages.find((entry) => entry.tag === "route-guard-v0.7.1");
      const digest = sha256File(histArchive);
      assert.equal(digest, published.sha256);
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
