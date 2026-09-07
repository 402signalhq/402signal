import { createHash, randomUUID } from "node:crypto";
import { Challenge, Credential, Receipt } from "mppx";
import { parse } from "../../sdk/route-guard/internal-json.mjs";
import {
  prepareSolanaSession,
  observeSolanaOpen,
  SOLANA_SESSION_PROGRAM,
  SOLANA_USDC,
} from "./owner-session.mjs";
const { verifyVoucherForChannel } = await import(
  new URL("./server/session/voucher.js", import.meta.resolve("@solana/mpp"))
);
const json = (x) =>
  JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));
const sha = (x) => createHash("sha256").update(x).digest("hex");
const check = (x, m) => {
  if (!x) throw Error(m);
};
const fixed = "402signal batch qualification";
const reply = (status, body, headers = {}) => ({
  status,
  bodyText: JSON.stringify(body),
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...headers,
  },
});
function strictCredential(header) {
  check(
    typeof header === "string" &&
      header.length <= 32768 &&
      /^Payment [A-Za-z0-9_-]+$/.test(header),
    "bounded native credential required",
  );
  const wire = parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(header.slice(8), "base64url"),
    ),
    { ordinaryNumbers: true, limit: 32768 },
  );
  check(
    Object.keys(wire).sort().join(",") === "challenge,payload",
    "credential fields",
  );
  parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(wire.challenge.request, "base64url"),
    ),
    { ordinaryNumbers: true, limit: 16384 },
  );
  return Credential.deserialize(header);
}
/** Single configured synthetic merchant campaign; no key, signer, settlement
 * provider, server broadcast, pull delegation, top-up or close handler. */
export async function createNativeSessionMerchant({
  ledger,
  rpc,
  url,
  policy,
  perCallAtomic,
  maxCalls = 2,
  migrateSchema = false,
}) {
  const u = new URL(url);
  check(
    u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.hash &&
      u.pathname === "/solana/session/sha256" &&
      !u.search,
    "fixed merchant URL",
  );
  check(
    Number.isInteger(maxCalls) &&
      maxCalls >= 1 &&
      maxCalls <= 2 &&
      /^[1-9][0-9]{0,15}$/.test(perCallAtomic) &&
      BigInt(perCallAtomic) * BigInt(maxCalls) <= BigInt(policy.depositAtomic),
    "bounded delivery economics",
  );
  if (migrateSchema === true) await ledger.initialize();
  else {
    check(
      typeof ledger.assertReady === "function",
      "runtime schema readiness required",
    );
    await ledger.assertReady();
  }
  await ledger.bind({ url, policy, perCallAtomic, maxCalls });
  let plan = await ledger.get("merchant:plan");
  const ensureChallenge = async () => {
    plan = await ledger.get("merchant:plan");
    if (!plan) {
      const recent = await rpc("getLatestBlockhash", [
        { commitment: "confirmed" },
      ]);
      const challenge = Challenge.from({
        id: randomUUID(),
        realm: u.host,
        method: "solana",
        intent: "session",
        request: {
          cap: policy.maxSessionAtomic,
          currency: SOLANA_USDC,
          decimals: 6,
          network: "mainnet",
          operator: policy.operator,
          recipient: policy.recipient,
          programId: SOLANA_SESSION_PROGRAM,
          recentBlockhash: recent.value.blockhash,
          recentSlot: String(recent.context.slot),
          minVoucherDelta: perCallAtomic,
        },
        expires: new Date(Date.now() + 60000).toISOString(),
      });
      const prepared = await prepareSolanaSession({
        wwwAuthenticate: Challenge.serialize(challenge),
        request: {
          url,
          method: "GET",
          digest: sha(json({ url, method: "GET", body: "" })),
        },
        policy,
      });
      await ledger.once("merchant:plan", prepared);
      plan = await ledger.require("merchant:plan");
    }
    return plan;
  };
  await ledger.once("progress", { state: "new" });
  const respond = async (stage, authDigest, reference, extra = {}) => {
    const receipt = Receipt.from({
      method: "solana",
      challengeId: plan.challenge.id,
      reference,
      status: "success",
      timestamp: new Date().toISOString(),
    });
    const response = reply(
      200,
      { reference, ...extra },
      { "Payment-Receipt": Receipt.serialize(receipt) },
    );
    check(
      await ledger.once(stage + ":response", { authDigest, response }),
      "response already recorded",
    );
    return response;
  };
  return {
    path: u.pathname,
    get plan() {
      return plan;
    },
    async request(actualUrl, authorization, recoveryOnly = false) {
      try {
        check(actualUrl === url, "request changed");
        if (!plan) plan = await ledger.get("merchant:plan");
        if (!plan && !recoveryOnly && !authorization) await ensureChallenge();
        if (!plan)
          return reply(503, {
            error: "recovery_unavailable",
            newPaymentAllowed: false,
          });
        if (!authorization)
          return recoveryOnly
            ? reply(503, {
                error: "recovery_unavailable",
                newPaymentAllowed: false,
              })
            : Date.now() < plan.expiresAt
              ? {
                  status: 402,
                  bodyText: "",
                  headers: {
                    "WWW-Authenticate": plan.rawChallenge,
                    "Cache-Control": "no-store",
                  },
                }
              : reply(410, { error: "campaign_challenge_expired" });
        const credential = strictCredential(authorization);
        check(
          Challenge.serialize(credential.challenge) === plan.rawChallenge,
          "challenge changed",
        );
        const payload = credential.payload,
          authDigest = sha(authorization);
        let stage;
        if (payload.action === "open") stage = "merchant:open";
        else if (payload.action === "voucher") {
          const v = payload.voucher;
          check(
            v &&
              Object.keys(v).sort().join(",") === "data,signature" &&
              Object.keys(v.data).sort().join(",") ===
                "channelId,cumulativeAmount,expiresAt,nonce" &&
              v.data.nonce === 1,
            "canonical voucher required",
          );
          check(
            /^[1-9][0-9]{0,15}$/.test(v.data.cumulativeAmount),
            "voucher amount",
          );
          const amount = BigInt(v.data.cumulativeAmount);
          check(amount % BigInt(perCallAtomic) === 0n, "fixed increment");
          const sequence = Number(amount / BigInt(perCallAtomic));
          check(sequence >= 1 && sequence <= maxCalls, "delivery cap");
          stage = "merchant:voucher:" + sequence;
        } else throw Error("unsupported native action");
        const cached = await ledger.get(stage + ":response");
        if (cached) {
          check(cached.authDigest === authDigest, "different authorization");
          return cached.response;
        }
        if (recoveryOnly)
          return reply(503, {
            error: "recovery_unavailable",
            newPaymentAllowed: false,
          });
        check(
          Date.now() >= plan.observedAt && Date.now() < plan.expiresAt,
          "original observation expired",
        );
        if (payload.action === "open") {
          check(
            Object.keys(payload).sort().join(",") ===
              "action,authorizedSigner,channelId,deposit,gracePeriod,mint,mode,payee,payer,recentSlot,salt,signature,transaction" &&
              payload.mode === "push" &&
              payload.payer === plan.policy.payer &&
              payload.authorizedSigner === plan.policy.payer &&
              payload.channelId === plan.open.channelId &&
              payload.deposit === plan.policy.depositAtomic &&
              typeof payload.transaction === "string",
            "full exact owner open required",
          );
          const observed = await observeSolanaOpen(
            rpc,
            plan,
            payload.signature,
          );
          check(observed.state === "chain_confirmed", "opening unconfirmed");
          // The supplied wire must be the independently observed complete transaction.
          const tx = await rpc("getTransaction", [
            payload.signature,
            {
              encoding: "base64",
              commitment: "finalized",
              maxSupportedTransactionVersion: 0,
            },
          ]);
          check(
            tx?.transaction?.[0] === payload.transaction,
            "open wire mismatch",
          );
          await ledger.transition("new", "open-inflight");
          await ledger.once("merchant:open:observation", observed);
          const response = await respond(stage, authDigest, payload.signature, {
            sessionOpened: true,
            chargedAmount: "0",
          });
          await ledger.transition("open-inflight", "active:0");
          return response;
        }
        const sequence = Number(
          BigInt(payload.voucher.data.cumulativeAmount) / BigInt(perCallAtomic),
        );
        const prior =
          sequence === 1
            ? null
            : await ledger.require(
                "merchant:voucher:" + (sequence - 1) + ":voucher",
              );
        const state = {
          authorizedSigner: plan.policy.payer,
          channelId: plan.open.channelId,
          cumulative: BigInt(perCallAtomic) * BigInt(sequence - 1),
          deposit: BigInt(plan.policy.depositAtomic),
          sealed: false,
          committedDeliveries: [],
          pendingDeliveries: [],
          nextDeliverySequence: 0n,
          ...(prior
            ? {
                highestVoucherSignature: prior.signature,
                highestVoucherExpiresAt: BigInt(prior.data.expiresAt),
              }
            : {}),
        };
        check(
          payload.voucher.data.channelId === plan.open.channelId &&
            payload.voucher.data.expiresAt === plan.policy.voucherExpiresAt,
          "voucher scope",
        );
        const verified = await verifyVoucherForChannel({
          state,
          deposit: state.deposit,
          minVoucherDelta: BigInt(perCallAtomic),
          settlementWindow: 900n,
          signed: payload.voucher,
        });
        check(verified.status === "accepted", "voucher refused");
        await ledger.transition(
          "active:" + (sequence - 1),
          "voucher-inflight:" + sequence,
        );
        await ledger.once(stage + ":voucher", payload.voucher);
        const response = await respond(
          stage,
          authDigest,
          plan.open.channelId + ":" + payload.voucher.data.cumulativeAmount,
          {
            chargedAmount: perCallAtomic,
            chargedCumulativeAmount: payload.voucher.data.cumulativeAmount,
            text: fixed,
            sha256: sha(fixed),
            chainSettled: false,
          },
        );
        await ledger.transition(
          "voucher-inflight:" + sequence,
          "active:" + sequence,
        );
        return response;
      } catch {
        return reply(503, {
          error: "native_session_unavailable",
          newPaymentAllowed: false,
        });
      }
    },
  };
}
