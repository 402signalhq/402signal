import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/server";
import { computeChannelId } from "@x402/evm/batch-settlement/client";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { Pool } from "pg";
import { getAddress, verifyTypedData } from "viem";
import { voucherTypes, BATCH_SETTLEMENT_DOMAIN } from "@x402/evm";
import { BaseBatchLedger } from "./base-batch-ledger.js";
import { PostgresChannelStorage } from "./batch-postgres-storage.js";
import {
  assert,
  canonical,
  encode64,
  decode64,
  parseJson,
  digest,
} from "./json.js";
import type { BatchConfig } from "./base-batch-observer.js";
import { BASE_USDC, BASE_BATCH } from "./base-batch-observer.js";
import type { Outcome } from "./ledger.js";
export const BASE_BATCH_PATH = "/base/batch/sha256";
export interface BaseMerchantConfig {
  version: 1;
  campaignId: string;
  url: string;
  channelConfig: BatchConfig;
  perCallAtomic: string;
  maxCalls: number;
  expiresAt: number;
}
/** One explicitly pinned operator-owned qualification channel. No wallet, funding,
 * close scheduler, claim, payout or refund route. SDK handles actual voucher
 * verification/accounting; PostgreSQL preserves immutable once-only HTTP stages.
 */
export class BaseBatchMerchant {
  readonly path = BASE_BATCH_PATH;
  readonly config: BaseMerchantConfig;
  readonly ledger: BaseBatchLedger;
  readonly storage: PostgresChannelStorage;
  readonly server: x402ResourceServer;
  requirements?: PaymentRequirements;
  constructor(
    pool: Pool,
    config: BaseMerchantConfig,
    facilitator: FacilitatorClient,
  ) {
    this.config = JSON.parse(canonical(config));
    const c = this.config,
      u = new URL(c.url),
      ch = c.channelConfig;
    assert(
      c.version === 1 &&
        c.maxCalls === 2 &&
        c.perCallAtomic === "1000" &&
        Number.isSafeInteger(c.expiresAt),
      "base_batch_campaign_refused",
    );
    assert(
      u.protocol === "https:" &&
        u.href === c.url &&
        u.pathname === BASE_BATCH_PATH &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        !u.port,
      "base_batch_resource_refused",
    );
    assert(
      Object.keys(ch).sort().join(",") ===
        "payer,payerAuthorizer,receiver,receiverAuthorizer,salt,token,withdrawDelay",
      "base_batch_channel_refused",
    );
    for (const value of [
      ch.payer,
      ch.payerAuthorizer,
      ch.receiver,
      ch.receiverAuthorizer,
      ch.token,
    ])
      getAddress(value);
    assert(
      getAddress(ch.token) === getAddress(BASE_USDC) &&
        getAddress(ch.payer) === getAddress(ch.payerAuthorizer) &&
        getAddress(ch.payer) !== getAddress(ch.receiver) &&
        ch.withdrawDelay === 900 &&
        /^0x[0-9a-fA-F]{64}$/.test(ch.salt),
      "base_batch_channel_refused",
    );
    this.ledger = new BaseBatchLedger(pool, "merchant-" + c.campaignId);
    this.storage = new PostgresChannelStorage(pool, "merchant:" + c.campaignId);
    this.server = new x402ResourceServer(facilitator);
    this.server.register(
      "eip155:8453",
      new BatchSettlementEvmScheme(ch.receiver, {
        storage: this.storage,
        withdrawDelay: 900,
      }),
    );
  }
  async initialize({ migrateSchema = false } = {}) {
    if (migrateSchema === true) {
      await this.ledger.initialize();
      await this.storage.initialize();
    } else {
      await this.ledger.assertReady();
      await this.storage.assertReady();
    }
    await this.ledger.bind(this.config);
    await this.ledger.once("progress", { state: "active:0" });
    await this.server.initialize();
    const r = (
      await this.server.buildPaymentRequirements({
        scheme: "batch-settlement",
        network: "eip155:8453",
        payTo: this.config.channelConfig.receiver,
        price: "$0.001",
        maxTimeoutSeconds: 300,
      })
    )[0];
    assert(
      r?.amount === "1000" &&
        getAddress(r.asset) === getAddress(BASE_USDC) &&
        getAddress(String(r.extra?.receiverAuthorizer)) ===
          getAddress(this.config.channelConfig.receiverAuthorizer) &&
        r.extra?.withdrawDelay === 900,
      "base_batch_provider_terms_refused",
    );
    this.requirements = r;
  }
  async request(
    url: string,
    header?: string,
    recoveryOnly = false,
  ): Promise<Outcome> {
    assert(
      url === this.config.url && this.requirements,
      "base_batch_resource_refused",
    );
    if (!header) {
      if (recoveryOnly)
        return {
          status: 503,
          body: {
            error: "batch_recovery_unavailable",
            new_payment_allowed: false,
          },
        };
      assert(
        Date.now() < this.config.expiresAt,
        "base_batch_campaign_expired",
        503,
      );
      const body = {
        x402Version: 2,
        resource: {
          url,
          mimeType: "application/json",
          description:
            "Operator-owned SHA256 test. Each voucher authorizes 1000 atomic USDC; channel claim and payout are separate operator actions.",
        },
        accepts: [this.requirements],
      };
      return {
        status: 402,
        body,
        headers: { "PAYMENT-REQUIRED": encode64(body) },
      };
    }
    const payment = parseJson(
        decode64(header, 16384).toString("utf8"),
      ) as PaymentPayload,
      p = payment.payload as any;
    assert(
      payment.x402Version === 2 &&
        payment.resource?.url === url &&
        canonical(payment.accepted) === canonical(this.requirements) &&
        (!payment.extensions || Object.keys(payment.extensions).length === 0),
      "base_batch_payment_refused",
    );
    assert(
      p &&
        Object.keys(p).sort().join(",") === "channelConfig,type,voucher" &&
        p.type === "voucher" &&
        canonical(p.channelConfig) === canonical(this.config.channelConfig),
      "base_batch_voucher_required",
    );
    const v = p.voucher;
    assert(
      v &&
        Object.keys(v).sort().join(",") ===
          "channelId,maxClaimableAmount,signature" &&
        v.channelId ===
          computeChannelId(this.config.channelConfig, "eip155:8453") &&
        ["1000", "2000"].includes(v.maxClaimableAmount) &&
        /^0x[0-9a-fA-F]{130}$/.test(v.signature),
      "base_batch_voucher_refused",
    );
    // The pilot is pinned to an owner EOA. Reject forged vouchers before they
    // can consume a durable delivery stage or trigger facilitator verification.
    assert(
      await verifyTypedData({
        address: this.config.channelConfig.payerAuthorizer,
        domain: {
          ...BATCH_SETTLEMENT_DOMAIN,
          chainId: 8453,
          verifyingContract: BASE_BATCH,
        },
        types: voucherTypes,
        primaryType: "Voucher",
        message: {
          channelId: v.channelId,
          maxClaimableAmount: BigInt(v.maxClaimableAmount),
        },
        signature: v.signature,
      }).catch(() => false),
      "base_batch_signature_refused",
    );
    const sequence = Number(BigInt(v.maxClaimableAmount) / 1000n),
      stage = "delivery:" + sequence;
    const saved = await this.ledger.get(stage + ":result");
    if (saved) return saved;
    if (recoveryOnly)
      return {
        status: 503,
        body: {
          error: "batch_recovery_unavailable",
          new_payment_allowed: false,
        },
      };
    assert(
      Date.now() < this.config.expiresAt,
      "base_batch_campaign_expired",
      503,
    );
    await this.ledger.transition(
      "active:" + (sequence - 1),
      "inflight:" + sequence,
    );
    await this.ledger.once(stage + ":intent", {
      payment,
      requestDigest: digest(url),
    });
    let result: Outcome;
    try {
      const verification = await this.server.verifyPayment(
        payment,
        this.requirements,
      );
      assert(verification.isValid === true, "base_batch_verification_refused");
      const ack = await this.server.settlePayment(payment, this.requirements);
      const channel = await this.storage.get(v.channelId);
      assert(
        ack.success === true &&
          ack.network === "eip155:8453" &&
          channel?.chargedCumulativeAmount === v.maxClaimableAmount,
        "base_batch_accounting_unknown",
      );
      result = {
        status: 200,
        body: {
          result: { sha256: digest("402signal batch qualification") },
          billing: {
            settled: false,
            settlement_state: "voucher_accepted",
            chargedAmount: "1000",
            chargedCumulativeAmount: v.maxClaimableAmount,
          },
          evidence: {
            traffic_class: "self_test",
            operator_owned: true,
            organic_demand: false,
            chain_confirmation: "not_claimed_or_paid_out",
          },
          channelId: v.channelId,
        },
      };
    } catch {
      result = {
        status: 503,
        body: {
          error: "base_batch_outcome_unknown",
          new_payment_allowed: false,
          billing: { settled: null, settlement_state: "unknown" },
        },
      };
    }
    await this.ledger.once(stage + ":result", result);
    if (result.status === 200)
      await this.ledger.transition(
        "inflight:" + sequence,
        "active:" + sequence,
      );
    return result;
  }
}
