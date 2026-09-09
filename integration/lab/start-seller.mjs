/** Live lab machine entrypoint. Privilege drop before serve. No production secrets. */
import { accessSync, chmodSync, chownSync, constants, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const LIVE_APP = "402signal-lab-ross";
export const DROP_UID = 1000;
export const DROP_GID = 1000;
export const LABDATA = "/labdata";
export const SELLER_DEPLOY = "/app/config/seller-deploy.json";
export const CLI = "/app/dist/src/cli.js";

export function fail(code) {
  process.stdout.write(JSON.stringify({ error: code, retry_automatically: false }) + "\n");
  process.exit(1);
}

export function assertLiveApp(env = process.env) {
  // Smoke may skip only the app-name pin. Production path stays exact.
  if (env.LAB_STARTUP_SMOKE === "1") return;
  if (env.FLY_APP_NAME !== LIVE_APP) fail("fly_app_refused");
}

export function assertLabdata(path = LABDATA) {
  let st;
  try { st = lstatSync(path); } catch { fail("labdata_required"); }
  if (!st.isDirectory() || st.isSymbolicLink()) fail("labdata_refused");
  return st;
}

export function assertSellerDeploy(path = SELLER_DEPLOY) {
  let st;
  try { st = lstatSync(path); } catch { fail("seller_deploy_required"); }
  if (!st.isFile() || st.isSymbolicLink()) fail("seller_deploy_refused");
  accessSync(path, constants.R_OK);
}

export function dropRootIfNeeded(path = LABDATA) {
  if (process.getuid() !== 0) return { dropped: false };
  chownSync(path, DROP_UID, DROP_GID);
  chmodSync(path, 0o700);
  process.setgroups([]);
  process.setgid(DROP_GID);
  process.setuid(DROP_UID);
  if (process.getuid() === 0 || process.getgid() === 0) fail("privilege_drop_failed");
  return { dropped: true };
}

export function assertUnprivilegedWritable(path = LABDATA) {
  if (process.getuid() === 0 || process.getgid() === 0) fail("must_not_remain_root");
  accessSync(path, constants.W_OK | constants.X_OK);
}

export function prepareStartup({
  env = process.env,
  labdata = LABDATA,
  config = SELLER_DEPLOY,
} = {}) {
  assertLiveApp(env);
  assertLabdata(labdata);
  const drop = dropRootIfNeeded(labdata);
  assertUnprivilegedWritable(labdata);
  assertSellerDeploy(config);
  return {
    ok: true,
    uid: process.getuid(),
    gid: process.getgid(),
    dropped: drop.dropped,
    smoke: env.LAB_STARTUP_SMOKE === "1",
  };
}

const main = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (main) {
  const report = prepareStartup();
  if (process.argv.includes("--check-startup")) {
    process.stdout.write(JSON.stringify(report) + "\n");
    process.exit(0);
  }
  process.argv = [process.argv[0], CLI, "serve", "--config", SELLER_DEPLOY];
  await import(CLI);
}
