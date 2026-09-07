import type { Seller } from "./seller.js";
import { AlgorandBatchSeller } from "./algorand-batch-seller.js";
import { assert } from "./json.js";
export const ALGORAND_BATCH_OPT_IN = "reviewed-two-item-profile-v1";
export function configuredAlgorandBatchSeller(
  seller: Seller,
  env: NodeJS.ProcessEnv = process.env,
) {
  const flag = env.LAB_ALGORAND_ATOMIC_BATCH;
  if (flag === undefined || flag === "") return undefined;
  assert(flag === ALGORAND_BATCH_OPT_IN, "invalid_atomic_batch_opt_in");
  assert(
    seller.ready &&
      seller.config.mode === "mainnet" &&
      seller.config.priceAtomic === "1000",
    "atomic_batch_mainnet_profile_required",
  );
  const req = seller.requirements.get("algorand"),
    server = seller.servers.get("algorand");
  assert(req && server, "atomic_batch_not_ready");
  return new AlgorandBatchSeller(seller.config.origin, req, seller.ledger, {
    verify: (payment, requirements) =>
      server.verifyPayment(payment, requirements),
    settle: (payment, requirements) =>
      server.settlePayment(payment, requirements),
  });
}
