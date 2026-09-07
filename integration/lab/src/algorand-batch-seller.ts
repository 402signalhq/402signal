// Controlled batch-aware merchant contract. One group settles both indexed jobs.
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { FacilitatorClient } from "@x402/core/server";
import {
  decodeTransaction,
  decodeSignedTransaction,
  encodeTransactionRaw,
  encodeSignedTransaction,
} from "@algorandfoundation/algokit-utils/transact";
import {
  algorandBatchRequest,
  prepareAlgorandBatch,
  algorandBatchManifest,
  ALGORAND_BATCH_EXTENSION,
} from "./algorand-batch.js";
import { assert, canonical, decode64, encode64, parseJson } from "./json.js";
import { Ledger, type Outcome } from "./ledger.js";

export class AlgorandBatchSeller {
  constructor(
    private origin: string,
    private requirement: PaymentRequirements,
    private ledger: Ledger,
    private provider: Pick<FacilitatorClient, "verify" | "settle">,
  ) {}
  challenge(url: string): Outcome {
    algorandBatchRequest(url, this.origin);
    const body = {
      x402Version: 2,
      resource: {
        url,
        mimeType: "application/json",
        description:
          "Operator-owned two-item SHA256 batch. Each transfer is 1000 atomic USDC; whole group costs 2000. One submission returns both indexed results. No HTTP fulfillment atomicity guarantee.",
      },
      accepts: [this.requirement],
      extensions: {
        [ALGORAND_BATCH_EXTENSION]: algorandBatchManifest(
          url,
          this.origin,
          this.requirement,
        ),
      },
    };
    return {
      status: 402,
      body,
      headers: { "PAYMENT-REQUIRED": encode64(body) },
    };
  }
  async request(
    url: string,
    header?: string,
    recoveryOnly = false,
  ): Promise<Outcome> {
    const request = algorandBatchRequest(url, this.origin);
    if (!header)
      return recoveryOnly
        ? {
            status: 503,
            body: {
              error: "batch_recovery_unavailable",
              new_payment_allowed: false,
            },
          }
        : this.challenge(url);
    const payment = parseJson(
      decode64(header).toString("utf8"),
    ) as PaymentPayload;
    assert(
      payment.x402Version === 2 &&
        canonical(payment.accepted) === canonical(this.requirement) &&
        payment.resource?.url === url,
      "algorand_batch_payment_scope_refused",
    );
    const manifest = algorandBatchManifest(url, this.origin, this.requirement);
    assert(
      payment.extensions &&
        Object.keys(payment.extensions).join(",") ===
          ALGORAND_BATCH_EXTENSION &&
        canonical(payment.extensions[ALGORAND_BATCH_EXTENSION]) ===
          canonical(manifest),
      "algorand_batch_manifest_refused",
    );
    const p = payment.payload as any;
    assert(
      p &&
        Object.keys(p).sort().join(",") === "paymentGroup,paymentIndex" &&
        p.paymentIndex === 1 &&
        Array.isArray(p.paymentGroup) &&
        p.paymentGroup.length === 3,
      "algorand_batch_payload_refused",
    );
    let buyer = "";
    const raw = p.paymentGroup.map((value: unknown, i: number) => {
      const bytes = decode64(value, 4096);
      if (i === 0) {
        const txn = decodeTransaction(bytes);
        assert(
          Buffer.from(encodeTransactionRaw(txn)).equals(bytes),
          "algorand_batch_encoding_refused",
        );
        return bytes;
      }
      const signed = decodeSignedTransaction(bytes);
      assert(
        signed.sig?.length === 64 &&
          !signed.msig &&
          !signed.lsig &&
          !signed.authAddress &&
          Buffer.from(encodeSignedTransaction(signed)).equals(bytes),
        "algorand_batch_signature_refused",
      );
      if (i === 1) buyer = signed.txn.sender.toString();
      assert(
        signed.txn.sender.toString() === buyer,
        "algorand_batch_signers_refused",
      );
      return encodeTransactionRaw(signed.txn);
    });
    const plan = prepareAlgorandBatch({
      url,
      origin: this.origin,
      requirement: this.requirement,
      buyer,
      raw,
      maxSpendAtomic: "2000",
      manifest,
    });
    const existing = this.ledger.lookup(plan.id, plan.scope);
    if (existing) return existing.outcome;
    if (recoveryOnly)
      return {
        status: 503,
        body: {
          error: "batch_recovery_unavailable",
          new_payment_allowed: false,
        },
      };
    // Frozen canonical wire: caller/provider mutation cannot retarget the second leg.
    const wire = JSON.parse(canonical(payment)) as PaymentPayload;
    const claim = this.ledger.reserve(plan.id, plan.scope);
    if (!claim.run) return claim.outcome!;
    this.ledger.attempting(plan.id);
    const unpaid = (error: string): Outcome => ({
      status: 503,
      body: {
        error,
        billing: {
          settled: false,
          settlement_attempted: false,
          settlement_state: "not_attempted",
        },
        new_payment_allowed: false,
      },
    });
    let outcome: Outcome;
    let settlementAttempted = false;
    try {
      const verified = await this.provider.verify(wire, this.requirement);
      if (verified.isValid !== true) {
        outcome = unpaid("batch_verification_rejected");
      } else {
        settlementAttempted = true;
        const receipt = await this.provider.settle(wire, this.requirement);
        const ack =
          receipt.success === true &&
          receipt.network === this.requirement.network &&
          receipt.transaction === plan.group.transfers[0]!.transaction;
        outcome = ack
          ? {
              status: 200,
              body: {
                batch: {
                  profile: "algorand-atomic-two-sha256-v1",
                  groupId: plan.group.groupId,
                  items: request.items.map((item, i) => ({
                    ...item,
                    transaction: plan.group.transfers[i]!.transaction,
                    amount_atomic: "1000",
                  })),
                },
                billing: {
                  settled: true,
                  settlement_attempted: true,
                  settlement_state: "provider_ack",
                  amount_atomic: "2000",
                  rail: "algorand",
                },
                evidence: {
                  traffic_class: "self_test",
                  operator_owned: true,
                  organic_demand: false,
                  chain_confirmation: "not_independently_checked",
                },
              },
            }
          : {
              status: 503,
              body: {
                error: "batch_settlement_unknown",
                billing: {
                  settled: null,
                  settlement_attempted: true,
                  settlement_state: "unknown",
                },
                new_payment_allowed: false,
              },
            };
      }
    } catch {
      outcome = settlementAttempted
        ? {
            status: 503,
            body: {
              error: "batch_outcome_unknown",
              billing: {
                settled: null,
                settlement_attempted: true,
                settlement_state: "unknown",
              },
              new_payment_allowed: false,
            },
          }
        : unpaid("batch_verification_unavailable");
    }
    this.ledger.finish(plan.id, "attempted", outcome);
    return outcome;
  }
}
