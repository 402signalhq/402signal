import test from "node:test";
import assert from "node:assert/strict";
import { createNativeSessionMerchant } from "../src/merchant-session.mjs";
const input = {
  url: "https://merchant.example/solana/session/sha256",
  policy: { depositAtomic: "3000" },
  perCallAtomic: "1000",
  maxCalls: 2,
};
test("native merchant requires SELECT-only readiness before writes or RPC by default", async () => {
  const calls = [];
  const ledger = {
    initialize: async () => {
      calls.push("DDL");
    },
    assertReady: async () => {
      calls.push("ready");
      throw Error("synthetic readiness refusal");
    },
    bind: async () => {
      calls.push("write");
    },
  };
  await assert.rejects(
    createNativeSessionMerchant({
      ...input,
      ledger,
      rpc: async () => calls.push("rpc"),
    }),
    /readiness refusal/,
  );
  assert.deepEqual(calls, ["ready"]);
  await assert.rejects(
    createNativeSessionMerchant({
      ...input,
      ledger: { initialize: ledger.initialize },
      rpc: async () => calls.push("rpc"),
    }),
    /readiness required/,
  );
  assert.deepEqual(calls, ["ready"]);
});
test("explicit private operator migration remains separate from default runtime", async () => {
  const calls = [];
  const ledger = {
    initialize: async () => {
      calls.push("migrate");
    },
    bind: async () => {
      calls.push("bind");
    },
    get: async () => undefined,
    once: async () => {
      calls.push("once");
    },
  };
  await createNativeSessionMerchant({
    ...input,
    ledger,
    migrateSchema: true,
    rpc: async () => {
      throw Error("unexpected RPC");
    },
  });
  assert.deepEqual(calls, ["migrate", "bind", "once"]);
});
