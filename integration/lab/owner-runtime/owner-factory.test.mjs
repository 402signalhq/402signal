import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createRuntime } from "./owner-factory.mjs";
import {
  payer,
  operator,
  args,
} from "../solana-session-contracts/test/campaign-cli-support.mjs";
const requireBase = createRequire(
  new URL("../../reference-buyer/package.json", import.meta.url),
);
const requireNative = createRequire(
  new URL("../solana-session-contracts/package.json", import.meta.url),
);
const { privateKeyToAccount } = await import(
  pathToFileURL(requireBase.resolve("viem/accounts")).href
);
const { getBase58Encoder } = await import(
  pathToFileURL(requireNative.resolve("@solana/kit")).href
);
const key = "0x" + "01".repeat(32),
  base = privateKeyToAccount(key);
const config = {
  profile: "solana-mpp-session-v1",
  url: "https://merchant.example/solana/session/sha256",
  router: {
    url: "https://402signal.com/route",
    rpcUrl: "https://base.example/",
    buyerAddress: base.address,
  },
  nativeRpcUrl: "https://solana.example/",
  nativePolicy: args().policy,
};
const secret = (seed, address) =>
  Buffer.concat([
    Buffer.alloc(32, seed),
    Buffer.from(getBase58Encoder().encode(address)),
  ]).toString("base64");
test("readonly owner factory ignores malformed private key variables and provides no wallet signers", async () => {
  const before = globalThis.fetch;
  const r = await createRuntime(
    { config, stage: "confirm-open", signingAllowed: false },
    {
      LAB_BUYER_BASE_PRIVATE_KEY: "invalid",
      LAB_BUYER_SOLANA_KEY_B64: "invalid",
      LAB_SELLER_SOLANA_KEY_B64: "invalid",
    },
  );
  assert.equal(r.nativeBuyer, undefined);
  assert.equal(r.nativeOperator, undefined);
  assert.equal(r.routeAccount, undefined);
  assert.equal(globalThis.fetch, before);
  await assert.rejects(r.solanaRpc("sendTransaction", []));
  await assert.rejects(r.baseRpc("eth_sendRawTransaction", []));
});
test("existing owner environment names load only explicitly requested pinned account capabilities", async () => {
  const env = {
    LAB_BUYER_BASE_PRIVATE_KEY: key,
    LAB_BUYER_SOLANA_KEY_B64: secret(7, payer.address),
    LAB_SELLER_SOLANA_KEY_B64: secret(8, operator.address),
  };
  const route = await createRuntime(
    { config, stage: "route", signingAllowed: true },
    env,
  );
  assert.equal(route.routeAccount.address, base.address);
  assert.equal(route.nativeBuyer, undefined);
  const open = await createRuntime(
    { config, stage: "open", signingAllowed: true },
    env,
  );
  assert.equal(open.nativeBuyer.address, payer.address);
  assert.equal(open.nativeOperator.address, operator.address);
  assert.equal(open.routeAccount, undefined);
  assert.deepEqual(Object.keys(open.nativeBuyer).sort(), [
    "address",
    "signMessages",
    "signTransactions",
  ]);
  const close = await createRuntime(
    { config, stage: "close", signingAllowed: true },
    env,
  );
  assert.equal(close.nativeBuyer, undefined);
  assert.equal(close.nativeOperator.address, operator.address);
});
test("wrong public key half, wrong expected owner, and absent explicit signing permission fail closed", async () => {
  await assert.rejects(
    createRuntime(
      { config, stage: "open", signingAllowed: true },
      { LAB_BUYER_SOLANA_KEY_B64: secret(7, operator.address) },
    ),
  );
  await assert.rejects(
    createRuntime(
      {
        config: {
          ...config,
          router: { ...config.router, buyerAddress: "0x" + "2".repeat(40) },
        },
        stage: "route",
        signingAllowed: true,
      },
      { LAB_BUYER_BASE_PRIVATE_KEY: key },
    ),
  );
  await assert.rejects(
    createRuntime(
      { config, stage: "route", signingAllowed: false },
      { LAB_BUYER_BASE_PRIVATE_KEY: key },
    ),
  );
});
