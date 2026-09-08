import { isValidAlgorandAddress } from "@x402/avm";
/** Optional two-campaign lab registration. No wallet/master credentials. */
import {
  readFileSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Seller } from "./seller.js";
import type { BatchHttpMerchant } from "./http-server.js";
import { assert, parseJson, canonical, digest } from "./json.js";
import { http } from "./transport.js";
import {
  AlgorandManifestSeller,
  type AlgorandManifestMerchantConfig,
} from "./algorand-manifest-seller.js";
import { AlgorandManifestStore } from "./algorand-manifest-store.js";
import {
  createAlgorandManifestOffer,
  quoteAlgorandManifestFees,
  type AlgorandManifestProfile,
} from "./algorand-manifest.js";
export const ALGORAND_MANIFEST_OPT_IN = "reviewed-explicit-job-manifests-v2";
export const ALGORAND_MANIFEST_PATHS = {
  "algorand-atomic-multi-item-v1": "/algorand/manifests/group",
  "algorand-aggregate-invoice-v1": "/algorand/manifests/invoice",
} as const;
const NETWORK = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
  ASSET = "31566704";
function exact(value: any, keys: string) {
  assert(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(",") === keys,
    "algorand_manifest_config_refused",
  );
}
function uint(s: any) {
  assert(
    typeof s === "string" &&
      /^[1-9][0-9]{0,19}$/.test(s) &&
      BigInt(s) <= 2n ** 64n - 1n,
    "algorand_manifest_amount_refused",
  );
  return BigInt(s);
}
export async function configuredAlgorandManifestMerchants(
  seller: Seller,
  env: NodeJS.ProcessEnv = process.env,
) {
  const flag = env.LAB_ALGORAND_MANIFESTS ?? "";
  assert(
    !flag || flag === ALGORAND_MANIFEST_OPT_IN,
    "algorand_manifest_opt_in_refused",
  );
  if (!flag)
    return { merchants: [] as BatchHttpMerchant[], close: async () => {} };
  assert(
    seller.ready && seller.config.mode === "mainnet",
    "algorand_manifest_mainnet_required",
  );
  const origin = new URL(seller.config.origin);
  assert(
    origin.protocol === "https:" && origin.origin === seller.config.origin,
    "algorand_manifest_origin_refused",
  );
  const file = env.LAB_ALGORAND_MANIFEST_CONFIG;
  assert(file, "algorand_manifest_config_required");
  const st = lstatSync(file);
  assert(
    st.isFile() && !st.isSymbolicLink() && st.size <= 16384,
    "algorand_manifest_config_refused",
  );
  const config = parseJson(readFileSync(file, "utf8"), 16384);
  exact(config, "algodUrl,campaigns,facilitatorUrl,version");
  assert(
    config.version === 1 &&
      Array.isArray(config.campaigns) &&
      config.campaigns.length === 2,
    "algorand_manifest_config_refused",
  );
  assert(
    config.facilitatorUrl === seller.config.rails.algorand.facilitatorUrl,
    "algorand_manifest_facilitator_refused",
  );
  const rpc = new URL(config.algodUrl);
  assert(
    typeof config.algodUrl === "string" &&
      config.algodUrl.length <= 4096 &&
      rpc.protocol === "https:" &&
      rpc.origin === config.algodUrl &&
      !rpc.username &&
      !rpc.password,
    "algorand_manifest_rpc_refused",
  );
  const sdk = seller.servers.get("algorand");
  assert(sdk, "algorand_manifest_sdk_required");
  const prepared: Array<{
    config: AlgorandManifestMerchantConfig;
    campaign: any;
  }> = [];
  const profiles = new Set(),
    ids = new Set();
  for (const c of config.campaigns) {
    exact(
      c,
      "amountAtomic,asset,buyer,campaignId,createdAt,expiresAt,feePayer,jobHashes,maxSponsorFeeMicroAlgo,maxTotalAmountAtomic,network,profile,recipient,url",
    );
    assert(
      typeof c.campaignId === "string" &&
        /^[A-Za-z0-9_-]{8,64}$/.test(c.campaignId) &&
        !ids.has(c.campaignId),
      "algorand_manifest_campaign_refused",
    );
    ids.add(c.campaignId);
    assert(
      Object.hasOwn(ALGORAND_MANIFEST_PATHS, c.profile) &&
        !profiles.has(c.profile),
      "algorand_manifest_profile_refused",
    );
    profiles.add(c.profile);
    assert(
      c.url ===
        seller.config.origin +
          ALGORAND_MANIFEST_PATHS[c.profile as AlgorandManifestProfile] &&
        c.network === NETWORK &&
        c.asset === ASSET &&
        c.recipient === seller.config.rails.algorand.payTo,
      "algorand_manifest_scope_refused",
    );
    assert(
      typeof c.buyer === "string" &&
        isValidAlgorandAddress(c.buyer) &&
        c.buyer !==
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ" &&
        c.buyer !== c.recipient &&
        c.buyer !== c.feePayer,
      "algorand_manifest_buyer_refused",
    );
    assert(
      Number.isSafeInteger(c.createdAt) &&
        Number.isSafeInteger(c.expiresAt) &&
        c.createdAt > 0 &&
        c.createdAt <= Date.now() &&
        c.expiresAt > c.createdAt &&
        c.expiresAt - c.createdAt <= 86400000,
      "algorand_manifest_deadline_refused",
    );
    const amount = uint(c.amountAtomic);
    uint(c.maxTotalAmountAtomic);
    uint(c.maxSponsorFeeMicroAlgo);
    const price =
      "$" +
      String(amount / 1000000n) +
      "." +
      String(amount % 1000000n).padStart(6, "0");
    const requirements = await sdk!.buildPaymentRequirements({
      scheme: "exact",
      network: NETWORK,
      payTo: c.recipient,
      price,
      maxTimeoutSeconds: 60,
    });
    assert(requirements.length === 1, "algorand_manifest_requirement_refused");
    const requirement = requirements[0]!;
    assert(
      requirement.network === NETWORK &&
        requirement.asset === ASSET &&
        requirement.amount === c.amountAtomic &&
        requirement.payTo === c.recipient &&
        requirement.extra?.feePayer === c.feePayer,
      "algorand_manifest_requirement_refused",
    );
    const limits = {
      network: NETWORK,
      asset: ASSET,
      recipient: c.recipient,
      fee_payer: c.feePayer,
      max_total_amount_atomic: c.maxTotalAmountAtomic,
      max_sponsor_fee_micro_algo: c.maxSponsorFeeMicroAlgo,
      job_hashes: c.jobHashes,
      ...(c.profile === "algorand-atomic-multi-item-v1"
        ? { max_item_amount_atomic: c.amountAtomic }
        : {}),
    };
    const count =
      c.profile === "algorand-atomic-multi-item-v1" ? c.jobHashes?.length : 1;
    // Pure validation only: the actual quote still requires a fresh independent RPC read.
    createAlgorandManifestOffer(
      c.profile,
      c.url,
      requirement,
      limits,
      quoteAlgorandManifestFees(
        {
          "genesis-hash": NETWORK.slice(9),
          "genesis-id": "mainnet-v1.0",
          "last-round": 1,
          fee: 0,
          "min-fee": 1000,
        },
        count,
        Math.floor(Date.now() / 1000),
      ),
    );
    prepared.push({
      config: {
        offerId: c.campaignId,
        profile: c.profile,
        url: c.url,
        requirement,
        limits,
        buyer: c.buyer,
      },
      campaign: c,
    });
  }
  const parent = dirname(resolve(seller.config.ledgerPath));
  assert(
    realpathSync(parent) === parent,
    "algorand_manifest_journal_parent_refused",
  );
  const dir = join(parent, "algorand-manifests");
  if (existsSync(dir)) {
    const st = lstatSync(dir);
    assert(
      st.isDirectory() && !st.isSymbolicLink(),
      "algorand_manifest_journal_refused",
    );
  } else mkdirSync(dir, { mode: 0o700 });
  const stores: AlgorandManifestStore[] = [],
    merchants: BatchHttpMerchant[] = [];
  try {
    for (const item of prepared) {
      const store = new AlgorandManifestStore(
        join(dir, item.campaign.campaignId + ".sqlite"),
      );
      stores.push(store);
      const binding = {
        version: 1,
        algodUrl: config.algodUrl,
        facilitatorUrl: config.facilitatorUrl,
        campaign: item.campaign,
      };
      store.once(digest("lab-algorand-manifest-registration-v1"), binding);
      assert(
        canonical(
          store.get(digest("lab-algorand-manifest-registration-v1")),
        ) === canonical(binding),
        "algorand_manifest_registration_conflict",
      );
      const merchant = new AlgorandManifestSeller(
        item.config,
        store,
        {
          verify: (p, r) => sdk!.verifyPayment(p, r),
          settle: (p, r) => sdk!.settlePayment(p, r),
        },
        async () => {
          const out = await http(
            config.algodUrl + "/v2/transactions/params",
            "GET",
          );
          assert(out.status === 200, "algorand_manifest_params_unavailable");
          return out.body;
        },
      );
      merchants.push({
        path: ALGORAND_MANIFEST_PATHS[item.config.profile],
        authorizationHeader: "payment-signature",
        recover: merchant.recover.bind(merchant),
        request: async (url, header, recoveryOnly) => {
          if (Date.now() >= item.campaign.expiresAt)
            return {
              status: 503,
              body: {
                error: "manifest_campaign_expired",
                new_payment_allowed: false,
              },
            };
          const out = await merchant.request(url, header, recoveryOnly);
          return out.status === 402
            ? { status: 402, bodyText: "", headers: out.headers }
            : out;
        },
      });
    }
    return {
      merchants,
      close: async () => {
        stores.forEach((s) => s.close());
      },
    };
  } catch (error) {
    stores.forEach((s) => s.close());
    throw error;
  }
}
