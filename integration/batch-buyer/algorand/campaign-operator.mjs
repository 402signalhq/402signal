// Private operator composition; network and signing callbacks belong to the buyer.
import { BuyerJournal } from "../../reference-buyer/journal.mjs";
import { canonical, check, digest } from "../../reference-buyer/policy.mjs";
import { verifyBatchRoute } from "../../../sdk/route-guard/batch.mjs";
import {
  algorandBatchRequest,
  algorandBatchManifest,
  buildAlgorandBatchTransactions,
  prepareAlgorandBatch,
  executeAlgorandBatch,
  confirmAlgorandBatchOnce,
} from "../../lab/dist/src/algorand-batch.js";
const NETWORK = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const UNKNOWN = {
  status: 503,
  body: { error: "campaign_outcome_unknown", new_payment_allowed: false },
};
const clone = (x) => JSON.parse(canonical(x));
const exact = (x, keys) =>
  check(
    x && Object.keys(x).sort().join(",") === keys.sort().join(","),
    "campaign_policy_refused",
  );
function pinnedHttps(s) {
  const u = new URL(s);
  check(
    u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.hash &&
      !u.search &&
      !u.port,
    "campaign_url_refused",
  );
  return s;
}
function validate(input) {
  const p = clone(input);
  exact(p, [
    "version",
    "campaignMaximumAtomic",
    "buyer",
    "url",
    "buyerLimits",
    "trustedLogVkey",
    "router",
    "rpcUrl",
  ]);
  check(
    p.version === 1 &&
      p.campaignMaximumAtomic === "5000" &&
      typeof p.buyer === "string" &&
      /^[A-Z2-7]{58}$/.test(p.buyer),
    "campaign_policy_refused",
  );
  algorandBatchRequest(p.url, new URL(p.url).origin);
  pinnedHttps(p.rpcUrl);
  check(
    typeof p.trustedLogVkey === "string" && p.trustedLogVkey.length < 1024,
    "campaign_policy_refused",
  );
  exact(p.buyerLimits, [
    "network",
    "asset",
    "recipient",
    "fee_payer",
    "max_total_amount_atomic",
    "max_sponsor_fee_micro_algo",
  ]);
  check(
    p.buyerLimits.network === NETWORK &&
      p.buyerLimits.asset === "31566704" &&
      p.buyerLimits.max_total_amount_atomic === "2000" &&
      p.buyerLimits.max_sponsor_fee_micro_algo === "15000",
    "campaign_policy_refused",
  );
  exact(p.router, [
    "url",
    "network",
    "asset",
    "recipient",
    "feePayer",
    "maximumAtomic",
    "maximumBuyerNativeFeeAtomic",
  ]);
  pinnedHttps(p.router.url);
  check(
    p.router.network === NETWORK &&
      p.router.asset === "31566704" &&
      p.router.maximumAtomic === "3000" &&
      p.router.maximumBuyerNativeFeeAtomic === "0",
    "campaign_policy_refused",
  );
  for (const a of [
    p.buyerLimits.recipient,
    p.buyerLimits.fee_payer,
    p.router.recipient,
    p.router.feePayer,
  ])
    check(
      typeof a === "string" && /^[A-Z2-7]{58}$/.test(a) && a !== p.buyer,
      "campaign_policy_refused",
    );
  // Validate all pinned Algorand addresses and fee roles before a router callback.
  // This only constructs unsigned synthetic bytes; it never calls a wallet or RPC.
  for (const authority of [
    { recipient: p.buyerLimits.recipient, feePayer: p.buyerLimits.fee_payer },
    p.router,
  ]) {
    buildAlgorandBatchTransactions(
      {
        scheme: "exact",
        network: NETWORK,
        asset: "31566704",
        amount: "1000",
        payTo: authority.recipient,
        maxTimeoutSeconds: 60,
        extra: { feePayer: authority.feePayer },
      },
      p.buyer,
      1n,
      2n,
    );
  }
  return p;
}
function routeRequest(p) {
  return {
    url: p.url,
    merchant_profile: "algorand-atomic-batch-v1",
    buyer_limits: p.buyerLimits,
    require_route_binding: true,
  };
}
/** The caller's routeOnce must use the existing strict Algorand lab payer and
 * durable RouteClient; it gets exactly one call and must enforce every router pin.
 * confirmRouter independently checks the exact chain transaction and returns
 * {state,network,asset,buyer,recipient,feePayer,amountAtomic,buyerNativeFeeAtomic}.
 * Callback success is never treated as independent confirmation by this module.
 */
export class AlgorandBatchCampaign {
  #p;
  #journal;
  #clock;
  constructor(
    directory,
    policy,
    { clock = () => Math.floor(Date.now() / 1000) } = {},
  ) {
    this.#p = validate(policy);
    this.#journal = new BuyerJournal(directory, this.#p);
    this.#clock = clock;
  }
  quote() {
    return planAlgorandBatchCampaign(this.#p);
  }
  #confirmedRouter(value) {
    const p = this.#p;
    check(
      value?.state === "confirmed" &&
        value.network === p.router.network &&
        value.asset === p.router.asset &&
        value.buyer === p.buyer &&
        value.recipient === p.router.recipient &&
        value.feePayer === p.router.feePayer &&
        value.amountAtomic === "3000" &&
        value.buyerNativeFeeAtomic === "0",
      "router_confirmation_required",
    );
  }
  #proof(route, challenge) {
    return verifyBatchRoute({
      routeResponseJson: route.routeResponseJson,
      routeRequestJson: canonical(routeRequest(this.#p)),
      trustedLogVkey: this.#p.trustedLogVkey,
      challenge,
      now: this.#clock(),
    });
  }
  #plan(saved) {
    return prepareAlgorandBatch({
      ...saved,
      raw: saved.raw.map((b) => Buffer.from(b, "base64")),
    });
  }
  #ledger(id) {
    const j = this.#journal;
    return {
      lookup: (group, scope) => {
        const claim = j.get(id, "merchant_claim");
        if (!claim) return undefined;
        check(
          claim.group === group && claim.scope === scope,
          "merchant_claim_conflict",
        );
        return {
          run: false,
          outcome: j.get(id, "merchant_response") ?? UNKNOWN,
        };
      },
      reserve: (group, scope) => {
        j.put(id, "merchant_claim", { group, scope });
        return { run: true };
      },
      attempting: (group) => j.put(id, "merchant_attempting", { group }),
      finish: (_group, _state, outcome) =>
        j.put(id, "merchant_response", outcome),
    };
  }
  async run(id, hooks) {
    const p = this.#p,
      j = this.#journal,
      request = routeRequest(p);
    // Full immutable reservation and stage claim precede any economic callback.
    j.reserve(id, request, "5000");
    j.put(id, "router_claim", { maximumAtomic: "3000", policy: p.router });
    const route = await hooks.routeOnce(canonical(request), clone(p.router));
    check(
      route &&
        typeof route.routeResponseJson === "string" &&
        Buffer.byteLength(route.routeResponseJson) <= 262144,
      "route_response_refused",
    );
    j.put(id, "router_result", route);
    const confirmed = await hooks.confirmRouter(clone(route), clone(p.router));
    this.#confirmedRouter(confirmed);
    j.put(id, "router_confirmation", confirmed);
    const challenge = await hooks.readSellerChallenge(p.url),
      observed = this.#proof(route, challenge);
    check(
      observed.profile === "algorand-atomic-batch-v1",
      "merchant_profile_refused",
    );
    const requirement = JSON.parse(
      challenge.bodyText ||
        Buffer.from(challenge.paymentRequired, "base64").toString("utf8"),
    ).accepts[0];
    const manifest = algorandBatchManifest(
      p.url,
      new URL(p.url).origin,
      requirement,
    );
    check(
      canonical(manifest) === canonical(observed.terms),
      "merchant_manifest_refused",
    );
    const params = await hooks.suggestedParams();
    check(
      params &&
        params.genesisHash === NETWORK.slice(9) &&
        params.genesisId === "mainnet-v1.0" &&
        params.minimumFee === "1000" &&
        params.feePerByte === "0" &&
        /^[1-9][0-9]{0,12}$/.test(params.firstValid) &&
        /^[1-9][0-9]{0,12}$/.test(params.lastValid),
      "network_parameters_refused",
    );
    const first = BigInt(params.firstValid),
      last = BigInt(params.lastValid);
    check(last > first && last - first <= 1000n, "network_validity_refused");
    const raw = buildAlgorandBatchTransactions(
      requirement,
      p.buyer,
      first,
      last,
    );
    const input = {
      url: p.url,
      origin: new URL(p.url).origin,
      requirement,
      buyer: p.buyer,
      raw,
      maxSpendAtomic: "2000",
      manifest,
    };
    const plan = prepareAlgorandBatch(input);
    j.put(id, "merchant_plan", {
      ...input,
      raw: raw.map((b) => Buffer.from(b).toString("base64")),
    });
    const outcome = await executeAlgorandBatch(
      this.#ledger(id),
      plan,
      hooks.signGroup,
      async (url, payment) => {
        // Exact signed group survives an uncertain HTTP response. Recovery is read-only.
        j.put(id, "merchant_wire", { url, payment });
        return hooks.sendSeller(url, clone(payment));
      },
      async () => {
        this.#proof(route, challenge);
      },
    );
    return this.#reconcile(id, plan, outcome, hooks);
  }
  async #reconcile(id, plan, outcome, hooks) {
    const confirmation = await confirmAlgorandBatchOnce(
      plan,
      this.#p.rpcUrl,
      hooks.readAlgod,
    );
    const expected = algorandBatchRequest(
      plan.url,
      new URL(plan.url).origin,
    ).items;
    const delivered =
      outcome?.status === 200 &&
      outcome.body?.batch?.groupId === plan.group.groupId &&
      canonical(outcome.body.batch.items) ===
        canonical(
          expected.map((x, i) => ({
            ...x,
            transaction: plan.group.transfers[i].transaction,
            amount_atomic: "1000",
          })),
        ) &&
      outcome.body.billing?.amount_atomic === "2000";
    const complete = confirmation.state === "confirmed" && delivered;
    if (complete && this.#journal.job(id).state === "reserved") {
      this.#journal.put(id, "completed_evidence", { confirmation, outcome });
      this.#journal.finish(id, "complete");
    }
    return {
      state: complete ? "complete" : "unresolved",
      newPaymentAllowed: false,
      confirmation,
      delivered,
      groupId: plan.group.groupId,
      quote: this.quote(),
    };
  }
  async recover(id, hooks) {
    const j = this.#journal;
    j.job(id);
    const saved = j.get(id, "merchant_plan"),
      wire = j.get(id, "merchant_wire");
    // Never create a missing stage, sign, replay an economic request, or resume spending.
    if (!saved || !wire)
      return {
        state: "unresolved",
        newPaymentAllowed: false,
        stage: saved ? "merchant_signing" : "router_or_proof",
      };
    const outcome = j.get(id, "merchant_response");
    const cached =
      outcome?.status === 200
        ? outcome
        : await hooks.recoverSeller(wire.url, clone(wire.payment), {
            "Replay-Only": "1",
          });
    return this.#reconcile(id, this.#plan(saved), cached, hooks);
  }
  close() {
    this.#journal.close();
  }
}

export function planAlgorandBatchCampaign(policy) {
  validate(policy);
  return {
    campaignMaximumAtomic: "5000",
    routerMaximumAtomic: "3000",
    merchantTotalAtomic: "2000",
    merchantItemCount: 2,
    merchantItemAtomic: "1000",
    buyerNativeFeeAtomic: "0",
    expectedMerchantSponsorFeeMicroAlgo: "3000",
    maximumMerchantSponsorFeeMicroAlgo: "15000",
    routerSponsorFeeMicroAlgo: "requires_independent_confirmation",
    newPurchases: false,
  };
}
