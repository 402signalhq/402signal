import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  LIVE_APP,
  SELLER_DEPLOY,
  assertLabdata,
  assertLiveApp,
  assertSellerDeploy,
  assertUnprivilegedWritable,
  resolveSellerDeploy,
} from "./start-seller.mjs";

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "start-seller-"));
  return { dir, close() { rmSync(dir, { recursive: true, force: true }); } };
}

test("production app-name pin refuses unknown apps; no smoke bypass", () => {
  const exit = process.exit;
  const writes = [];
  const stdout = process.stdout.write;
  process.stdout.write = (c) => { writes.push(String(c)); return true; };
  try {
    process.exit = (code) => { throw Object.assign(new Error("exit"), { code }); };
    assert.throws(() => assertLiveApp({}), (e) => e.code === 1);
    assert.match(writes.join(""), /fly_app_refused/);
    writes.length = 0;
    assert.throws(() => assertLiveApp({ FLY_APP_NAME: "other" }), (e) => e.code === 1);
    assert.throws(() => assertLiveApp({ LAB_STARTUP_SMOKE: "1", FLY_APP_NAME: "other" }), (e) => e.code === 1);
    assertLiveApp({ FLY_APP_NAME: LIVE_APP });
  } finally {
    process.exit = exit;
    process.stdout.write = stdout;
  }
});

test("labdata must be a real directory; seller-deploy must be a readable file", () => {
  const s = scratch();
  const exit = process.exit;
  const stdout = process.stdout.write;
  process.stdout.write = () => true;
  process.exit = (code) => { throw Object.assign(new Error("exit"), { code }); };
  try {
    assert.throws(() => assertLabdata(join(s.dir, "missing")), (e) => e.code === 1);
    const file = join(s.dir, "file"); writeFileSync(file, "x");
    assert.throws(() => assertLabdata(file), (e) => e.code === 1);
    const link = join(s.dir, "link"); symlinkSync(s.dir, link);
    assert.throws(() => assertLabdata(link), (e) => e.code === 1);
    const lab = join(s.dir, "labdata"); mkdirSync(lab, { mode: 0o700 });
    assertLabdata(lab);
    assert.throws(() => assertSellerDeploy(join(s.dir, "nope.json")), (e) => e.code === 1);
    const cfgLink = join(s.dir, "alias.json"); symlinkSync(file, cfgLink);
    assert.throws(() => assertSellerDeploy(cfgLink), (e) => e.code === 1);
    const cfg = join(s.dir, "seller-deploy.json"); writeFileSync(cfg, "{}");
    assertSellerDeploy(cfg);
    assert.equal(resolveSellerDeploy({}), SELLER_DEPLOY);
    assert.equal(resolveSellerDeploy({ LAB_SELLER_DEPLOY: "/labdata/seller-deploy.json" }), "/labdata/seller-deploy.json");
    const volumeCfg = join(lab, "seller-deploy.json"); writeFileSync(volumeCfg, "{}");
    assertSellerDeploy(volumeCfg, { env: { LAB_SELLER_DEPLOY: volumeCfg }, labdata: lab });
    assert.throws(
      () => assertSellerDeploy(cfg, { env: { LAB_SELLER_DEPLOY: cfg }, labdata: lab }),
      (e) => e.code === 1,
    );
    if (process.getuid() !== 0) assertUnprivilegedWritable(lab);
  } finally {
    process.exit = exit;
    process.stdout.write = stdout;
    s.close();
  }
});

test("CLI entry refuses without the live app name (no serve)", () => {
  const r = spawnSync(process.execPath, [new URL("./start-seller.mjs", import.meta.url).pathname, "--check-startup"], {
    env: { ...process.env, FLY_APP_NAME: "wrong-app" },
    encoding: "utf8",
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /fly_app_refused/);
});
