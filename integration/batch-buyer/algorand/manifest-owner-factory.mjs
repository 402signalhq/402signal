/** Explicit owner-side wallet adapter. Key read occurs only inside a guarded sign callback. */
import { createRequire } from "node:module";
import { manifestOwnerPolicy } from "./manifest-owner.mjs";
import { canonical, check, strictJson } from "../../reference-buyer/policy.mjs";
import { prepareAlgorandManifest } from "./manifest.mjs";
import { checkAlgorandGroup } from "../../lab/dist/src/mainnet-policy.js";
const require = createRequire(
  new URL("../../lab/package.json", import.meta.url),
);
const { toClientAvmSigner } = await import(require.resolve("@x402/avm"));
const { x402Client } = await import(require.resolve("@x402/core/client"));
const { ExactAvmScheme } = await import(
  require.resolve("@x402/avm/exact/client")
);
const { AlgorandClient } = await import(
  require.resolve("@algorandfoundation/algokit-utils/algorand-client")
);
const { decodeTransaction } = await import(
  require.resolve("@algorandfoundation/algokit-utils/transact")
);
export function createManifestOwner(
  config,
  env = process.env,
  { fetch = globalThis.fetch } = {},
) {
  const p = manifestOwnerPolicy(config);
  function local() {
    check(
      Date.now() >= p.createdAt && Date.now() < p.expiresAt,
      "campaign_expired",
    );
    const s = env.LAB_BUYER_ALGORAND_KEY_B64;
    check(
      typeof s === "string" &&
        Buffer.from(s, "base64").length === 64 &&
        Buffer.from(s, "base64").toString("base64") === s,
      "owner_key_refused",
    );
    const account = toClientAvmSigner(s);
    check(account.address === p.buyer, "owner_address_refused");
    return account;
  }
  return {
    async routerSigner(rail, challenge) {
      check(
        rail === "algorand" && challenge.accepts.length === 1,
        "router_rail_refused",
      );
      const req = challenge.accepts[0];
      check(
        req.network === p.router.network &&
          req.asset === p.router.asset &&
          req.amount === "3000" &&
          req.payTo === p.router.recipient &&
          req.extra?.feePayer === p.router.feePayer &&
          challenge.resource.url === p.router.url,
        "router_terms_refused",
      );
      const url = p.rpcUrl + "/v2/transactions/params",
        response = await fetch(url, {
          method: "GET",
          headers: { Accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        });
      check(
        response.status === 200 && (!response.url || response.url === url),
        "rpc_unavailable",
      );
      let size = 0;
      const chunks = [],
        reader = response.body.getReader();
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          check(size <= 16384, "rpc_response_too_large");
          chunks.push(part.value);
        }
      } catch (e) {
        await reader.cancel().catch(() => {});
        throw e;
      }
      const params = strictJson(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        ),
        round = params["last-round"];
      check(
        params["genesis-hash"] === p.router.network.slice(9) &&
          params["genesis-id"] === "mainnet-v1.0" &&
          params["min-fee"] === 1000 &&
          params.fee === 0 &&
          Number.isSafeInteger(round) &&
          round > 0,
        "rpc_params_refused",
      );
      const algorand = AlgorandClient.fromConfig({
        algodConfig: { server: p.rpcUrl, token: "" },
      });
      algorand.getSuggestedParams = async () => ({
        flatFee: false,
        fee: 0n,
        firstValid: BigInt(round),
        lastValid: BigInt(round) + 1000n,
        genesisHash: Buffer.from(p.router.network.slice(9), "base64"),
        genesisId: "mainnet-v1.0",
        minFee: 1000n,
      });
      const client = new x402Client();
      client.register(
        req.network,
        new ExactAvmScheme(
          {
            address: p.buyer,
            signTransactions: async (raw, indexes) => {
              checkAlgorandGroup(raw, indexes ?? [], req, p.buyer);
              check(
                decodeTransaction(raw[0]).fee === 2000n,
                "router_sponsor_cap_refused",
              );
              return local().signTransactions(raw, indexes);
            },
          },
          { algorandClient: algorand },
        ),
      );
      const clean = { ...req, extra: { feePayer: req.extra.feePayer } };
      const payload = await client.createPaymentPayload({
        x402Version: 2,
        resource: challenge.resource,
        accepts: [clean],
      });
      return { ...payload, accepted: req };
    },
    async signGroup(raw, indexes, plan) {
      const checked = prepareAlgorandManifest({ ...plan, raw });
      check(
        checked.profile === p.routeRequest.merchant_profile &&
          checked.buyer === p.buyer &&
          checked.envelope.resource.url === p.url &&
          canonical(checked.limits) === canonical(p.buyerLimits) &&
          canonical(indexes) === canonical(checked.manifest.paymentIndices) &&
          checked.group.totalAtomic === "3000",
        "owner_manifest_refused",
      );
      return local().signTransactions(raw, indexes);
    },
  };
}
