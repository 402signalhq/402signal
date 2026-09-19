import { Challenge, Receipt, BodyDigest } from "mppx";
import {
  ActiveSession,
  serializeSessionCredential,
  voucherMessageBytes,
} from "@solana/mpp/client";
import { getBase58Encoder } from "@solana/kit";
import {
  OwnerSessionController,
  prepareSolanaSession,
  observeSolanaOpen,
  observeSolanaClose,
  quoteSolanaSessionRent,
  verifySolanaSessionDeployment,
} from "../internal/native-v1.mjs";
import { parse } from "../route-guard/internal-json.mjs";
import {
  check,
  canonical,
  clone,
  frozen,
  digest,
  hash,
  atomic,
  initializeContinuation,
  fundingFresh,
  continuationFresh,
  callScope,
  requestSnapshot,
  exact,
  retainAcceptance,
  recoverCall,
} from "./policy.mjs";
export {
  prepareSolanaSession,
  observeSolanaOpen,
  observeSolanaClose,
  quoteSolanaSessionRent,
  verifySolanaSessionDeployment,
};
function parseChallenge(raw, plan, request) {
  check(
    typeof raw === "string" &&
      raw.length <= 16384 &&
      raw.startsWith("Payment ") &&
      !raw.includes("\\"),
    "bounded native challenge required",
  );
  const attrs = {};
  for (const part of raw.slice(8).split(", ")) {
    const m = /^([A-Za-z]+)="([^"\\]*)"$/.exec(part);
    check(m && !Object.hasOwn(attrs, m[1]), "duplicate or ambiguous challenge");
    attrs[m[1]] = m[2];
  }
  check(
    Object.keys(attrs).every((k) =>
      [
        "id",
        "realm",
        "method",
        "intent",
        "request",
        "expires",
        "description",
        "digest",
        "opaque",
      ].includes(k),
    ),
    "unreviewed native challenge attribute",
  );
  check(
    attrs.id &&
      attrs.id.length <= 256 &&
      attrs.realm === new URL(request.url).host &&
      attrs.method === "solana" &&
      attrs.intent === "session" &&
      attrs.expires,
    "native merchant identity",
  );
  for (const key of ["request", "opaque"])
    if (attrs[key] !== undefined) {
      const b = Buffer.from(attrs[key], "base64url");
      check(
        b.toString("base64url") === attrs[key],
        "challenge base64 canonical",
      );
      parse(new TextDecoder("utf-8", { fatal: true }).decode(b), {
        ordinaryNumbers: true,
        limit: 16384,
      });
    }
  const c = Challenge.deserialize(raw),
    current = clone(c.request),
    original = clone(plan.challenge.request);
  for (const key of ["recentBlockhash", "recentSlot"]) {
    delete current[key];
    delete original[key];
  }
  check(
    canonical(current) === canonical(original),
    "native session economics changed",
  );
  check(
    getBase58Encoder().encode(c.request.recentBlockhash).length === 32,
    "fresh challenge blockhash",
  );
  atomic(c.request.recentSlot);
  check(
    !c.digest || BodyDigest.verify(c.digest, request.body),
    "merchant body digest differs from caller bytes",
  );
  const expiresAt = Date.parse(c.expires);
  check(
    Number.isFinite(expiresAt) &&
      expiresAt > Date.now() &&
      expiresAt <= Date.now() + 300000,
    "current bounded merchant challenge required",
  );
  return { challenge: c, raw, expiresAt };
}
function receipt(response, entry) {
  const value = response.headers["payment-receipt"];
  check(
    typeof value === "string" && value.length <= 8192,
    "standard MPP receipt required",
  );
  const r = Receipt.deserialize(value);
  // Pinned mppx0.5.5 omits challengeId. The native SDK binds its standard
  // voucher acknowledgment through reference=channelId:cumulativeAmount.
  check(
    r.method === "solana" &&
      r.status === "success" &&
      r.reference === entry.packet.channelId + ":" + entry.scope.cumulative,
    "MPP receipt does not acknowledge this channel/cumulative amount",
  );
  return { method: r.method, status: r.status, reference: r.reference };
}
/** Explicit local continuation policy. Fresh merchant challenges do not renew
 * the original routing observation, create deposits or prove fulfillment. */
export class SolanaSessionClient extends OwnerSessionController {
  constructor(ledger, plan, { policy, initialObservation }) {
    super(ledger, plan);
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
      "solana",
      (b, p) => {
        const t = b.terms,
          q = this.plan.policy,
          r = this.plan.challenge.request;
        check(
          b.challenge.wwwAuthenticate === this.plan.rawChallenge &&
            t.recipient === q.recipient &&
            t.operator === q.operator &&
            t.asset === this.plan.open.mint &&
            t.session_cap_atomic === q.maxSessionAtomic &&
            t.recent_slot === r.recentSlot &&
            t.recent_blockhash === r.recentBlockhash,
          "funding plan not bound to original observation",
        );
        check(
          BigInt(p.perCallAtomic) >= BigInt(t.min_voucher_delta_atomic ?? "1"),
          "agreed price below merchant voucher minimum",
        );
      },
    );
  }
  fresh() {
    super.fresh();
    fundingFresh(this);
  }
  async voucher() {
    throw Error(
      "use deliver with an explicit caller request and current merchant challenge",
    );
  }
  async recoverVoucher() {
    throw Error("use recoverDelivery with read-only receipt lookup");
  }
  async deliver(owner, sequence, request, wwwAuthenticate, send) {
    const scope = callScope(this, sequence, request),
      p = this.plan;
    check(
      owner.address === p.policy.payer &&
        typeof owner.signMessages === "function" &&
        typeof send === "function",
      "buyer signer/transport required",
    );
    check(
      (await this.ledger.require("open:confirmed")).state === "chain_confirmed",
      "finalized original funding required",
    );
    const challenge = parseChallenge(wwwAuthenticate, p, scope.request);
    continuationFresh(this, challenge.expiresAt);
    const before =
      sequence === 1
        ? "0"
        : (await this.ledger.require("voucher:" + (sequence - 1) + ":accepted"))
            .cumulative;
    check(
      BigInt(before) + BigInt(scope.increment) === BigInt(scope.cumulative),
      "local cumulative accounting mismatch",
    );
    const stage = "voucher:" + sequence;
    await this.ledger.transition(
      "active:" + (sequence - 1),
      "voucher-inflight:" + sequence,
    );
    check(
      await this.ledger.once(stage + ":request-intent", { scope, challenge }),
      "request intent already retained",
    );
    try {
      const expected = {
        channelId: p.open.channelId,
        cumulativeAmount: scope.cumulative,
        expiresAt: p.policy.voucherExpiresAt,
      };
      let calls = 0;
      const signer = {
        address: owner.address,
        signMessages: async (messages, ...args) => {
          continuationFresh(this, challenge.expiresAt);
          check(
            ++calls === 1 &&
              messages.length === 1 &&
              Buffer.from(messages[0].content).equals(
                Buffer.from(voucherMessageBytes(expected)),
              ),
            "unexpected voucher signing bytes",
          );
          check(
            await this.ledger.once(stage + ":sign-intent", expected),
            "voucher authority already claimed",
          );
          return owner.signMessages(messages, ...args);
        },
      };
      const session = new ActiveSession({
        channelId: p.open.channelId,
        cumulative: BigInt(before),
        expiresAt: p.policy.voucherExpiresAt,
        signer,
      });
      const voucher = await session.prepareIncrement(BigInt(scope.increment));
      check(calls === 1, "one voucher signer invocation required");
      const payload = { action: "voucher", voucher },
        authorization = serializeSessionCredential({
          challenge: challenge.challenge,
          payload,
        });
      const credential = { payload, authorization };
      check(
        await this.ledger.once(stage + ":credential", credential),
        "credential already retained",
      );
      const packet = frozen({
        request: scope.request,
        authorization,
        payload,
        sequence,
        channelId: p.open.channelId,
        cumulativeAmount: scope.cumulative,
        rail: "solana",
      });
      const entry = { scope, challenge, packet };
      check(
        await this.ledger.once(stage + ":continuation", entry),
        "call already retained",
      );
      continuationFresh(this, challenge.expiresAt);
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
        "solana",
        scope,
        packet,
        response,
        (r) => receipt(r, entry),
      );
    } catch {
      return { state: "unknown", newPaymentAllowed: false };
    }
  }

  /** End the existing channel using a current ordinary merchant challenge.
   * No buyer signature, new voucher amount, deposit or automatic resend. */
  async close(sequence, request, wwwAuthenticate, send) {
    const p = this.continuation?.identity.policy;
    check(
      p &&
        Number.isInteger(sequence) &&
        sequence >= 1 &&
        sequence <= p.maxCalls &&
        typeof send === "function",
      "close scope",
    );
    const scoped = requestSnapshot(request, p),
      current = parseChallenge(wwwAuthenticate, this.plan, scoped);
    const prior = await this.ledger.require(
      "voucher:" + sequence + ":credential",
    );
    const accepted = await this.ledger.require(
      "voucher:" + sequence + ":accepted",
    );
    check(
      accepted.cumulative === prior.payload.voucher.data.cumulativeAmount,
      "close amount differs from accepted call",
    );
    const payload = {
      action: "close",
      channelId: this.plan.open.channelId,
      voucher: prior.payload.voucher,
    };
    const authorization = serializeSessionCredential({
      challenge: current.challenge,
      payload,
    });
    await this.ledger.transition("active:" + sequence, "close-inflight");
    check(
      await this.ledger.once("close:credential", { payload, authorization }),
      "close already retained",
    );
    check(
      await this.ledger.once("close:continuation", {
        request: scoped,
        challenge: current,
        sequence,
      }),
      "close scope already retained",
    );
    try {
      check(Date.now() < current.expiresAt, "merchant close challenge expired");
      check(
        await this.ledger.once("close:send-intent", {
          authorizationDigest: hash(authorization),
          requestDigest: scoped.requestDigest,
        }),
        "close transport already claimed",
      );
      const response = await send(
        frozen({
          request: scoped,
          authorization,
          payload,
          sequence,
          channelId: this.plan.open.channelId,
          cumulativeAmount: accepted.cumulative,
          rail: "solana",
        }),
      );
      exact(response, [
        "status",
        "url",
        "requestDigest",
        "authorizationDigest",
        "bodyText",
        "headers",
      ]);
      check(
        response.status >= 200 &&
          response.status < 300 &&
          response.url === scoped.url &&
          response.requestDigest === scoped.requestDigest &&
          response.authorizationDigest === hash(authorization),
        "close response scope mismatch",
      );
      check(
        typeof response.bodyText === "string" &&
          Buffer.byteLength(response.bodyText) <= 16384 &&
          Buffer.byteLength(canonical(response.headers)) <= 8192,
        "bounded close response",
      );
      const header = response.headers["payment-receipt"];
      check(
        typeof header === "string" && header.length <= 8192,
        "MPP close receipt required",
      );
      const receipt = Receipt.deserialize(header);
      check(
        receipt.method === "solana" && receipt.status === "success",
        "MPP close acknowledgment refused",
      );
      const signature =
        receipt.reference !== this.plan.open.channelId &&
        getBase58Encoder().encode(receipt.reference).length === 64
          ? receipt.reference
          : null;
      check(
        signature || receipt.reference === this.plan.open.channelId,
        "unexpected close reference",
      );
      await this.ledger.once("close:receipt", {
        responseDigest: digest(response),
        receipt: clone(receipt),
        chainSettled: false,
      });
      if (signature)
        await this.ledger.once("close:ack", {
          transactionSignature: signature,
        });
      return {
        state: signature ? "provider_ack" : "close_requested",
        chainSettled: false,
        reference: receipt.reference,
      };
    } catch {
      return { state: "unknown", newPaymentAllowed: false };
    }
  }
  async recoverDelivery(sequence, recover) {
    return recoverCall(this, "solana", sequence, recover, receipt);
  }
}
