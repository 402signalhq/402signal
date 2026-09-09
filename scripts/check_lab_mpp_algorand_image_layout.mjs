#!/usr/bin/env node
/** Offline layout check: the lab Fly image bakes /mpp-algorand without a post-deploy symlink. */
import assert from "node:assert/strict";
import { accessSync, constants, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dockerfile = readFileSync(join(root, "integration/lab/Dockerfile"), "utf8");
const config = readFileSync(
  join(root, "integration/lab/src/algorand-native-charge-config.ts"),
  "utf8",
);
const ignore = readFileSync(join(root, "integration/.dockerignore"), "utf8");
const modulePath = "../../../mpp-algorand/lab-merchant.mjs";

assert.match(
  config,
  /const modulePath = "\.\.\/\.\.\/\.\.\/mpp-algorand\/lab-merchant\.mjs"/,
);
assert.equal(
  resolve("/app/dist/src", modulePath),
  "/mpp-algorand/lab-merchant.mjs",
);
assert.equal(
  resolve("/mpp-algorand", "../../sdk/route-guard/batch.mjs"),
  "/sdk/route-guard/batch.mjs",
);
assert.match(
  dockerfile,
  /COPY --from=mpp --chown=node:node \/mpp-algorand \/mpp-algorand/,
);
assert.match(
  dockerfile,
  /COPY mpp-algorand\/package\.json mpp-algorand\/package-lock\.json/,
);
assert.match(
  dockerfile,
  /COPY mpp-algorand\/index\.mjs mpp-algorand\/lab-merchant\.mjs mpp-algorand\/lab-sdk-worker\.mjs/,
);
assert.match(
  dockerfile,
  /npm ci --omit=dev --ignore-scripts --no-audit --no-fund/,
);
assert.match(dockerfile, /COPY --chown=node:node lab\/sdk \/sdk/);
assert.match(dockerfile, /COPY lab\/package\.json lab\/package-lock\.json/);
assert.match(dockerfile, /from the integration\/[\s#]*context/i);
assert.match(dockerfile, /no separate Dockerfile\.fly/);
assert.doesNotMatch(dockerfile, /ln -s[^\n]*\/mpp-algorand/);
assert.match(ignore, /mpp-algorand\/test/);

for (const name of [
  "package.json",
  "package-lock.json",
  "index.mjs",
  "lab-merchant.mjs",
  "lab-sdk-worker.mjs",
]) {
  accessSync(join(root, "integration/mpp-algorand", name), constants.R_OK);
}

assert.equal(
  JSON.parse(readFileSync(join(root, "integration/mpp-algorand/package.json"), "utf8"))
    .dependencies["@goplausible/algorand-mpp-sdk"],
  "0.9.4",
);

console.log(
  JSON.stringify({
    result: "PASS",
    compiledImport: "/mpp-algorand/lab-merchant.mjs",
    packageRoot: "/mpp-algorand",
    indexSdkImport: "/sdk/route-guard",
    dockerfile: "integration/lab/Dockerfile",
    context: "integration/",
    symlinkHack: false,
  }),
);
