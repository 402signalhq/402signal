import {
  signVoucher,
  computeChannelId,
} from "@x402/evm/batch-settlement/client";
import { voucherTypes, BATCH_SETTLEMENT_DOMAIN } from "@x402/evm";
import { getAddress } from "viem";
import { BaseBatchController } from "../internal/base-batch-lifecycle.js";
import {
  BASE_BATCH,
  BASE_USDC,
  observeBaseBatch,
} from "../internal/base-batch-observer.js";
import { validateBaseBatchProfile } from "../route-guard/batch-profiles/base.mjs";
import { parse } from "../route-guard/internal-json.mjs";
import {
  check,
  canonical,
  clone,
  frozen,
  hash,
  initializeContinuation,
  fundingFresh,
  continuationFresh,
  callScope,
  retainAcceptance,
  recoverCall,
} from "./policy.mjs";
export { observeBaseBatch };
function challenge(raw, controller, scope) {
  check(
    typeof raw === "string" && Buffer.byteLength(raw) <= 16384,
    "bounded current x402 challenge required",
  );
  const e = clone(parse(raw, { ordinaryNumbers: true, limit: 16384 })),
    b = controller.continuation.binding;
  const terms = validateBaseBatchProfile(
    e,
    { url: scope.request.url, method: "GET", body_sha256: hash("") },
    b.buyer_limits,
  );
  check(
    canonical(terms) === canonical(b.terms),
    "Base batch economics changed",
  );
  return { envelope: e, raw };
}
function receipt(response, entry) {
  const header = response.headers["payment-response"];
  check(
    typeof header === "string" && header.length <= 8192,
    "standard x402 acknowledgment required",
  );
  const bytes = Buffer.from(header, "base64");
  check(bytes.toString("base64") === header, "canonical payment response");
  const r = clone(
    parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes), {
      ordinaryNumbers: true,
      limit: 8192,
    }),
  );
  check(
    r.success === true &&
      r.network === "eip155:8453" &&
      r.transaction === "" &&
      r.extra?.channelState?.channelId === entry.packet.channelId &&
      r.extra.channelState.chargedCumulativeAmount === entry.scope.cumulative &&
      r.extra.chargedAmount === entry.scope.increment,
    "x402 off-chain voucher accounting refused",
  );
  if (r.payer !== undefined)
    check(
      getAddress(r.payer) === getAddress(entry.payer),
      "receipt payer changed",
    );
  return {
    method: "x402-batch",
    success: true,
    network: r.network,
    transaction: r.transaction,
    chargedCumulativeAtomic: r.extra.channelState.chargedCumulativeAmount,
    chargedAmountAtomic: r.extra.chargedAmount,
  };
}
export class BaseSessionClient extends BaseBatchController {
  constructor(ledger, journal, rpc, plan, { policy, initialObservation }) {
    super(ledger, journal, rpc, plan);
    this.sessionPolicy = frozen(policy);
    this.initialObservation =
      initialObservation === undefined ? undefined : frozen(initialObservation);
  }
  async initialize() {
    await super.initialize();
    await initializeContinuation(
      this,
      this.sessionPolicy,
      this.initialObservation,
      "base",
      (b, p) => {
        const t = b.terms,
          c = this.plan.config;
        check(
          t.recipient === c.receiver &&
            t.receiver_authorizer === c.receiverAuthorizer &&
            t.asset === c.token &&
            t.withdraw_delay_seconds === c.withdrawDelay &&
            t.call_amount_atomic === p.perCallAtomic &&
            t.max_timeout_seconds === this.requirements.maxTimeoutSeconds,
          "funding plan not bound to original observation",
        );
        check(
          BigInt(this.plan.depositAtomic) <=
            BigInt(b.buyer_limits.max_capital_atomic) &&
            BigInt(p.maxCumulativeAtomic) <=
              BigInt(b.buyer_limits.max_cumulative_amount_atomic),
          "initial buyer capital limits",
        );
      },
    );
  }
  fresh() {
    super.fresh();
    fundingFresh(this);
  }
  async deliver(owner, sequence, request, challengeBody, send) {
    const scope = callScope(this, sequence, request),
      p = this.plan;
    check(
      getAddress(owner.address) === getAddress(p.config.payer) &&
        typeof owner.signTypedData === "function" &&
        typeof send === "function",
      "buyer signer/transport required",
    );
    check(
      (await this.ledger.require("deposit:confirmed")).state ===
        "chain_confirmed",
      "finalized original deposit required",
    );
    const current = challenge(challengeBody, this, scope),
      id = computeChannelId(p.config, "eip155:8453");
    const before =
      sequence === 1
        ? "0"
        : (
            await this.ledger.require(
              "delivery:" + (sequence - 1) + ":accepted",
            )
          ).cap;
    check(
      BigInt(before) + BigInt(scope.increment) === BigInt(scope.cumulative),
      "local cumulative accounting mismatch",
    );
    const stage = "delivery:" + sequence;
    await this.ledger.transition(
      "active:" + (sequence - 1),
      "delivery-inflight:" + sequence,
    );
    check(
      await this.ledger.once(stage + ":request-intent", {
        scope,
        challenge: current,
      }),
      "request intent already retained",
    );
    try {
      let voucher;
      if (sequence === 1)
        voucher = (await this.ledger.require("deposit:payload")).payload
          .voucher;
      else {
        let calls = 0;
        const signer = {
          address: owner.address,
          signTypedData: async (data) => {
            continuationFresh(this);
            check(
              ++calls === 1 &&
                data.primaryType === "Voucher" &&
                canonical(data.domain) ===
                  canonical({
                    ...BATCH_SETTLEMENT_DOMAIN,
                    chainId: 8453,
                    verifyingContract: BASE_BATCH,
                  }) &&
                canonical(data.types) === canonical(voucherTypes) &&
                data.message.channelId === id &&
                data.message.maxClaimableAmount === BigInt(scope.cumulative),
              "unexpected cumulative voucher authority",
            );
            check(
              await this.ledger.once(stage + ":typed:1", data),
              "typed authority already claimed",
            );
            return owner.signTypedData(data);
          },
        };
        voucher = await signVoucher(
          signer,
          id,
          scope.cumulative,
          "eip155:8453",
        );
        check(calls === 1, "one voucher signer invocation required");
      }
      check(
        voucher.maxClaimableAmount === scope.cumulative ||
          BigInt(voucher.maxClaimableAmount) === BigInt(scope.cumulative),
        "initial voucher amount changed",
      );
      const payload = {
        x402Version: 2,
        accepted: current.envelope.accepts[0],
        resource: current.envelope.resource,
        payload: { type: "voucher", channelConfig: p.config, voucher },
      };
      const authorization = Buffer.from(JSON.stringify(payload)).toString(
        "base64",
      );
      check(
        await this.ledger.once(stage, {
          requestDigest: scope.request.requestDigest,
          payload,
          cap: scope.cumulative,
        }),
        "delivery already retained",
      );
      const packet = frozen({
        request: scope.request,
        authorization,
        payload,
        sequence,
        channelId: id,
        cumulativeAmount: scope.cumulative,
        rail: "base",
      });
      const entry = { scope, packet, payer: p.config.payer };
      check(
        await this.ledger.once(stage + ":continuation", entry),
        "call already retained",
      );
      continuationFresh(this);
      check(
        await this.ledger.once(stage + ":send-intent", {
          authorizationDigest: hash(authorization),
          requestDigest: scope.request.requestDigest,
        }),
        "transport already claimed",
      );
      const response = await send(packet);
      return await retainAcceptance(
        this,
        "base",
        scope,
        packet,
        response,
        (r) => receipt(r, entry),
      );
    } catch {
      return { state: "unknown", newPaymentAllowed: false };
    }
  }
  async recoverDelivery(sequence, recover) {
    return recoverCall(this, "base", sequence, recover, receipt);
  }
}
