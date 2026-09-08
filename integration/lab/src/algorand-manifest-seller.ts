/** Optional bounded merchant adapter. Its provider owns sponsor policy/keys. */
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentRequirements, PaymentPayload } from "@x402/core/types";
import {
  assert,
  canonical,
  digest,
  decode64,
  encode64,
  parseJson,
} from "./json.js";
import type { AlgorandManifestJournal } from "./algorand-manifest-store.js";
import {
  ALGORAND_MANIFEST_HEADER_MAX,
  type AlgorandManifestProfile,
  type AlgorandManifestLimits,
  type ManifestOutcome,
  type ManifestRecoveryRequest,
  quoteAlgorandManifestFees,
  checkCurrentAlgorandManifestQuote,
  createAlgorandManifestOffer,
  checkSignedAlgorandManifest,
} from "./algorand-manifest.js";

export interface AlgorandManifestMerchantConfig {
  offerId: string;
  profile: AlgorandManifestProfile;
  url: string;
  requirement: PaymentRequirements;
  limits: AlgorandManifestLimits;
  buyer: string;
}
const unavailable = (): ManifestOutcome => ({
  status: 503,
  body: { error: "manifest_recovery_unavailable", new_payment_allowed: false },
});
export class AlgorandManifestSeller {
  private config: AlgorandManifestMerchantConfig;
  private key: (stage: string) => string;
  constructor(
    config: AlgorandManifestMerchantConfig,
    private store: AlgorandManifestJournal,
    private provider: Pick<FacilitatorClient, "verify" | "settle">,
    private readParams: () => Promise<any>,
    private clock = () => Math.floor(Date.now() / 1000),
  ) {
    assert(
      /^[A-Za-z0-9_-]{1,64}$/.test(config.offerId),
      "manifest_offer_id_refused",
    );
    this.config = JSON.parse(canonical(config));
    this.key = (stage) =>
      digest(canonical(["merchant-manifest-v2", config.offerId, stage]));
    store.once(this.key("config"), this.config);
    assert(
      canonical(store.get(this.key("config"))) === canonical(this.config),
      "manifest_config_conflict",
    );
  }
  async challenge(url: string): Promise<ManifestOutcome> {
    assert(url === this.config.url, "manifest_url_refused");
    let envelope = this.store.get(this.key("offer"));
    if (!envelope) {
      const payments =
        this.config.profile === "algorand-atomic-multi-item-v1"
          ? this.config.limits.job_hashes.length
          : 1;
      const quote = quoteAlgorandManifestFees(
        await this.readParams(),
        payments,
        this.clock(),
      );
      envelope = createAlgorandManifestOffer(
        this.config.profile,
        url,
        this.config.requirement,
        this.config.limits,
        quote,
      );
      this.store.once(this.key("offer"), envelope);
    }
    const q = envelope.extensions["402signal-atomic-batch"].feeQuote;
    if (!(q.observedAt <= this.clock() && this.clock() < q.expiresAt))
      return {
        status: 503,
        body: { error: "manifest_offer_expired", new_payment_allowed: false },
      };
    const header = encode64(envelope);
    assert(
      header.length <= ALGORAND_MANIFEST_HEADER_MAX,
      "manifest_header_too_large",
    );
    return {
      status: 402,
      body: envelope,
      headers: { "Payment-Required": header, "Cache-Control": "no-store" },
    };
  }
  async recover(
    input: ManifestRecoveryRequest,
  ): Promise<ManifestOutcome & { recoveryOnly: true }> {
    const missing = () => ({ ...unavailable(), recoveryOnly: true as const });
    try {
      assert(
        input &&
          Object.keys(input).sort().join(",") ===
            "authorizationDigest,groupId,recoveryOnly,requestDigest,url" &&
          input.recoveryOnly === true &&
          input.url === this.config.url,
        "manifest_recovery_scope_refused",
      );
      assert(
        typeof input.groupId === "string" &&
          input.groupId.length === 44 &&
          Buffer.from(input.groupId, "base64").toString("base64") ===
            input.groupId &&
          [input.requestDigest, input.authorizationDigest].every(
            (x) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x),
          ),
        "manifest_recovery_scope_refused",
      );
      const identity = this.store.get(this.key("recovery-scope"));
      if (!identity || canonical(identity) !== canonical(input))
        return missing();
      const saved = this.store.get(this.key("outcome"));
      return saved ? { ...saved, recoveryOnly: true } : missing();
    } catch {
      return missing();
    }
  }
  async request(
    url: string,
    header?: string,
    recoveryOnly = false,
  ): Promise<ManifestOutcome> {
    assert(url === this.config.url, "manifest_url_refused");
    if (recoveryOnly) return unavailable();
    if (!header) return this.challenge(url);
    assert(
      typeof header === "string" &&
        header.length <= ALGORAND_MANIFEST_HEADER_MAX,
      "manifest_header_too_large",
      431,
    );
    const payment = parseJson(
      decode64(header, 12288).toString("utf8"),
      12288,
    ) as PaymentPayload;
    const envelope = this.store.get(this.key("offer"));
    if (!envelope) return unavailable();
    const plan = await checkSignedAlgorandManifest(
      this.config.profile,
      envelope,
      this.config.limits,
      this.config.buyer,
      payment,
    );
    const scope = { id: plan.id, scope: plan.scope };
    const saved = this.store.get(this.key("outcome"));
    if (saved) {
      assert(
        canonical(this.store.get(this.key("payment-scope"))) ===
          canonical(scope),
        "manifest_scope_conflict",
      );
      return saved;
    }
    if (recoveryOnly) return unavailable();
    checkCurrentAlgorandManifestQuote(
      plan.manifest.feeQuote,
      await this.readParams(),
      this.clock(),
    );
    if (!this.store.once(this.key("payment-scope"), scope))
      return unavailable();
    this.store.once(this.key("credential"), payment);
    this.store.once(this.key("recovery-scope"), {
      recoveryOnly: true,
      url,
      groupId: plan.group.groupId,
      requestDigest: plan.scope,
      authorizationDigest: digest(canonical(payment)),
    });
    let outcome: ManifestOutcome;
    try {
      const wire = JSON.parse(canonical(payment)) as PaymentPayload;
      const verified = await this.provider.verify(
        wire,
        this.config.requirement,
      );
      if (verified.isValid !== true)
        outcome = {
          status: 503,
          body: {
            error: "manifest_verification_rejected",
            new_payment_allowed: false,
          },
        };
      else {
        checkCurrentAlgorandManifestQuote(
          plan.manifest.feeQuote,
          await this.readParams(),
          this.clock(),
        );
        assert(
          this.store.once(this.key("send-permit"), scope),
          "manifest_already_submitted",
        );
        const result = await this.provider.settle(
          JSON.parse(canonical(payment)),
          this.config.requirement,
        );
        const acknowledged =
          result.success === true &&
          result.network === this.config.requirement.network &&
          result.transaction === plan.group.transfers[0]!.transaction;
        outcome = acknowledged
          ? {
              status: 200,
              body: {
                batch: {
                  profile: plan.profile,
                  groupId: plan.group.groupId,
                  jobCount: plan.manifest.jobCount,
                  paymentCount: plan.manifest.paymentCount,
                  items: plan.limits.job_hashes.map(
                    (jobHash: string, i: number) => {
                      const paymentIndex =
                        plan.profile === "algorand-atomic-multi-item-v1"
                          ? i + 1
                          : 1;
                      return {
                        index: i + 1,
                        jobHash,
                        paymentIndex,
                        transaction:
                          plan.group.transfers[paymentIndex - 1]!.transaction,
                      };
                    },
                  ),
                },
                billing: {
                  settlement_state: "provider_ack",
                  amount_atomic: plan.group.totalAtomic,
                  sponsor_fee_micro_algo:
                    plan.manifest.feeQuote.sponsorFeeMicroAlgo,
                  facilitator_commercial_fee: "unknown",
                },
                evidence: {
                  chain_confirmation: "not_independently_checked",
                  fulfillment: "not_attested",
                  traffic_class: "self_test",
                },
              },
            }
          : unavailable();
      }
    } catch {
      outcome = unavailable();
    }
    this.store.once(this.key("outcome"), outcome);
    return outcome;
  }
}
/** Transport hook for an operator-enabled endpoint. Exact URL remains external
 * HTTPS; a loopback test server can pass it without changing the commitment. */
export function algorandManifestHttpHandler(
  seller: AlgorandManifestSeller,
  url: string,
) {
  return async (req: any, res: any) => {
    try {
      if (req.method !== "GET") {
        res.writeHead(405, { "Cache-Control": "no-store" });
        res.end();
        return;
      }
      const names = (req.rawHeaders as string[])
        .filter((_: string, i: number) => i % 2 === 0)
        .map((s: string) => s.toLowerCase());
      assert(
        names.filter((s: string) => s === "payment-signature").length <= 1 &&
          names.filter((s: string) => s === "replay-only").length <= 1,
        "duplicate_manifest_header",
      );
      const signature = req.headers["payment-signature"],
        recovery = req.headers["replay-only"];
      assert(
        signature === undefined || typeof signature === "string",
        "manifest_header_refused",
      );
      assert(
        recovery === undefined || recovery === "1",
        "manifest_recovery_header_refused",
      );
      assert(
        !req.headers["transfer-encoding"] &&
          (!req.headers["content-length"] ||
            req.headers["content-length"] === "0"),
        "manifest_get_body_refused",
      );
      const expected = new URL(url);
      assert(
        req.url === expected.pathname + expected.search,
        "manifest_url_refused",
      );
      const recoveryNames = [
        "manifest-group-id",
        "manifest-request-digest",
        "manifest-authorization-digest",
      ];
      assert(
        recoveryNames.every((n) => names.filter((x) => x === n).length <= 1),
        "duplicate_manifest_recovery_header",
      );
      let out: ManifestOutcome;
      if (recovery === "1") {
        assert(
          signature === undefined,
          "executable_recovery_credential_refused",
        );
        out = await seller.recover({
          recoveryOnly: true,
          url,
          groupId: req.headers["manifest-group-id"],
          requestDigest: req.headers["manifest-request-digest"],
          authorizationDigest: req.headers["manifest-authorization-digest"],
        });
      } else {
        assert(
          recoveryNames.every((n) => req.headers[n] === undefined),
          "unexpected_recovery_header",
        );
        out = await seller.request(url, signature);
      }
      res.writeHead(out.status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...out.headers,
      });
      res.end(out.status === 402 ? "" : JSON.stringify(out.body));
    } catch (error: any) {
      res.writeHead(error?.status === 431 ? 431 : 400, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(
        JSON.stringify({
          error: "manifest_request_refused",
          new_payment_allowed: false,
        }),
      );
    }
  };
}
