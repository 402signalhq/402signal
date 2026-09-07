import { readFileSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const check = (ok) => {
  if (!ok) throw Error("owner_runtime_unavailable");
};
const hash = (x) => createHash("sha256").update(x).digest("hex");
const cdp = "https://api.cdp.coinbase.com/platform/v2/x402";
const requireBase = createRequire(
  new URL("../../reference-buyer/package.json", import.meta.url),
);
const requireNative = createRequire(
  new URL("../solana-session-contracts/package.json", import.meta.url),
);
function endpoint(raw) {
  const u = new URL(raw);
  check(
    u.protocol === "https:" &&
      u.href === raw &&
      !u.username &&
      !u.password &&
      !u.hash,
  );
  return raw;
}
async function responseBody(response) {
  const reader = response.body?.getReader();
  let size = 0;
  const parts = [];
  if (reader)
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        check(size <= 262144);
        parts.push(next.value);
      }
    } catch (e) {
      await reader.cancel().catch(() => {});
      throw e;
    }
  return JSON.parse(
    new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(parts)),
  );
}
function rpc(url, methods, send) {
  let id = 0;
  return async (method, params) => {
    check(methods.has(method));
    const requestId = ++id;
    try {
      const r = await send(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      });
      check(r.status === 200 && !r.redirected && (!r.url || r.url === url));
      const value = await responseBody(r);
      check(
        value.jsonrpc === "2.0" &&
          value.id === requestId &&
          !value.error &&
          Object.hasOwn(value, "result"),
      );
      return value.result;
    } catch {
      throw Error("owner_rpc_unavailable");
    }
  };
}
async function baseAccount(env, expected) {
  try {
    const key = env.LAB_BUYER_BASE_PRIVATE_KEY;
    check(typeof key === "string" && /^0x[0-9a-fA-F]{64}$/.test(key));
    const { privateKeyToAccount } = await import(
      pathToFileURL(requireBase.resolve("viem/accounts")).href
    );
    const account = privateKeyToAccount(key);
    check(account.address.toLowerCase() === expected.toLowerCase());
    return { address: account.address, signTypedData: account.signTypedData };
  } catch {
    throw Error("owner_base_account_unavailable");
  }
}
async function nativeAccount(env, name, expected) {
  let bytes;
  try {
    const value = env[name];
    check(typeof value === "string" && value.length <= 100);
    bytes = Buffer.from(value, "base64");
    check(bytes.length === 64 && bytes.toString("base64") === value);
    const { createKeyPairSignerFromBytes } = await import(
      pathToFileURL(requireNative.resolve("@solana/kit")).href
    );
    const signer = await createKeyPairSignerFromBytes(new Uint8Array(bytes));
    check(signer.address === expected);
    return {
      address: signer.address,
      signTransactions: signer.signTransactions,
      signMessages: signer.signMessages,
    };
  } catch {
    throw Error("owner_native_account_unavailable");
  } finally {
    bytes?.fill(0);
  }
}
/** Intended for a fresh owner-run Node24 process in WSL. Captures the unwrapped
 * native transport; never installs a global Fetch wrapper or signs implicitly. */
export async function createRuntime(
  { config: c, stage, signingAllowed },
  env = process.env,
) {
  const send = globalThis.fetch;
  check(typeof send === "function");
  const baseUrl = endpoint(c.router.rpcUrl);
  const baseMethods = new Set([
    "eth_chainId",
    "eth_call",
    "eth_blockNumber",
    "eth_getBlockByNumber",
    "eth_getTransactionByHash",
    "eth_getTransactionReceipt",
    "eth_getCode",
  ]);
  const runtime = { baseRpc: rpc(baseUrl, baseMethods, send) };
  const targets = new Set([endpoint(c.router.url), endpoint(c.url)]);
  if (c.profile === "base-x402-batch-v1")
    for (const path of ["supported", "verify", "settle"])
      targets.add(cdp + "/" + path);
  runtime.fetch = (url, options) => {
    check(
      targets.has(String(url)) &&
        options?.redirect === "error" &&
        options?.credentials === "omit",
    );
    return send(url, options);
  };
  if (stage === "route" || stage === "route-after-deposit") {
    check(signingAllowed === true);
    runtime.routeAccount = await baseAccount(env, c.router.buyerAddress);
  }
  if (c.profile === "solana-mpp-session-v1") {
    const methods = new Set([
      "getGenesisHash",
      "getAccountInfo",
      "getMultipleAccounts",
      "getTokenAccountBalance",
      "getMinimumBalanceForRentExemption",
      "getFeeForMessage",
      "getBalance",
      "getLatestBlockhash",
      "getTransaction",
      "getSignatureStatuses",
      "getSlot",
    ]);
    if (["open", "close", "refund-unused"].includes(stage))
      methods.add("sendTransaction");
    runtime.solanaRpc = rpc(endpoint(c.nativeRpcUrl), methods, send);
    if (stage === "open" || stage.startsWith("deliver-")) {
      check(signingAllowed === true);
      runtime.nativeBuyer = await nativeAccount(
        env,
        "LAB_BUYER_SOLANA_KEY_B64",
        c.nativePolicy.payer,
      );
    }
    if (["open", "close", "refund-unused"].includes(stage)) {
      check(signingAllowed === true);
      runtime.nativeOperator = await nativeAccount(
        env,
        "LAB_SELLER_SOLANA_KEY_B64",
        c.nativePolicy.operator,
      );
    }
  } else {
    if (stage === "deposit" || stage.startsWith("deliver-")) {
      check(signingAllowed === true);
      runtime.baseOwner = await baseAccount(env, c.basePlan.config.payer);
    }
    if (
      [
        "preflight",
        "deposit",
        "claim",
        "settle",
        "refund",
        "refund-unused",
      ].includes(stage)
    ) {
      try {
        const file = resolve(env.BATCH_CDP_AUTH_MODULE ?? "");
        check(
          env.BATCH_CDP_AUTH_MODULE &&
            /^[0-9a-f]{64}$/.test(c.cdpAuthModuleSha256) &&
            lstatSync(file).isFile() &&
            !lstatSync(file).isSymbolicLink() &&
            hash(readFileSync(file)) === c.cdpAuthModuleSha256,
        );
        const module = await import(pathToFileURL(file).href);
        check(typeof module.authorization === "function");
        runtime.cdpAuthorization = ({ url, method }) => {
          check(
            (method === "GET" && url === cdp + "/supported") ||
              (method === "POST" &&
                [cdp + "/verify", cdp + "/settle"].includes(url)),
          );
          return module.authorization({ url, method });
        };
      } catch {
        throw Error("owner_provider_auth_unavailable");
      }
    }
  }
  return runtime;
}
