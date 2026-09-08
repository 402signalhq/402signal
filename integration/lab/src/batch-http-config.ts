import { configuredAlgorandManifestMerchants } from "./algorand-manifest-config.js";
import { readFileSync, lstatSync } from "node:fs";
import { Pool } from "pg";
import type { Seller } from "./seller.js";
import type { BatchHttpMerchant } from "./http-server.js";
import { BaseBatchMerchant } from "./base-batch-merchant.js";
import {
  BaseBatchContinuationMerchant,
  BASE_BATCH_CONTINUATION_OPT_IN,
} from "./base-batch-continuation-merchant.js";
import { BaseBatchLedger } from "./base-batch-ledger.js";
import { http } from "./transport.js";
import { CdpBatchReadOnlyProvider } from "./base-batch-cdp-provider.js";
import { assert, parseJson } from "./json.js";
export const BASE_BATCH_OPT_IN = "reviewed-two-voucher-profile-v1";
export const SOLANA_SESSION_OPT_IN = "reviewed-owner-open-push-v1";
export const SOLANA_CONTINUATION_OPT_IN = "reviewed-owner-push-continuation-v2";
function config(path: string | undefined) {
  assert(path, "batch_config_required");
  const st = lstatSync(path);
  assert(
    st.isFile() && !st.isSymbolicLink() && st.size <= 16384,
    "batch_config_refused",
  );
  return parseJson(readFileSync(path, "utf8"));
}
/** Continuation scope is checked before opening a pool or reading provider tokens. */
function continuationConfig(
  path: string | undefined,
  seller: Seller,
  rail: "base" | "solana",
) {
  const c = config(path),
    origin = new URL(seller.config.origin);
  assert(
    origin.protocol === "https:" && origin.origin === seller.config.origin,
    "batch_continuation_origin_refused",
  );
  const expectedKeys =
    rail === "base"
      ? "campaignId,channelConfig,createdAt,expiresAt,maxCalls,perCallAtomic,url,version"
      : "campaignId,expiresAt,maxCalls,perCallAtomic,policy,rpcUrl,url,version";
  assert(
    c &&
      Object.keys(c).sort().join(",") === expectedKeys &&
      c.version === 2 &&
      typeof c.campaignId === "string" &&
      (rail === "base"
        ? /^[A-Za-z0-9_-]{8,60}$/
        : /^[A-Za-z0-9_-]{8,48}$/
      ).test(c.campaignId) &&
      Number.isSafeInteger(c.maxCalls) &&
      c.maxCalls >= 3 &&
      c.maxCalls <= 64 &&
      c.perCallAtomic === "1000" &&
      Number.isSafeInteger(c.expiresAt) &&
      c.expiresAt > 0,
    "batch_continuation_config_refused",
  );
  const resource =
    rail === "base" ? "/base/batch/sha256" : "/solana/session/sha256";
  assert(
    c.url === seller.config.origin + resource,
    "batch_continuation_resource_refused",
  );
  if (rail === "base") {
    assert(
      typeof c.channelConfig?.receiver === "string" &&
        c.channelConfig.receiver.toLowerCase() ===
          seller.config.rails.base.payTo.toLowerCase() &&
        Number.isSafeInteger(c.createdAt) &&
        c.createdAt >= 0 &&
        c.expiresAt > c.createdAt &&
        c.expiresAt - c.createdAt <= 86400000,
      "base_batch_continuation_scope_refused",
    );
  } else {
    assert(
      c.policy?.recipient === seller.config.rails.solana.payTo &&
        typeof c.rpcUrl === "string" &&
        c.rpcUrl.length <= 4096 &&
        c.expiresAt <= Date.now() + 86400000,
      "solana_continuation_scope_refused",
    );
    const endpoint = new URL(c.rpcUrl);
    assert(
      endpoint.protocol === "https:" &&
        endpoint.href === c.rpcUrl &&
        !endpoint.username &&
        !endpoint.password &&
        !endpoint.hash,
      "solana_rpc_refused",
    );
  }
  return c;
}
function continuationRpc(url: string) {
  const readonly = new Set([
    "getGenesisHash",
    "getLatestBlockhash",
    "getSlot",
    "getAccountInfo",
    "getTransaction",
    "getSignatureStatuses",
    "getMinimumBalanceForRentExemption",
    "getFeeForMessage",
    "getBalance",
  ]);
  return async (method: string, params: unknown[]) => {
    assert(readonly.has(method), "readonly_rpc_required");
    const response = await http(url, "POST", {
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    });
    assert(
      response.status === 200 && response.body && !response.body.error,
      "solana_rpc_unavailable",
    );
    return response.body.result;
  };
}
/** Independently gated self-test modules. No keys or new service are provisioned. */
async function configuredExistingBatchHttpMerchants(
  seller: Seller,
  env: NodeJS.ProcessEnv = process.env,
) {
  const base = env.LAB_BASE_BATCH ?? "",
    solana = env.LAB_SOLANA_PUSH_SESSION ?? "",
    baseV2 = env.LAB_BASE_BATCH_CONTINUATION ?? "",
    solanaV2 = env.LAB_SOLANA_PUSH_CONTINUATION ?? "";
  assert(!base || base === BASE_BATCH_OPT_IN, "base_batch_opt_in_refused");
  assert(
    !solana || solana === SOLANA_SESSION_OPT_IN,
    "solana_session_opt_in_refused",
  );
  assert(
    !baseV2 || baseV2 === BASE_BATCH_CONTINUATION_OPT_IN,
    "base_batch_continuation_opt_in_refused",
  );
  assert(
    !solanaV2 || solanaV2 === SOLANA_CONTINUATION_OPT_IN,
    "solana_continuation_opt_in_refused",
  );
  assert(!(base && baseV2) && !(solana && solanaV2), "batch_path_conflict");
  if (!base && !solana && !baseV2 && !solanaV2)
    return { merchants: [] as BatchHttpMerchant[], close: async () => {} };
  assert(
    seller.ready && seller.config.mode === "mainnet",
    "batch_mainnet_seller_required",
  );
  assert(env.LAB_BATCH_DATABASE_URL, "batch_database_required");
  const db = new URL(env.LAB_BATCH_DATABASE_URL);
  assert(
    ["postgres:", "postgresql:"].includes(db.protocol) &&
      /^\/lab_batch_[a-z0-9_]+$/.test(db.pathname),
    "separate_batch_database_required",
  );
  if (baseV2 || solanaV2) {
    const options = [...db.searchParams.entries()];
    assert(
      !db.hash &&
        (options.length === 0 ||
          (options.length === 1 &&
            options[0]![0] === "sslmode" &&
            ["disable", "require", "verify-ca", "verify-full"].includes(
              options[0]![1],
            ))),
      "batch_database_options_refused",
    );
  }
  const baseV2Config = baseV2
    ? continuationConfig(env.LAB_BASE_BATCH_CONTINUATION_CONFIG, seller, "base")
    : undefined;
  const solanaV2Config = solanaV2
    ? continuationConfig(env.LAB_SOLANA_CONTINUATION_CONFIG, seller, "solana")
    : undefined;
  const pool = new Pool({
    connectionString: env.LAB_BATCH_DATABASE_URL,
    max: 4,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30000,
    query_timeout: 10000,
    application_name: "402signal-lab-batches",
  });
  const merchants: BatchHttpMerchant[] = [];
  try {
    if (base) {
      const c = config(env.LAB_BASE_BATCH_CONFIG);
      assert(
        c.url === seller.config.origin + "/base/batch/sha256" &&
          c.channelConfig.receiver.toLowerCase() ===
            seller.config.rails.base.payTo.toLowerCase(),
        "base_batch_deployment_scope_refused",
      );
      assert(env.LAB_BASE_BATCH_CDP_TOKENS, "base_batch_cdp_tokens_required");
      const provider = new CdpBatchReadOnlyProvider(
        env.LAB_BASE_BATCH_CDP_TOKENS,
        c.campaignId,
      );
      const merchant = new BaseBatchMerchant(pool, c, provider);
      await merchant.initialize({ migrateSchema: false });
      merchants.push({
        path: merchant.path,
        authorizationHeader: "payment-signature",
        request: merchant.request.bind(merchant),
      });
    }
    if (solana) {
      const c = config(env.LAB_SOLANA_SESSION_CONFIG);
      assert(
        c.url === seller.config.origin + "/solana/session/sha256" &&
          c.policy.recipient === seller.config.rails.solana.payTo,
        "solana_session_deployment_scope_refused",
      );
      const endpoint = new URL(c.rpcUrl);
      assert(
        endpoint.protocol === "https:" &&
          !endpoint.username &&
          !endpoint.password &&
          !endpoint.hash,
        "solana_rpc_refused",
      );
      const readonly = new Set([
        "getGenesisHash",
        "getLatestBlockhash",
        "getSlot",
        "getAccountInfo",
        "getTransaction",
        "getSignatureStatuses",
        "getMinimumBalanceForRentExemption",
        "getFeeForMessage",
        "getBalance",
      ]);
      const rpc = async (method: string, params: unknown[]) => {
        assert(readonly.has(method), "readonly_rpc_required");
        const response = await http(c.rpcUrl, "POST", {
          jsonrpc: "2.0",
          id: 1,
          method,
          params,
        });
        assert(
          response.status === 200 && response.body && !response.body.error,
          "solana_rpc_unavailable",
        );
        return response.body.result;
      };
      const modulePath =
        "../../solana-session-contracts/src/merchant-session.mjs";
      const { createNativeSessionMerchant } = await import(modulePath);
      const merchant = await createNativeSessionMerchant({
        ledger: new BaseBatchLedger(pool, "solana-merchant-" + c.campaignId),
        rpc,
        url: c.url,
        policy: c.policy,
        perCallAtomic: c.perCallAtomic,
        maxCalls: c.maxCalls,
        migrateSchema: false,
      });
      merchants.push({
        path: merchant.path,
        authorizationHeader: "authorization",
        request: merchant.request.bind(merchant),
      });
    }
    if (baseV2Config) {
      assert(env.LAB_BASE_BATCH_CDP_TOKENS, "base_batch_cdp_tokens_required");
      const provider = new CdpBatchReadOnlyProvider(
        env.LAB_BASE_BATCH_CDP_TOKENS,
        baseV2Config.campaignId,
      );
      const merchant = new BaseBatchContinuationMerchant(
        pool,
        baseV2Config,
        provider,
      );
      await merchant.initialize({ migrateSchema: false });
      merchants.push({
        path: merchant.path,
        authorizationHeader: "payment-signature",
        request: merchant.request.bind(merchant),
      });
    }
    if (solanaV2Config) {
      const c = solanaV2Config;
      const modulePath =
        "../../solana-session-contracts/src/merchant-session-v2.mjs";
      const { createNativeContinuationMerchant } = await import(modulePath);
      const merchant = await createNativeContinuationMerchant({
        ledger: new BaseBatchLedger(
          pool,
          "solana-continuation-merchant-" + c.campaignId,
        ),
        rpc: continuationRpc(c.rpcUrl),
        url: c.url,
        policy: c.policy,
        perCallAtomic: c.perCallAtomic,
        maxCalls: c.maxCalls,
        expiresAt: c.expiresAt,
        migrateSchema: false,
      });
      merchants.push({
        path: merchant.path,
        authorizationHeader: "authorization",
        request: merchant.request.bind(merchant),
      });
    }
    return { merchants, close: () => pool.end() };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

/** Preserve existing rail configuration behavior; add independently gated manifests. */
export async function configuredBatchHttpMerchants(
  seller: Seller,
  env: NodeJS.ProcessEnv = process.env,
) {
  const existing = await configuredExistingBatchHttpMerchants(seller, env);
  try {
    const algorand = await configuredAlgorandManifestMerchants(seller, env);
    return {
      merchants: [...existing.merchants, ...algorand.merchants],
      close: async () => {
        await Promise.all([existing.close(), algorand.close()]);
      },
    };
  } catch (error) {
    await existing.close();
    throw error;
  }
}
