import { readFileSync, lstatSync } from "node:fs";
import { Pool } from "pg";
import type { Seller } from "./seller.js";
import type { BatchHttpMerchant } from "./http-server.js";
import { BaseBatchMerchant } from "./base-batch-merchant.js";
import { BaseBatchLedger } from "./base-batch-ledger.js";
import { RemoteFacilitator, http } from "./transport.js";
import { assert, parseJson } from "./json.js";
export const BASE_BATCH_OPT_IN = "reviewed-two-voucher-profile-v1";
export const SOLANA_SESSION_OPT_IN = "reviewed-owner-open-push-v1";
function config(path: string | undefined) {
  assert(path, "batch_config_required");
  const st = lstatSync(path);
  assert(
    st.isFile() && !st.isSymbolicLink() && st.size <= 16384,
    "batch_config_refused",
  );
  return parseJson(readFileSync(path, "utf8"));
}
/** Independently gated self-test modules. No keys or new service are provisioned. */
export async function configuredBatchHttpMerchants(
  seller: Seller,
  env: NodeJS.ProcessEnv = process.env,
) {
  const base = env.LAB_BASE_BATCH ?? "",
    solana = env.LAB_SOLANA_PUSH_SESSION ?? "";
  assert(!base || base === BASE_BATCH_OPT_IN, "base_batch_opt_in_refused");
  assert(
    !solana || solana === SOLANA_SESSION_OPT_IN,
    "solana_session_opt_in_refused",
  );
  if (!base && !solana)
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
      const provider = new RemoteFacilitator(
        seller.config.rails.base.facilitatorUrl,
        undefined,
        env.LAB_BASE_FACILITATOR_AUTH,
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
    return { merchants, close: () => pool.end() };
  } catch (error) {
    await pool.end();
    throw error;
  }
}
