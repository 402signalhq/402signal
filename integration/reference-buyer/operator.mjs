import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { RouteClient } from "@402signal/route-guard/client";
import { FileAttemptStore } from "@402signal/route-guard/file-store";
import { BaseBuyer } from "./base-buyer.mjs";
import { BuyerJournal } from "./journal.mjs";
import { runSearch } from "./workflow.mjs";
import { check, atomic, strictJson } from "./policy.mjs";
/** Operator-owned files only. Default plan never opens a signer or sends traffic. */
export async function main(argv = process.argv.slice(2), env = process.env) {
  const [command = "plan", configPath, id, query] = argv;
  check(configPath, "configuration_file_required");
  const config = strictJson(readFileSync(resolve(configPath), "utf8"));
  check(
    config && config.policy && typeof config.directory === "string",
    "configuration_required",
  );
  if (command === "plan") {
    const sellers = config.policy.sellers.map((s) => ({
      seller: s.id,
      maximumUSDCAtomic: (3000n + atomic(s.maximumAtomic)).toString(),
      buyerNativeFeeAtomic: "0",
    }));
    console.log(
      JSON.stringify({
        operation: "plan",
        network: "eip155:8453",
        asset: "USDC",
        sellers,
        campaignMaximumAtomic: config.policy.campaignMaximumAtomic,
        paidActions: 0,
      }),
    );
    return;
  }
  check(
    ["run", "recover-router", "confirm-seller"].includes(command) && id,
    "explicit_operation_required",
  );
  check(
    env.REFERENCE_BUYER_ACK === "base-exact-only-once",
    "buyer_acknowledgement_required",
  );
  let account = {
    address: config.policy.buyerAddress,
    signTypedData: async () => {
      throw new Error("read_only_operation");
    },
  };
  if (command === "run") {
    check(
      typeof env.REFERENCE_BUYER_ACCOUNT_MODULE === "string",
      "caller_owned_account_module_required",
    );
    const module = await import(
      pathToFileURL(resolve(env.REFERENCE_BUYER_ACCOUNT_MODULE)).href
    );
    account = module.account;
  }
  const journal = new BuyerJournal(resolve(config.directory), config.policy);
  try {
    check(
      ["x402", "mppx"].includes(config.sellerPaymentClient ?? "x402"),
      "unsupported_seller_client",
    );
    let sellerOptions = {};
    if (config.sellerPaymentClient === "mppx") {
      const { mppxSellerPayload } = await import("./mppx-seller.mjs");
      sellerOptions = {
        createSellerPayload: mppxSellerPayload,
        sellerAuthorizationTiming: "recent",
      };
    }
    const buyer = new BaseBuyer({
      account,
      journal,
      policy: config.policy,
      ...sellerOptions,
    });
    const client = new RouteClient({
      store: new FileAttemptStore(
        join(resolve(config.directory), "route-attempts"),
      ),
      recoveryProfile: "http-route-v1",
      routerUrl: config.policy.routerUrl,
      customerKey: env.REFERENCE_BUYER_CUSTOMER_KEY,
    });
    let result;
    if (command === "run")
      result = await runSearch({
        id,
        query,
        sellerId: config.sellerId ?? "agentstools",
        buyer,
        client,
        trustedLogVkey: config.trustedLogVkey,
      });
    if (command === "recover-router") {
      const outcome = await client.recover(id);
      result = {
        state: (await buyer.confirmRouting(id, outcome))
          ? "routing_payment_confirmed"
          : "routing_confirmation_unknown",
        sellerExecution: false,
      };
    }
    if (command === "confirm-seller")
      result = await buyer.reconcileSeller(id, query);
    console.log(
      JSON.stringify({
        state: result.state,
        deliveryQuality: result.deliveryQuality ?? "not_assessed",
        privateEvidenceRetained: true,
      }),
    );
  } finally {
    journal.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch(() => {
    console.error(
      JSON.stringify({
        state: "stopped",
        code: "operation_stopped",
        newPaymentAllowed: false,
      }),
    );
    process.exitCode = 1;
  });
