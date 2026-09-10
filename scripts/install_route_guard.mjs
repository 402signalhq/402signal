#!/usr/bin/env node
/** Verified install of the published GitHub route-guard archive.
 *
 * Not an npm-registry publish. No BATCH enablement. No spend. No wallet.
 *
 * From a buyer project (Node 22+ / npm 10+, or bun / pnpm):
 *   node scripts/install_route_guard.mjs
 * or copy this file and run it in the project directory.
 *
 * Downloads the published archive + SHA256SUMS, digest-checks both against
 * the reviewed /capabilities.json pins, then installs with
 * `npm install --ignore-scripts` and writes exact-authorize.mjs
 * (wrap existing sign; fail closed). Debian npm 9 / Node 20 can fail with
 * Tracker "idealTree" already exists; the installer then uses bun or pnpm
 * when present, or explains the supported floor. Local --archive /
 * --checksum-file / --capabilities paths skip the network.
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

export const SUPPORTED_INSTALL_FLOOR = Object.freeze({
  nodeMajor: 22,
  npmMajor: 10,
  alternatives: Object.freeze(["bun", "pnpm"]),
});

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoCapabilities = resolve(scriptDir, "../live402/static/capabilities.json");

export function parseSemverMajor(version) {
  const match = /^v?(\d+)\./.exec(String(version ?? ""));
  return match ? Number(match[1]) : null;
}

export function isKnownBadNpm({ nodeVersion, npmVersion } = {}) {
  const npmMajor = parseSemverMajor(npmVersion);
  if (npmMajor == null || npmMajor < 7 || npmMajor >= 10) return false;
  // npm 7-9 arborist (Debian npm 9.2.0 / Node 20.19.2 is the live case)
  // can throw Tracker "idealTree" already exists on a local tarball.
  void nodeVersion;
  return true;
}

export function isIdealTreeFailure(error) {
  const text = [error?.message, error?.stderr, error?.stdout]
    .map((part) => (part == null ? "" : String(part)))
    .join("\n");
  return /Tracker ['"]idealTree['"] already exists/i.test(text);
}

export function formatIdealTreeError({ nodeVersion, npmVersion, available = {} } = {}) {
  const fallbacks = SUPPORTED_INSTALL_FLOOR.alternatives.filter((tool) => available[tool]);
  const detected = `detected Node ${nodeVersion || "unknown"}, npm ${npmVersion || "unknown"}`;
  const floor =
    `Use Node ${SUPPORTED_INSTALL_FLOOR.nodeMajor}+ with npm ${SUPPORTED_INSTALL_FLOOR.npmMajor}+, ` +
    "or install bun or pnpm and rerun.";
  if (fallbacks.length) {
    return (
      `npm failed with Tracker "idealTree" already exists (${detected}). ` +
      "Digest verify already passed; the published 0.7.2 archive is intact. " +
      `Fallback installer(s) also failed: ${fallbacks.join(", ")}. ${floor}`
    );
  }
  return (
    `npm failed with Tracker "idealTree" already exists ` +
    `(known Debian npm 9 / Node 20 arborist bug; ${detected}). ` +
    "Digest verify already passed; the published 0.7.2 archive is intact. " +
    `No bun or pnpm fallback is on PATH. ${floor}`
  );
}

export function installCommand(tool, archive) {
  if (tool === "npm") {
    return ["npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", archive]];
  }
  if (tool === "bun") {
    return ["bun", ["install", "--ignore-scripts", archive]];
  }
  if (tool === "pnpm") {
    return ["pnpm", ["add", "--ignore-scripts", archive]];
  }
  throw new Error(`unsupported install tool ${tool}`);
}

export function selectInstallPlan(env) {
  const available = env?.available || {};
  const fallbacks = SUPPORTED_INSTALL_FLOOR.alternatives.filter((tool) => available[tool]);
  if (env?.knownBadNpm && fallbacks.length) return fallbacks;
  const plan = [];
  if (available.npm) plan.push("npm");
  for (const tool of fallbacks) {
    if (!plan.includes(tool)) plan.push(tool);
  }
  return plan;
}

export function readCommandVersion(name, execFile = execFileSync) {
  try {
    const raw = String(
      execFile(name, ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).trim();
    const token = raw.split(/\s+/)[0];
    return token || null;
  } catch {
    return null;
  }
}

export function inspectInstallEnvironment({
  nodeVersion = process.versions.node,
  execFile = execFileSync,
} = {}) {
  const npmVersion = readCommandVersion("npm", execFile);
  const available = {
    npm: npmVersion != null,
    bun: readCommandVersion("bun", execFile) != null,
    pnpm: readCommandVersion("pnpm", execFile) != null,
  };
  return {
    nodeVersion,
    npmVersion,
    available,
    knownBadNpm: isKnownBadNpm({ nodeVersion, npmVersion }),
    belowNodeFloor: (parseSemverMajor(nodeVersion) ?? 0) < SUPPORTED_INSTALL_FLOOR.nodeMajor,
  };
}

export function installVerifiedArchive({
  archive,
  destination,
  execFile = execFileSync,
  env,
} = {}) {
  const runtime = env || inspectInstallEnvironment({ execFile });
  const plan = selectInstallPlan(runtime);
  if (plan.length === 0) {
    throw new Error(
      "no supported installer found. " +
        `Use Node ${SUPPORTED_INSTALL_FLOOR.nodeMajor}+ with npm ${SUPPORTED_INSTALL_FLOOR.npmMajor}+, ` +
        "or install bun or pnpm.",
    );
  }
  for (let i = 0; i < plan.length; i++) {
    const tool = plan[i];
    const [, args] = installCommand(tool, archive);
    try {
      execFile(tool, args, {
        cwd: destination,
        stdio: "pipe",
        encoding: "utf8",
        env: { ...process.env, npm_config_update_notifier: "false" },
      });
      const usedFallback = tool !== "npm";
      return {
        tool,
        fallback: usedFallback,
        reason: usedFallback
          ? runtime.knownBadNpm && !plan.includes("npm")
            ? "known_bad_npm"
            : "idealTree"
          : "npm",
        nodeVersion: runtime.nodeVersion,
        npmVersion: runtime.npmVersion,
        knownBadNpm: runtime.knownBadNpm,
      };
    } catch (error) {
      const canFallback =
        tool === "npm" && isIdealTreeFailure(error) && i < plan.length - 1;
      if (canFallback) continue;
      if (tool === "npm" && isIdealTreeFailure(error)) {
        throw new Error(
          formatIdealTreeError({
            nodeVersion: runtime.nodeVersion,
            npmVersion: runtime.npmVersion,
            available: runtime.available,
          }),
        );
      }
      throw error;
    }
  }
  throw new Error(
    formatIdealTreeError({
      nodeVersion: runtime.nodeVersion,
      npmVersion: runtime.npmVersion,
      available: runtime.available,
    }),
  );
}

export function parseInstallArgs(argv) {
  let archiveSpec;
  let checksumFile;
  let capabilitiesSpec;
  let destination = process.cwd();
  let verifyOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--verify-only") {
      verifyOnly = true;
      continue;
    }
    if (value.startsWith("--archive=")) {
      archiveSpec = value.slice("--archive=".length);
      continue;
    }
    if (value === "--archive") {
      archiveSpec = argv[++i];
      continue;
    }
    if (value.startsWith("--checksum-file=")) {
      checksumFile = value.slice("--checksum-file=".length);
      continue;
    }
    if (value === "--checksum-file") {
      checksumFile = argv[++i];
      continue;
    }
    if (value.startsWith("--capabilities=")) {
      capabilitiesSpec = value.slice("--capabilities=".length);
      continue;
    }
    if (value === "--capabilities") {
      capabilitiesSpec = argv[++i];
      continue;
    }
    if (value.startsWith("--destination=")) {
      destination = resolve(value.slice("--destination=".length));
      continue;
    }
    if (value === "--destination") {
      destination = resolve(argv[++i]);
      continue;
    }
    throw new Error(
      "usage: node install_route_guard.mjs [--destination=dir] [--archive=path|url] " +
        "[--checksum-file=path|url] [--capabilities=path|url] [--verify-only]",
    );
  }
  return { archiveSpec, checksumFile, capabilitiesSpec, destination, verifyOnly };
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

async function loadCapabilities(capabilitiesSpec) {
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

export async function runInstallRouteGuard(argv = process.argv.slice(2)) {
  const { archiveSpec, checksumFile, capabilitiesSpec, destination, verifyOnly } =
    parseInstallArgs(argv);

  const work = join(tmpdir(), `route-guard-install-${process.pid}`);
  mkdirSync(work, { recursive: true });

  const capabilities = await loadCapabilities(capabilitiesSpec);
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
    const installer = installVerifiedArchive({ archive, destination });
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
    report.installer = {
      tool: installer.tool,
      fallback: installer.fallback,
      reason: installer.reason,
      node: installer.nodeVersion,
      npm: installer.npmVersion,
    };
  }

  console.log(JSON.stringify(report, null, 2));
  return report;
}

function invokedAsCli() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(entry);
  } catch {
    return false;
  }
}

if (invokedAsCli()) {
  await runInstallRouteGuard();
}
