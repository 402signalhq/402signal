#!/usr/bin/env node
/** Static Fly recipe check. Image smoke (scripts/smoke_lab_fly_image.sh) is the live qualification. */
import assert from "node:assert/strict";
import { accessSync, constants, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fly = readFileSync(join(root, "integration/lab/Dockerfile.fly"), "utf8");
const local = readFileSync(join(root, "integration/lab/Dockerfile"), "utf8");
const starter = readFileSync(join(root, "integration/lab/start-seller.mjs"), "utf8");
const config = readFileSync(
  join(root, "integration/lab/src/algorand-native-charge-config.ts"),
  "utf8",
);
const smoke = JSON.parse(
  readFileSync(join(root, "integration/lab/config/seller-deploy.smoke.json"), "utf8"),
);
const modulePath = "../../../mpp-algorand/lab-merchant.mjs";

assert.match(
  config,
  /const modulePath = "\.\.\/\.\.\/\.\.\/mpp-algorand\/lab-merchant\.mjs"/,
);
assert.equal(resolve("/app/dist/src", modulePath), "/mpp-algorand/lab-merchant.mjs");
assert.equal(
  resolve("/app/native-mpp/algorand", "../../sdk/route-guard/batch.mjs"),
  "/app/sdk/route-guard/batch.mjs",
);

assert.match(fly, /Fly-facing lab image recipe/);
assert.match(fly, /node \/app\/start-seller\.mjs/);
assert.match(fly, /COPY --from=mpp --chown=node:node \/mpp-build \/app\/native-mpp\/algorand/);
assert.match(fly, /ln -s \/app\/native-mpp\/algorand \/mpp-algorand/);
assert.match(fly, /COPY --chown=node:node lab\/start-seller\.mjs \/app\/start-seller\.mjs/);
assert.match(fly, /CMD \["node", "\/app\/start-seller\.mjs"\]/);
assert.doesNotMatch(fly, /CMD \["node", "dist\/src\/cli\.js", "demo"\]/);
assert.match(starter, /FLY_APP_NAME !== LIVE_APP/);
assert.match(starter, /LAB_STARTUP_SMOKE/);
assert.match(starter, /setuid\(DROP_UID\)/);
assert.match(starter, /serve", "--config", SELLER_DEPLOY/);
assert.equal(smoke.mode, "offline");
assert.equal(smoke.ledgerPath, "/labdata/seller.sqlite");
assert.doesNotMatch(JSON.stringify(smoke), /[A-Za-z0-9]{40,}/);

assert.match(local, /lab-only context/);
assert.match(local, /Dockerfile\.fly/);

for (const name of [
  "package.json",
  "package-lock.json",
  "index.mjs",
  "lab-merchant.mjs",
  "lab-sdk-worker.mjs",
]) {
  accessSync(join(root, "integration/mpp-algorand", name), constants.R_OK);
}
accessSync(join(root, "integration/lab/start-seller.mjs"), constants.R_OK);

console.log(
  JSON.stringify({
    result: "PASS",
    compiledImport: "/mpp-algorand/lab-merchant.mjs",
    packageRoot: "/app/native-mpp/algorand",
    symlink: "/mpp-algorand -> /app/native-mpp/algorand",
    entrypoint: "node /app/start-seller.mjs",
    dockerfile: "integration/lab/Dockerfile.fly",
    context: "integration/",
    qualification: "scripts/smoke_lab_fly_image.sh",
  }),
);
