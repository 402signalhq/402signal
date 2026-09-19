import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Install the reviewed dependency graph before adding a locally packed client.
// npm ci caches tarballs but not necessarily registry package metadata; an
// empty offline npm install would otherwise re-resolve unpinned transitives.
export function seedLockedConsumer(source, target, run) {
  const metadata = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(source, "package-lock.json"), "utf8"));
  const name = "402signal-session-client-consumer-test";
  const manifest = { name, private: true, type: "module", dependencies: metadata.dependencies };
  lock.name = name;
  lock.packages[""] = { name, dependencies: metadata.dependencies };
  writeFileSync(join(target, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(target, "package-lock.json"), JSON.stringify(lock));
  run("npm", ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], target);
}
