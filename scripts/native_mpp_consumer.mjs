/** Install a packed fixture from its shipped lock without registry metadata. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export function installLockedNativeMppConsumer(consumer, output, archiveName) {
  const manifest = JSON.parse(fs.readFileSync(path.join(output, "package.json")));
  const shipped = JSON.parse(fs.readFileSync(path.join(output, "npm-shrinkwrap.json")));
  assert.equal(shipped.lockfileVersion, 3);
  assert.equal(manifest.name, "@402signal/mpp-client");
  assert.equal(shipped.packages[""].name, manifest.name);
  assert.equal(shipped.packages[""].version, manifest.version);
  assert.deepEqual(shipped.packages[""].dependencies, manifest.dependencies);
  assert.equal(path.basename(archiveName), archiveName);
  const archive = path.join(output, archiveName);
  const spec = "file:" + path.relative(consumer, archive).split(path.sep).join("/");
  const dependencies = { [manifest.name]: spec };
  const root = { name: "native-mpp-isolated-consumer", version: "0.0.0", dependencies };
  fs.writeFileSync(path.join(consumer, "package.json"),
    JSON.stringify({ ...root, private: true, type: "module" }, null, 2) + "\n");
  const packages = structuredClone(shipped.packages);
  packages[""] = root;
  const packageKey = "node_modules/" + manifest.name;
  assert.equal(packages[packageKey], undefined);
  packages[packageKey] = {
    version: manifest.version,
    resolved: spec,
    integrity: "sha512-" + createHash("sha512").update(fs.readFileSync(archive)).digest("base64"),
    hasShrinkwrap: true,
    dependencies: manifest.dependencies,
    engines: manifest.engines,
  };
  const lock = { name: root.name, version: root.version, lockfileVersion: 3, requires: true, packages };
  fs.writeFileSync(path.join(consumer, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
  execFileSync("npm", ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: consumer, stdio: "pipe" });
  // Check npm used every exact shipped version and integrity, not a fresh resolution.
  const installed = JSON.parse(fs.readFileSync(path.join(consumer, "node_modules/.package-lock.json")));
  for (const [key, expected] of Object.entries(packages)) {
    if (!key) continue;
    assert.equal(installed.packages[key]?.version, expected.version, key);
    assert.equal(installed.packages[key]?.integrity, expected.integrity, key);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(consumer, "package-lock.json"))), lock);
}
