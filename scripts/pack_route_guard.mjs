#!/usr/bin/env node
/** Reproducible npm pack of sdk/route-guard. No registry publish, no spend.
 *
 * npm 10+ (pacote portable pack) already stabilizes the archive:
 * - gzip header mtime is 0
 * - every tar member mtime is NPM_PACKED_TIME (1985-10-26 08:15:00 UTC)
 * - uid/gid are 0
 * File-system mtimes and SOURCE_DATE_EPOCH therefore do not change the tar.
 * npm gzip bytes still vary by Node/zlib. After pack, portable_npm_tgz.py
 * rewrites the gzip stream (level 9, mtime 0, XFL 2, OS 255) so the tgz
 * digest matches 402security's pair for this tree.
 * This script packs, asserts those invariants, writes SHA256SUMS, and checks
 * the pending capabilities record when present.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "node:zlib";

const NPM_PACKED_TIME = 499162500;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(root, "sdk/route-guard");
const arguments_ = process.argv.slice(2);
let destination = resolve(root);
for (const value of arguments_) {
  assert(value.startsWith("--destination="), "usage: node scripts/pack_route_guard.mjs [--destination=dir]");
  destination = resolve(value.slice("--destination=".length));
}
mkdirSync(destination, { recursive: true });

const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
assert.equal(metadata.name, "@402signal/route-guard");
assert.equal(metadata.version, "0.7.2");

const packed = JSON.parse(
  execFileSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", destination],
    {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, npm_config_update_notifier: "false" },
    },
  ),
);
assert.equal(packed.length, 1);
const filename = packed[0].filename;
assert.equal(filename, `402signal-route-guard-${metadata.version}.tgz`);
const tarball = join(destination, filename);
execFileSync("python3", [join(root, "scripts/portable_npm_tgz.py"), tarball], {
  encoding: "utf8",
});
const bytes = readFileSync(tarball);
assert.equal(bytes[0], 0x1f);
assert.equal(bytes[1], 0x8b);
assert.equal(bytes[3] & 0x08, 0, "gzip header must not store a filename");
const gzipMtime = bytes.readUInt32LE(4);
assert.equal(gzipMtime, 0, "gzip mtime must be 0 (npm portable pack)");

const tar = unzipSync(bytes);
let offset = 0;
let members = 0;
while (offset + 512 <= tar.length) {
  const block = tar.subarray(offset, offset + 512);
  if (block.every((value) => value === 0)) break;
  const name = block.subarray(0, 100).toString("utf8").replace(/\0+$/, "");
  const mtime = parseInt(block.subarray(136, 148).toString("ascii").trim(), 8);
  assert.equal(mtime, NPM_PACKED_TIME, name + " tar mtime");
  const size = parseInt(block.subarray(124, 136).toString("ascii").trim() || "0", 8);
  members += 1;
  offset += 512 + Math.ceil(size / 512) * 512;
}
assert(members >= 20, "expected packaged files");

const packSha256 = createHash("sha256").update(bytes).digest("hex");
const sumsBody = `${packSha256}  ${filename}\n`;
const sumsPath = join(destination, "SHA256SUMS");
writeFileSync(sumsPath, sumsBody);
const sumsSha256 = createHash("sha256").update(sumsBody, "utf8").digest("hex");

const capabilities = JSON.parse(
  readFileSync(join(root, "live402/static/capabilities.json"), "utf8"),
);
const pending = (capabilities.packages || []).find(
  (entry) => entry.tag === `route-guard-v${metadata.version}`,
);
if (pending && pending.state === "pending") {
  assert.equal(pending.digest_status, "provisional-until-release");
  assert.equal(pending.sha256, undefined);
  assert.equal(pending.archive, undefined);
  assert.equal(pending.provisional_pack_sha256, packSha256);
  assert.equal(pending.provisional_sums_sha256, sumsSha256);
}

console.log(
  JSON.stringify(
    {
      filename,
      tarball,
      version: metadata.version,
      npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
      packCommand: "npm pack ./sdk/route-guard --ignore-scripts",
      packSha256,
      sumsSha256,
      gzipMtime: 0,
      tarMtime: NPM_PACKED_TIME,
      members,
      portable: "npm-10-pacote-packed-time",
    },
    null,
    2,
  ),
);
