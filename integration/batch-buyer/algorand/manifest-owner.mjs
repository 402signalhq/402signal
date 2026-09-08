/** Owner-only staged runner. No service keys, automatic retries or payment forwarding in recovery. */
import { join } from "node:path";
import { BuyerJournal } from "../../reference-buyer/journal.mjs";
import {
  canonical,
  check,
  strictJson,
  decode64,
} from "../../reference-buyer/policy.mjs";
import { verifyBatchRoute } from "../../../sdk/route-guard/batch.mjs";
import { RouteClient } from "../../../sdk/route-guard/client.mjs";
import { FileAttemptStore } from "../../../sdk/route-guard/file-store.mjs";
import { createAlgorandOwnerHooks } from "./owner-hooks.mjs";
import { AlgorandManifestStore } from "./manifest-store.mjs";
import {
  buildAlgorandManifestTransactions,
  prepareAlgorandManifest,
  executeAlgorandManifest,
  recoverAlgorandManifest,
  confirmAlgorandManifestOnce,
} from "./manifest.mjs";
import { validateAlgorandManifestLimits } from "../../../sdk/route-guard/batch-profiles/algorand-manifest.mjs";
const NET = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const copy = (x) => JSON.parse(canonical(strictJson(canonical(x))));
const freeze = (x) => {
  if (x && typeof x === "object") {
    for (const v of Object.values(x)) freeze(v);
    Object.freeze(x);
  }
  return x;
};
function exact(x, keys) {
  check(
    x && Object.keys(x).sort().join(",") === keys.split(",").sort().join(","),
    "campaign_config_refused",
  );
}
function https(s, origin = false) {
  const u = new URL(s);
  check(
    u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.port &&
      !u.hash &&
      (!origin || !u.search) &&
      (origin ? u.origin === s : u.href === s),
    "campaign_url_refused",
  );
  return s;
}
export function validateManifestOwnerConfig(input) {
  const c = copy(input);
  exact(
    c,
    "version,campaignId,sourceCommit,sourceTree,releasePinsSha256,buyer,createdAt,expiresAt,rpcUrl,routeRequest,trustedLogVkey,router,budget,recoveryContract,newPaymentOnUnknown,commercialFee,hostedGroupPolicy",
  );
  check(
    c.version === 1 &&
      /^[A-Za-z0-9_-]{8,64}$/.test(c.campaignId) &&
      /^[0-9a-f]{40}$/.test(c.sourceCommit) &&
      /^[0-9a-f]{40}$/.test(c.sourceTree) &&
      /^[0-9a-f]{64}$/.test(c.releasePinsSha256),
    "campaign_identity_refused",
  );
  check(
    Number.isSafeInteger(c.createdAt) &&
      Number.isSafeInteger(c.expiresAt) &&
      c.expiresAt > c.createdAt &&
      c.expiresAt - c.createdAt <= 14400000,
    "campaign_deadline_refused",
  );
  exact(
    c.routeRequest,
    "url,merchant_profile,buyer_limits,require_route_binding",
  );
  https(c.routeRequest.url);
  https(c.rpcUrl, true);
  const p = c.routeRequest.merchant_profile,
    l = c.routeRequest.buyer_limits;
  validateAlgorandManifestLimits(p, l);
  check(
    c.routeRequest.require_route_binding === true &&
      l.job_hashes.length === 3 &&
      l.max_total_amount_atomic === "3000" &&
      l.max_sponsor_fee_micro_algo ===
        (p === "algorand-atomic-multi-item-v1" ? "4000" : "2000") &&
      (p !== "algorand-atomic-multi-item-v1" ||
        l.max_item_amount_atomic === "1000"),
    "campaign_economics_refused",
  );
  exact(
    c.router,
    "url,network,asset,recipient,feePayer,maximumAtomic,maximumSponsorFeeMicroAlgo,maximumBuyerNativeFeeAtomic",
  );
  https(c.router.url);
  check(
    c.router.network === NET &&
      c.router.asset === "31566704" &&
      c.router.maximumAtomic === "3000" &&
      c.router.maximumSponsorFeeMicroAlgo === "2000" &&
      c.router.maximumBuyerNativeFeeAtomic === "0",
    "router_economics_refused",
  );
  exact(
    c.budget,
    "maximumRouteObservations,maximumMerchantSubmissions,maximumUSDCAtomic,maximumMerchantAtomic,maximumMerchantSponsorFeeMicroAlgo,maximumBuyerNativeFeeAtomic",
  );
  check(
    c.budget.maximumRouteObservations === 1 &&
      c.budget.maximumMerchantSubmissions === 1 &&
      c.budget.maximumUSDCAtomic === "6000" &&
      c.budget.maximumMerchantAtomic === "3000" &&
      c.budget.maximumMerchantSponsorFeeMicroAlgo ===
        l.max_sponsor_fee_micro_algo &&
      c.budget.maximumBuyerNativeFeeAtomic === "0" &&
      c.recoveryContract === "digest-only-read-v1" &&
      c.newPaymentOnUnknown === false,
    "campaign_budget_refused",
  );
  check(
    typeof c.buyer === "string" &&
      /^[A-Z2-7]{58}$/.test(c.buyer) &&
      ![
        l.recipient,
        l.fee_payer,
        c.router.recipient,
        c.router.feePayer,
      ].includes(c.buyer) &&
      typeof c.trustedLogVkey === "string" &&
      c.trustedLogVkey.length < 1024,
    "campaign_roles_refused",
  );
  return freeze(c);
}
export function manifestOwnerPolicy(c) {
  const p = validateManifestOwnerConfig(c);
  return freeze({
    ...p,
    campaignMaximumAtomic: "6000",
    url: p.routeRequest.url,
    buyerLimits: p.routeRequest.buyer_limits,
  });
}
export class ManifestOwnerCampaign {
  constructor(
    directory,
    config,
    {
      owner,
      fetch = globalThis.fetch,
      clock = () => Math.floor(Date.now() / 1000),
      pause = (ms) => new Promise((r) => setTimeout(r, ms)),
    } = {},
  ) {
    this.c = validateManifestOwnerConfig(config);
    this.p = manifestOwnerPolicy(this.c);
    this.id = this.c.campaignId;
    this.clock = clock;
    this.fetch = fetch;
    this.owner = owner;
    this.j = new BuyerJournal(directory, this.p);
    try {
      const job = this.j.job(this.id);
      check(
        canonical(job.request) === canonical(this.c.routeRequest) &&
          job.reserved === 6000,
        "campaign_reservation_changed",
      );
    } catch (e) {
      if (e.message !== "unknown_job") throw e;
      this.j.reserve(this.id, this.c.routeRequest, "6000");
    }
    this.m = new AlgorandManifestStore(join(directory, "manifest.sqlite"));
    const routedFetch = async (url, opt) => {
      if (
        url === this.p.router.url &&
        new Headers(opt?.headers).has("Payment-Signature") &&
        new Headers(opt?.headers).get("Replay-Only") !== "1"
      )
        this.fresh();
      return fetch(url, opt);
    };
    this.h = createAlgorandOwnerHooks(this.p, {
      directory,
      id: this.id,
      owner,
      fetch: routedFetch,
      pause,
      clock,
    });
    this.client = new RouteClient({
      store: new FileAttemptStore(join(directory, "route-client")),
      routerUrl: this.p.router.url,
      recoveryProfile: "http-route-v1",
      fetch,
      timeoutMs: 75000,
    });
  }
  put(part, value) {
    const old = this.j.get(this.id, part);
    if (old) {
      check(canonical(old) === canonical(value), "retained_evidence_conflict");
      return;
    }
    this.j.put(this.id, part, value);
  }
  fresh() {
    check(
      this.clock() * 1000 >= this.c.createdAt &&
        this.clock() * 1000 < this.c.expiresAt,
      "campaign_expired",
    );
  }
  routeEvidence(text) {
    const b = strictJson(text);
    check(
      b.billing?.settled === true &&
        b.billing.settlement_attempted === true &&
        b.billing.settlement_state === "settled" &&
        b.billing.model === "success_only_v1" &&
        b.billing.amount_atomic === "3000" &&
        b.billing.asset === "USDC" &&
        b.billing.rail === "algorand",
      "router_settlement_unknown",
    );
    return b;
  }
  confirmed(v) {
    const p = this.p;
    check(
      v?.state === "confirmed" &&
        v.network === NET &&
        v.asset === "31566704" &&
        v.buyer === p.buyer &&
        v.recipient === p.router.recipient &&
        v.feePayer === p.router.feePayer &&
        v.amountAtomic === "3000" &&
        v.buyerNativeFeeAtomic === "0" &&
        v.sponsorFeeMicroAlgo === "2000" &&
        v.transactions?.length === 2,
      "router_confirmation_required",
    );
    return v;
  }
  proof() {
    this.fresh();
    const r = this.j.get(this.id, "router_result");
    check(r, "router_result_required");
    const b = this.routeEvidence(r.routeResponseJson);
    return verifyBatchRoute({
      routeResponseJson: r.routeResponseJson,
      routeRequestJson: canonical(this.c.routeRequest),
      trustedLogVkey: this.c.trustedLogVkey,
      challenge: b.batch_binding.challenge,
      now: this.clock(),
    });
  }
  async route() {
    this.fresh();
    check(!this.j.get(this.id, "router_claim"), "router_already_claimed");
    this.j.put(this.id, "router_claim", {
      maximumAtomic: "3000",
      policy: this.p.router,
    });
    const r = await this.h.routeOnce(
      canonical(this.c.routeRequest),
      copy(this.p.router),
    );
    this.routeEvidence(r.routeResponseJson);
    this.put("router_result", r);
    const conf = this.confirmed(await this.h.confirmRouter());
    this.put("router_confirmation", conf);
    return this.status();
  }
  async read(url, headers = {}) {
    check(
      url === this.p.url ||
        url === this.p.rpcUrl + "/v2/transactions/params" ||
        (url.startsWith(this.p.rpcUrl + "/v2/transactions/pending/") &&
          /^[A-Z2-7]{52}$/.test(
            url.slice((this.p.rpcUrl + "/v2/transactions/pending/").length),
          )),
      "owner_transport_scope_refused",
    );
    const r = await this.fetch(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    check(!r.url || r.url === url, "response_target_changed");
    check(
      Number(r.headers.get("content-length") || 0) <= 262144,
      "response_too_large",
    );
    const chunks = [];
    let n = 0;
    const reader = r.body?.getReader();
    if (reader)
      try {
        for (;;) {
          const p = await reader.read();
          if (p.done) break;
          n += p.value.length;
          check(n <= 262144, "response_too_large");
          chunks.push(p.value);
        }
      } catch (e) {
        await reader.cancel().catch(() => {});
        throw e;
      }
    const bodyText = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
    return {
      status: r.status,
      body: bodyText ? strictJson(bodyText) : null,
      recoveryOnly: r.headers.get("Replay-Only") === "1",
    };
  }
  plan(saved) {
    return prepareAlgorandManifest({
      ...saved,
      raw: saved.raw.map((x) => Buffer.from(x, "base64")),
    });
  }
  async deliver() {
    this.fresh();
    check(this.owner?.signGroup, "owner_signer_required");
    check(!this.j.get(this.id, "merchant_plan"), "merchant_already_claimed");
    this.confirmed(this.j.get(this.id, "router_confirmation"));
    const binding = this.proof();
    const ch = binding.challenge;
    check(ch.wwwAuthenticate === null, "merchant_challenge_conflict");
    const envelope = copy(
      ch.paymentRequired
        ? decode64(ch.paymentRequired)
        : strictJson(ch.bodyText),
    );
    const input = {
      profile: this.c.routeRequest.merchant_profile,
      envelope,
      limits: this.c.routeRequest.buyer_limits,
      buyer: this.c.buyer,
    };
    const plan = prepareAlgorandManifest({
      ...input,
      raw: buildAlgorandManifestTransactions(
        input.profile,
        envelope,
        input.limits,
        input.buyer,
      ),
    });
    check(
      plan.group.totalAtomic === "3000" && plan.manifest.jobCount === 3,
      "merchant_economics_refused",
    );
    this.j.put(this.id, "merchant_plan", {
      ...input,
      raw: plan.raw.map((x) => Buffer.from(x).toString("base64")),
    });
    const out = await executeAlgorandManifest(this.m, this.id, plan, {
      authorize: async (p) => {
        this.proof();
        this.confirmed(this.j.get(this.id, "router_confirmation"));
        check(
          p.scope === plan.scope && this.j.job(this.id).reserved === 6000,
          "merchant_scope_conflict",
        );
      },
      readParams: async () => {
        const x = await this.read(this.p.rpcUrl + "/v2/transactions/params");
        check(x.status === 200, "params_unavailable");
        return x.body;
      },
      sign: async (raw, indexes) => this.owner.signGroup(raw, indexes, plan),
      send: async (url, payment) => {
        this.proof();
        return this.read(url, {
          "Payment-Signature": Buffer.from(canonical(payment)).toString(
            "base64",
          ),
        });
      },
      now: this.clock,
    });
    return this.reconcile(plan, out);
  }
  async reconcile(plan, out) {
    const confirmation = await confirmAlgorandManifestOnce(
      plan,
      this.p.rpcUrl,
      (u) => this.read(u),
    );
    if (out.status === 200 && confirmation.state === "confirmed") {
      this.put("completed_evidence", { confirmation, outcome: out });
      if (this.j.job(this.id).state === "reserved")
        this.j.finish(this.id, "complete");
    }
    return {
      ...this.status(),
      confirmation,
      receiptAccepted: out.status === 200,
    };
  }
  async recover() {
    const saved = this.j.get(this.id, "merchant_plan");
    if (saved) {
      const plan = this.plan(saved),
        out = await recoverAlgorandManifest(
          this.m,
          this.id,
          plan,
          async (q) => {
            check(
              Object.keys(q).sort().join(",") ===
                "authorizationDigest,groupId,recoveryOnly,requestDigest,url" &&
                q.recoveryOnly === true,
              "readonly_recovery_required",
            );
            return this.read(q.url, {
              "Replay-Only": "1",
              "Manifest-Group-Id": q.groupId,
              "Manifest-Request-Digest": q.requestDigest,
              "Manifest-Authorization-Digest": q.authorizationDigest,
            });
          },
        );
      return this.reconcile(plan, out);
    }
    if (!this.j.get(this.id, "router_sign_claim")) return this.status();
    const out = await this.client.recover(this.id);
    if (
      out.response?.status === 200 &&
      out.classification?.settlementReport === "settled"
    ) {
      this.routeEvidence(out.response.bodyText);
      const confirmation = this.confirmed(await this.h.confirmRouter());
      this.put("router_result", { routeResponseJson: out.response.bodyText });
      this.put("router_confirmation", confirmation);
    }
    return this.status();
  }
  async run() {
    await this.route();
    return this.deliver();
  }
  status() {
    const job = this.j.job(this.id);
    return {
      state:
        job.state === "complete"
          ? "complete"
          : this.j.get(this.id, "merchant_plan")
            ? "merchant_unknown"
            : this.j.get(this.id, "router_confirmation")
              ? "route_confirmed"
              : this.j.get(this.id, "router_claim")
                ? "router_unknown"
                : "prepared",
      campaignId: this.id,
      maximumUSDCAtomic: "6000",
      maximumRouteObservations: 1,
      maximumMerchantSubmissions: 1,
      newPaymentAllowed: false,
      sourceCommit: this.c.sourceCommit,
    };
  }
  close() {
    this.h.close();
    this.m.close();
    this.j.close();
  }
}
