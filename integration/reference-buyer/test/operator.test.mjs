import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
test("CLI never exposes caller account import exceptions", () => {
  const dir = mkdtempSync(join(tmpdir(), "buyer-redaction-"));
  try {
    const secret = "syntheticprivatecredential";
    const config = join(dir, "config.json");
    const account = join(dir, "account.mjs");
    writeFileSync(config, JSON.stringify({policy: {}, directory: dir}), {mode: 0o600});
    writeFileSync(account, `throw new Error("${secret}");`, {mode: 0o600});
    const result = spawnSync(process.execPath, ["--no-warnings", new URL("../operator.mjs", import.meta.url).pathname, "run", config, "synthetic-job"], {
      encoding: "utf8", env: {...process.env, REFERENCE_BUYER_ACK: "base-exact-only-once", REFERENCE_BUYER_ACCOUNT_MODULE: account}
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.includes(secret), false);
    assert.deepEqual(JSON.parse(result.stderr), {state: "stopped", code: "operation_stopped", newPaymentAllowed: false});
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
