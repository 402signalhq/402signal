#!/usr/bin/env node
/** Verified install of the published GitHub route-guard archive.
 *
 * Not an npm-registry publish. No BATCH enablement. No spend. No wallet.
 *
 * From a buyer project (Node 22+):
 *   node scripts/install_route_guard.mjs
 * or copy this file and run it in the project directory.
 *
 * Downloads the published archive + SHA256SUMS, digest-checks both against
 * the reviewed /capabilities.json pins, then `npm install --ignore-scripts`
 * and writes exact-authorize.mjs (wrap existing sign; fail closed).
 * Local --archive / --checksum-file / --capabilities paths skip the network.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CANDIDATE_TAG = "route-guard-v0.7.2";
const CANDIDATE_TGZ = "402signal-route-guard-0.7.2.tgz";
const REVIEWED_PACK_SHA256 =
  "f23d534537a847d592770aea2bbdbbce493f668645d6dcf95985b21d2a70195a";
const REVIEWED_SUMS_SHA256 =
  "5fae35204f6c309b4f30384cf6cd66958e6bf09edfe8fea3d6859094d4754639";
const PUBLIC_CAPABILITIES = "https://402signal.com/capabilities.json";
const ALLOWED_ARCHIVE_HOST = "https://github.com/402signalhq/402signal/releases/download/";
const ALLOWED_CAPABILITIES = new Set([
  PUBLIC_CAPABILITIES,
  "https://402signal.com/capabilities.json",
]);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoCapabilities = resolve(scriptDir, "../live402/static/capabilities.json");

const arguments_ = process.argv.slice(2);
let archiveSpec;
let checksumFile;
let capabilitiesSpec;
let destination = process.cwd();
let verifyOnly = false;
for (let i = 0; i < arguments_.length; i++) {
  const value = arguments_[i];
  if (value === "--verify-only") {
    verifyOnly = true;
    continue;
  }
  if (value.startsWith("--archive=")) {
    archiveSpec = value.slice("--archive=".length);
    continue;
  }
  if (value === "--archive") {
    archiveSpec = arguments_[++i];
    continue;
  }
  if (value.startsWith("--checksum-file=")) {
    checksumFile = value.slice("--checksum-file=".length);
    continue;
  }
  if (value === "--checksum-file") {
    checksumFile = arguments_[++i];
    continue;
  }
  if (value.startsWith("--capabilities=")) {
    capabilitiesSpec = value.slice("--capabilities=".length);
    continue;
  }
  if (value === "--capabilities") {
    capabilitiesSpec = arguments_[++i];
    continue;
  }
  if (value.startsWith("--destination=")) {
    destination = resolve(value.slice("--destination=".length));
    continue;
  }
  if (value === "--destination") {
    destination = resolve(arguments_[++i]);
    continue;
  }
  throw new Error(
    "usage: node install_route_guard.mjs [--destination=dir] [--archive=path|url] " +
      "[--checksum-file=path|url] [--capabilities=path|url] [--verify-only]",
  );
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertHttpsAllowlisted(url, allowedPrefix) {
  assert.equal(typeof url, "string");
  assert.ok(url.startsWith(allowedPrefix), `refusing download host ${url}`);
}

async function materialize(spec, dir, name) {
  if (typeof spec === "string" && spec.startsWith("https://")) {
    const response = await fetch(spec, { redirect: "follow" });
    assert.equal(response.ok, true, `download ${spec} ${response.status}`);
    const dest = join(dir, name);
    writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
    return dest;
  }
  return resolve(spec);
}

async function loadCapabilities() {
  if (capabilitiesSpec) {
    if (capabilitiesSpec.startsWith("https://")) {
      assert.ok(ALLOWED_CAPABILITIES.has(capabilitiesSpec), "capabilities URL is not allowlisted");
      const response = await fetch(capabilitiesSpec, { redirect: "error" });
      assert.equal(response.ok, true, `capabilities ${response.status}`);
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(await response.arrayBuffer())));
    }
    return JSON.parse(readFileSync(resolve(capabilitiesSpec), "utf8"));
  }
  if (existsSync(repoCapabilities)) {
    return JSON.parse(readFileSync(repoCapabilities, "utf8"));
  }
  const response = await fetch(PUBLIC_CAPABILITIES, { redirect: "error" });
  assert.equal(response.ok, true, `capabilities ${response.status}`);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(await response.arrayBuffer())));
}

function publishedGuard(capabilities) {
  const entry = (capabilities.packages || []).find((row) => row.tag === CANDIDATE_TAG);
  assert.ok(entry, `missing ${CANDIDATE_TAG} capabilities row`);
  assert.equal(entry.state, "published", `${CANDIDATE_TAG} is not a published install URL`);
  assert.equal(entry.sha256, REVIEWED_PACK_SHA256);
  assert.equal(entry.checksum_file_sha256, REVIEWED_SUMS_SHA256);
  assert.match(String(entry.distribution || ""), /not npm registry/i);
  assertHttpsAllowlisted(entry.archive, ALLOWED_ARCHIVE_HOST);
  assertHttpsAllowlisted(entry.checksum_file, ALLOWED_ARCHIVE_HOST);
  assert.ok(entry.archive.endsWith("/" + CANDIDATE_TGZ), "archive name must match the reviewed tarball");
  return entry;
}

function assertSumsMatchTarball(sumsBody, packSha256) {
  const lines = sumsBody.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 1, "SHA256SUMS must name exactly the candidate tarball");
  const match = /^([0-9a-f]{64})  (.+)$/.exec(lines[0]);
  assert.ok(match, "SHA256SUMS must be GNU sha256sum format");
  assert.equal(match[2], CANDIDATE_TGZ);
  assert.equal(match[1], packSha256, "SHA256SUMS contents must match the tarball hash");
}

const work = join(tmpdir(), `route-guard-install-${process.pid}`);
mkdirSync(work, { recursive: true });

const capabilities = await loadCapabilities();
const published = publishedGuard(capabilities);
const archive = await materialize(archiveSpec || published.archive, work, CANDIDATE_TGZ);
const sha256 = sha256File(archive);
assert.equal(sha256, published.sha256, "archive digest must match the published capabilities pin before install");

const sumsSpec = checksumFile || (archiveSpec && !String(archiveSpec).startsWith("https://")
  ? join(dirname(resolve(archiveSpec)), "SHA256SUMS")
  : published.checksum_file);
const sumsPath = await materialize(sumsSpec, work, "SHA256SUMS");
const checksumFileSha256 = sha256File(sumsPath);
assert.equal(
  checksumFileSha256,
  published.checksum_file_sha256,
  "SHA256SUMS digest must match the published capabilities pin before install",
);
assertSumsMatchTarball(readFileSync(sumsPath, "utf8"), sha256);

const report = {
  tag: CANDIDATE_TAG,
  version: "0.7.2",
  distribution: "GitHub release archive; not npm registry",
  archive: archiveSpec || published.archive,
  sha256,
  checksum_file_sha256: checksumFileSha256,
  installed: false,
  destination: null,
  next: {
    request: "POST /route with require_route_binding:true (exact + binding + transparency)",
    authorize: "import { wrapExactAuthorize } from './exact-authorize.mjs' and wrap existing signRouting/signSeller",
    example: "same wrap on the next spend; packaged examples/search.ts is the longer pay-fetch form. MCP preview/validate cannot complete a paid route.",
    miss: "HTTP 200 live:false or HTTP 503 binding_error is policy working, not a broken router. keep_calling_route stays true. Inspect miss_reason / next_action and call /route again.",
  },
};

if (!verifyOnly) {
  const wrapJs = join(scriptDir, "exact_authorize.mjs");
  const wrapDts = join(scriptDir, "exact_authorize.d.ts");
  assert.equal(existsSync(wrapJs), true, "missing exact authorize wrap next to installer");
  mkdirSync(destination, { recursive: true });
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", archive], {
    cwd: destination,
    stdio: "pipe",
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
  const installed = JSON.parse(
    readFileSync(join(destination, "node_modules/@402signal/route-guard/package.json"), "utf8"),
  );
  assert.equal(installed.name, "@402signal/route-guard");
  assert.equal(installed.version, "0.7.2");
  copyFileSync(wrapJs, join(destination, "exact-authorize.mjs"));
  if (existsSync(wrapDts)) copyFileSync(wrapDts, join(destination, "exact-authorize.d.ts"));
  report.installed = true;
  report.destination = destination;
  report.wrap = "exact-authorize.mjs";
}

console.log(JSON.stringify(report, null, 2));
