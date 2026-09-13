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
  "33b3f220f000fd35c02417db39c02cd38efbd6d68e59e4fc53c529311bf06276";
const REVIEWED_SUMS =
  "6c64a1226a9e04e3ace58f3251b0b5bdfd99f4477f75e887e8f1028332503d89";

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
