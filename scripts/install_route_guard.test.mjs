import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installer = join(root, "scripts/install_route_guard.mjs");
const REVIEWED_PACK =
  "f23d534537a847d592770aea2bbdbbce493f668645d6dcf95985b21d2a70195a";
const REVIEWED_SUMS =
  "5fae35204f6c309b4f30384cf6cd66958e6bf09edfe8fea3d6859094d4754639";
const capabilitiesPath = join(root, "live402/static/capabilities.json");

function runInstaller(args, extra = {}) {
  return spawnSync(process.execPath, [installer, ...args], {
    encoding: "utf8",
    cwd: extra.cwd || root,
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
}

test("candidate digest mismatch fails closed before npm install", () => {
  const dir = mkdtempSync(join(tmpdir(), "route-guard-install-mismatch-"));
  try {
    const tgz = join(dir, "402signal-route-guard-0.7.2.tgz");
    const sums = join(dir, "SHA256SUMS");
    writeFileSync(tgz, "not-the-reviewed-0.7.2-bytes");
    writeFileSync(sums, `${"00".repeat(32)}  402signal-route-guard-0.7.2.tgz\n`);
    const result = runInstaller([
      "--verify-only",
      "--archive",
      tgz,
      "--checksum-file",
      sums,
      "--capabilities",
      capabilitiesPath,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /digest must match the published capabilities pin before install|archive digest/);
    assert.doesNotMatch(result.stderr, /npm ERR|TAR_BAD_ARCHIVE/);
    assert.equal(result.stdout.includes("{"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unpublished capabilities row is not an install URL", () => {
  const dir = mkdtempSync(join(tmpdir(), "route-guard-install-pending-"));
  try {
    const pending = JSON.parse(readFileSync(capabilitiesPath, "utf8"));
    pending.packages[0] = {
      ...pending.packages[0],
      state: "pending",
      digest_status: "provisional-until-release",
    };
    delete pending.packages[0].archive;
    delete pending.packages[0].sha256;
    const capabilities = join(dir, "capabilities.json");
    writeFileSync(capabilities, JSON.stringify(pending));
    writeFileSync(join(dir, "402signal-route-guard-0.7.2.tgz"), "x");
    writeFileSync(join(dir, "SHA256SUMS"), `${"00".repeat(32)}  402signal-route-guard-0.7.2.tgz\n`);
    const result = runInstaller([
      "--verify-only",
      "--archive",
      join(dir, "402signal-route-guard-0.7.2.tgz"),
      "--checksum-file",
      join(dir, "SHA256SUMS"),
      "--capabilities",
      capabilities,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a published install URL/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reviewed local archive verifies and installs into a fresh buyer directory", (t) => {
  const packDir = process.env.PACK_DIR;
  if (!packDir) {
    t.skip("PACK_DIR not set");
    return;
  }
  const dest = mkdtempSync(join(tmpdir(), "route-guard-install-ok-"));
  try {
    const tgz = join(packDir, "402signal-route-guard-0.7.2.tgz");
    const sums = join(packDir, "SHA256SUMS");
    const verify = runInstaller([
      "--verify-only",
      "--archive",
      tgz,
      "--checksum-file",
      sums,
      "--capabilities",
      capabilitiesPath,
    ]);
    assert.equal(verify.status, 0, verify.stderr);
    const report = JSON.parse(verify.stdout);
    assert.equal(report.sha256, REVIEWED_PACK);
    assert.equal(report.checksum_file_sha256, REVIEWED_SUMS);
    assert.equal(report.installed, false);
    assert.match(report.distribution, /not npm registry/i);
    assert.equal(report.next.authorize.includes("wrapExactAuthorize"), true);
    assert.match(report.next.miss, /policy working/);

    const install = runInstaller([
      "--destination",
      dest,
      "--archive",
      tgz,
      "--checksum-file",
      sums,
      "--capabilities",
      capabilitiesPath,
    ]);
    assert.equal(install.status, 0, install.stderr);
    const installed = JSON.parse(install.stdout);
    assert.equal(installed.installed, true);
    assert.equal(
      JSON.parse(readFileSync(join(dest, "node_modules/@402signal/route-guard/package.json"), "utf8")).version,
      "0.7.2",
    );
    copyFileSync(join(dest, "node_modules/@402signal/route-guard/examples/search.ts"), join(dest, "search.ts"));
    assert.ok(readFileSync(join(dest, "search.ts"), "utf8").includes("withVerifiedRoute"));
    assert.match(readFileSync(join(dest, "exact-authorize.mjs"), "utf8"), /wrapExactAuthorize/);
    assert.match(readFileSync(join(dest, "exact-authorize.d.ts"), "utf8"), /wrapExactAuthorize/);
    assert.equal(installed.wrap, "exact-authorize.mjs");
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});
