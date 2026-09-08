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
export const BASE_BATCH_CONTINUATION_OPT_IN = "reviewed-owner-batch-continuation-v2";
export interface BaseContinuationMerchantConfig {
  version: 2;
  createdAt: number;
  campaignId: string;
  url: string;
  channelConfig: BatchConfig;
  perCallAtomic: string;
  maxCalls: number;
  expiresAt: number;
}
/** Version 2 continuation on one explicitly pinned owner qualification channel. No wallet, funding,
 * close scheduler, claim, payout or refund route. SDK handles actual voucher
 * verification/accounting; PostgreSQL preserves immutable once-only HTTP stages.
 */
export class BaseBatchContinuationMerchant {
  readonly path = BASE_BATCH_PATH;
  readonly config: BaseContinuationMerchantConfig;
  readonly ledger: BaseBatchLedger;
  readonly storage: PostgresChannelStorage;
  readonly server: x402ResourceServer;
  requirements?: PaymentRequirements;
  constructor(
    pool: Pool,
    config: BaseContinuationMerchantConfig,
    facilitator: FacilitatorClient,
  ) {
    this.config = JSON.parse(canonical(config));
    const c = this.config,
      u = new URL(c.url),
      ch = c.channelConfig;
    assert(
      Object.keys(c).sort().join(",") ===
        "campaignId,channelConfig,createdAt,expiresAt,maxCalls,perCallAtomic,url,version" &&
        c.version === 2 &&
        Number.isSafeInteger(c.maxCalls) &&
        c.maxCalls >= 3 &&
        c.maxCalls <= 64 &&
        c.perCallAtomic === "1000" &&
        Number.isSafeInteger(c.createdAt) &&
        c.createdAt >= 0 &&
        Number.isSafeInteger(c.expiresAt) &&
        c.expiresAt > c.createdAt &&
        c.expiresAt - c.createdAt <= 86400000 &&
        /^[a-zA-Z0-9_-]{8,60}$/.test(c.campaignId),
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
    Object.freeze(c.channelConfig);
    Object.freeze(c);
    this.ledger = new BaseBatchLedger(pool, "merchant-v2-" + c.campaignId);
    this.storage = new PostgresChannelStorage(pool, "merchant-v2:" + c.campaignId);
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
        extra: { assetTransferMethod: "eip3009" },
      })
    )[0];
    assert(
      r?.amount === "1000" &&
        r.extra?.assetTransferMethod === "eip3009" &&
        getAddress(r.asset) === getAddress(BASE_USDC) &&
        getAddress(String(r.extra?.receiverAuthorizer)) ===
          getAddress(this.config.channelConfig.receiverAuthorizer) &&
        r.extra?.withdrawDelay === 900,
      "base_batch_provider_terms_refused",
    );
    this.requirements = r;
  }
  /** Authority-free retained lookup: no provider, signature, channel writes or CAS. */
  async readReceipt(scope: {
    recoveryOnly: true;
    channelId: string;
    sequence: number;
    requestDigest: string;
    authorizationDigest: string;
  }): Promise<Outcome | undefined> {
    assert(scope && Object.keys(scope).sort().join(",") ===
      "authorizationDigest,channelId,recoveryOnly,requestDigest,sequence" &&
      scope.recoveryOnly === true && Number.isSafeInteger(scope.sequence) &&
      scope.sequence >= 1 && scope.sequence <= this.config.maxCalls &&
      scope.channelId === computeChannelId(this.config.channelConfig, "eip155:8453") &&
      /^[0-9a-f]{64}$/.test(scope.authorizationDigest) &&
      scope.requestDigest === digest(canonical({ body: "", method: "GET", url: this.config.url })),
      "base_batch_recovery_scope_refused");
    const stage = "delivery:" + scope.sequence;
    const intent = await this.ledger.get(stage + ":intent");
    if (!intent) return undefined;
    assert(intent.authorizationDigest === scope.authorizationDigest &&
      intent.requestDigest === scope.requestDigest, "base_batch_recovery_scope_refused");
    return this.ledger.get(stage + ":result");
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
        Date.now() >= this.config.createdAt &&
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
        typeof v.maxClaimableAmount === "string" &&
        /^[1-9][0-9]{0,4}$/.test(v.maxClaimableAmount) &&
        BigInt(v.maxClaimableAmount) % 1000n === 0n &&
        BigInt(v.maxClaimableAmount) <= BigInt(this.config.maxCalls) * 1000n &&
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
    const requestDigest = digest(canonical({ body: "", method: "GET", url }));
    const authorizationDigest = digest(header);
    if (saved) {
      const intent = await this.ledger.require(stage + ":intent");
      assert(intent.requestDigest === requestDigest &&
        intent.authorizationDigest === authorizationDigest,
        "base_batch_recovery_scope_refused");
      return saved;
    }
    if (recoveryOnly)
      return {
        status: 503,
        body: {
          error: "batch_recovery_unavailable",
          new_payment_allowed: false,
        },
      };
    assert(
      Date.now() >= this.config.createdAt &&
        Date.now() < this.config.expiresAt,
      "base_batch_campaign_expired",
      503,
    );
    // A completed predecessor may have lost only its final progress CAS ack.
    // A new, signed sequential request can repair that state; lookup never writes.
    const progress = await this.ledger.get("progress");
    if (sequence > 1 && progress?.state === "inflight:" + (sequence - 1)) {
      const previous = await this.ledger.get("delivery:" + (sequence - 1) + ":result");
      const previousIntent = await this.ledger.get("delivery:" + (sequence - 1) + ":intent");
      assert(previous?.status === 200 && previousIntent &&
        previousIntent.requestDigest === requestDigest &&
        previous.body?.billing?.chargedCumulativeAmount === String((sequence - 1) * 1000),
        "base_batch_predecessor_unknown");
      await this.ledger.transition("inflight:" + (sequence - 1), "active:" + (sequence - 1));
    }
    await this.ledger.transition(
      "active:" + (sequence - 1),
      "inflight:" + sequence,
    );
    await this.ledger.once(stage + ":intent", {
      payment,
      requestDigest,
      authorizationDigest,
    });
    let result: Outcome & { bodyText?: string };
    try {
      const verification = await this.server.verifyPayment(
        payment,
        this.requirements,
      );
      assert(verification.isValid === true, "base_batch_verification_refused");
      const ack = await this.server.settlePayment(payment, this.requirements);
      const ackText = JSON.stringify(ack);
      const retainedAck = parseJson(ackText, 16384);
      const channel = await this.storage.get(v.channelId);
      assert(
        retainedAck.success === true &&
          retainedAck.network === "eip155:8453" &&
          retainedAck.transaction === "" &&
          (retainedAck.payer === undefined ||
            getAddress(retainedAck.payer) === getAddress(this.config.channelConfig.payer)) &&
          retainedAck.extra?.chargedAmount === "1000" &&
          retainedAck.extra?.channelState?.channelId === v.channelId &&
          retainedAck.extra?.channelState?.chargedCumulativeAmount === v.maxClaimableAmount &&
          channel?.chargedCumulativeAmount === v.maxClaimableAmount,
        "base_batch_accounting_unknown",
      );
      result = {
        status: 200,
        headers: { "PAYMENT-RESPONSE": Buffer.from(ackText).toString("base64") },
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
    // Retain wire body text as well as the parsed body: JSONB may reorder keys.
    result.bodyText = canonical(result.body);
    await this.ledger.once(stage + ":result", result);
    if (result.status === 200)
      await this.ledger.transition(
        "inflight:" + sequence,
        "active:" + sequence,
      );
    return result;
  }
}
