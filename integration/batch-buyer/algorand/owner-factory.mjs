// Owner-side entry only. This module is loaded by owner-cli run in WSL.
// Keys are never sent to the router, included in the capsule, or read in plan/recovery.
import { readFileSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { sdkSigner } from "../../lab/dist/src/signer-sdk.js";
import { checkAlgorandBatchGroup } from "../../lab/dist/src/batch-policy.js";
import { strictJson, check } from "../../reference-buyer/policy.mjs";
const require = createRequire(
  new URL("../../lab/package.json", import.meta.url),
);
const { toClientAvmSigner } = await import(require.resolve("@x402/avm"));
export function createOwnerGroupSigner(policy, env = process.env) {
  const requirement = {
    scheme: "exact",
    network: policy.buyerLimits.network,
    asset: "31566704",
    amount: "1000",
    payTo: policy.buyerLimits.recipient,
    maxTimeoutSeconds: 60,
    extra: { feePayer: policy.buyerLimits.fee_payer },
  };
  return async (raw, indexes) => {
    checkAlgorandBatchGroup(
      raw,
      indexes,
      [requirement, requirement],
      policy.buyer,
      "2000",
      15000n,
    );
    const text = env.LAB_BUYER_ALGORAND_KEY_B64;
    check(typeof text === "string", "owner_buyer_key_required");
    const key = Buffer.from(text, "base64");
    check(
      key.length === 64 && key.toString("base64") === text,
      "owner_buyer_key_refused",
    );
    const signer = toClientAvmSigner(text);
    check(signer.address === policy.buyer, "owner_buyer_address_refused");
    return signer.signTransactions(raw, indexes);
  };
}
export async function createAlgorandOwner(policy) {
  const path = process.env.ALGORAND_BATCH_EXACT_BUYER_CONFIG;
  check(
    typeof path === "string" && path.length > 0,
    "owner_buyer_config_required",
  );
  const stat = lstatSync(path);
  check(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16384,
    "owner_buyer_config_refused",
  );
  const config = strictJson(readFileSync(path, "utf8"), 16384);
  check(
    config.mode === "mainnet" &&
      config.routerUrl === policy.router.url &&
      config.sellerOrigin === new URL(policy.url).origin &&
      config.routerPayTo?.algorand === policy.router.recipient &&
      config.mainnet?.buyerAddresses?.algorand === policy.buyer &&
      config.mainnet?.rpcUrls?.algorand === policy.rpcUrl &&
      config.routePilot?.routerFeePayers?.algorand?.includes(
        policy.router.feePayer,
      ),
    "owner_exact_policy_mismatch",
  );
  return {
    routerSigner: sdkSigner(config, process.env, "router"),
    signGroup: createOwnerGroupSigner(policy),
  };
}
