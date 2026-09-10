import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checker = join(root, "scripts/check_route_guard_archive.mjs");
const REVIEWED_PACK =
  "af0e556b3754d1e0439bb3cecbe38ac5e8de95f660f012adde9a3a7dfd78e9fb";
const REVIEWED_SUMS =
  "bed3bdb06e9e4e4a8eded2fa1e0eb9a60abb2d05b2c650b0ca252b3362f2face";

function runChecker(tgz, sums) {
  return spawnSync(process.execPath, [checker, tgz, "--checksum-file", sums], {
    encoding: "utf8",
    cwd: root,
  });
}

test("candidate digest mismatch fails closed before install", () => {
  const dir = mkdtempSync(join(tmpdir(), "route-guard-archive-mismatch-"));
  try {
    const tgz = join(dir, "402signal-route-guard-0.7.3.tgz");
    const sums = join(dir, "SHA256SUMS");
    writeFileSync(tgz, "not-the-reviewed-0.7.3-bytes");
    writeFileSync(sums, `${"00".repeat(32)}  402signal-route-guard-0.7.3.tgz\n`);
    const result = runChecker(tgz, sums);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(REVIEWED_PACK));
    assert.doesNotMatch(result.stderr, /npm ERR|TAR_BAD_ARCHIVE/);
    assert.equal(result.stdout.includes("{"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SHA256SUMS digest mismatch fails closed before install", (t) => {
  const packDir = process.env.PACK_DIR;
  if (!packDir) {
    t.skip("PACK_DIR not set");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "route-guard-archive-sums-"));
  try {
    const tgz = join(dir, "402signal-route-guard-0.7.3.tgz");
    const sums = join(dir, "SHA256SUMS");
    copyFileSync(join(packDir, "402signal-route-guard-0.7.3.tgz"), tgz);
    writeFileSync(sums, `${"11".repeat(32)}  402signal-route-guard-0.7.3.tgz\n`);
    const result = runChecker(tgz, sums);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(REVIEWED_SUMS));
    assert.doesNotMatch(result.stderr, /npm ERR|TAR_BAD_ARCHIVE/);
    assert.equal(result.stdout.includes("{"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
