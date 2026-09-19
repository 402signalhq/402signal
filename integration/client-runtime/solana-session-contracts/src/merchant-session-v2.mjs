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
/** Explicit version2, owner-funded qualification session. Fresh standard
 * merchant challenges do not renew the original routing observation. Fixed
 * per-call/cumulative/deadline limits; no key, signer, broadcast or top-up.
 * Close only records the request; owner-side settlement remains separate. */
export async function createNativeContinuationMerchant({
  ledger,
  rpc,
  url,
  policy,
  perCallAtomic,
  maxCalls,
  expiresAt,
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
      maxCalls >= 3 &&
      maxCalls <= 64 &&
      /^[1-9][0-9]{0,15}$/.test(perCallAtomic) &&
      BigInt(perCallAtomic) * BigInt(maxCalls) <= BigInt(policy.depositAtomic),
    "bounded delivery economics",
  );
  check(
    Number.isSafeInteger(expiresAt) &&
      expiresAt > 0 &&
      expiresAt <= Date.now() + 86400000 &&
      expiresAt <= (policy.voucherExpiresAt - policy.gracePeriod) * 1000,
    "fixed continuation deadline",
  );
  const cleanupDeadline = (policy.voucherExpiresAt - policy.gracePeriod) * 1000;
  if (migrateSchema === true) await ledger.initialize();
  else {
    check(
      typeof ledger.assertReady === "function",
      "runtime schema readiness required",
    );
    await ledger.assertReady();
  }
  await ledger.bind({
    version: 2,
    url,
    policy,
    perCallAtomic,
    maxCalls,
    expiresAt,
  });
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
  const currentChallenge = async () => {
    check(
      plan && Date.now() < cleanupDeadline,
      "session cleanup window expired",
    );
    if (Date.now() < plan.expiresAt)
      return { rawChallenge: plan.rawChallenge, challenge: plan.challenge };
    const epoch = Math.floor((Date.now() - plan.observedAt) / 60000),
      stage = "merchant:challenge:" + epoch;
    check(epoch >= 0 && epoch <= 1440, "bounded challenge history");
    let current = await ledger.get(stage);
    if (!current) {
      const recent = await rpc("getLatestBlockhash", [
        { commitment: "confirmed" },
      ]);
      const challenge = Challenge.from({
        id: "continue-" + epoch,
        realm: u.host,
        method: "solana",
        intent: "session",
        request: {
          ...plan.challenge.request,
          recentBlockhash: recent.value.blockhash,
          recentSlot: String(recent.context.slot),
        },
        expires: new Date(
          Math.min(plan.observedAt + (epoch + 1) * 60000, cleanupDeadline),
        ).toISOString(),
      });
      await ledger.once(stage, {
        challenge,
        rawChallenge: Challenge.serialize(challenge),
      });
      current = await ledger.require(stage);
    }
    return current;
  };
  const retainedChallenge = async (credential) => {
    if (credential.challenge.id === plan.challenge.id)
      return { rawChallenge: plan.rawChallenge, challenge: plan.challenge };
    const m = /^continue-([0-9]{1,4})$/.exec(credential.challenge.id);
    check(m && Number(m[1]) <= 1440, "unknown continuation challenge");
    return ledger.require("merchant:challenge:" + Number(m[1]));
  };
  // A retained successful response is authoritative after its write ACK is lost.
  // Reconcile only the immediately preceding completed stage, never a new call.
  const repairPrior = async (sequence) => {
    const state = (await ledger.require("progress")).state;
    if (sequence === 1 && state === "open-inflight") {
      const response = await ledger.require("merchant:open:response"),
        observed = await ledger.require("merchant:open:observation");
      check(
        response.response.status === 200 &&
          observed.state === "chain_confirmed",
        "unconfirmed prior opening",
      );
      await ledger.transition(state, "active:0");
    } else if (sequence > 1 && state === "voucher-inflight:" + (sequence - 1)) {
      const prior = await ledger.require(
          "merchant:voucher:" + (sequence - 1) + ":voucher",
        ),
        response = await ledger.require(
          "merchant:voucher:" + (sequence - 1) + ":response",
        );
      const body = JSON.parse(response.response.bodyText),
        amount = (BigInt(sequence - 1) * BigInt(perCallAtomic)).toString();
      check(
        response.response.status === 200 &&
          prior.data.channelId === plan.open.channelId &&
          prior.data.cumulativeAmount === amount &&
          body.chargedCumulativeAmount === amount,
        "conflicting prior delivery",
      );
      await ledger.transition(state, "active:" + (sequence - 1));
    }
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
    async lookupReceipt(scope) {
      try {
        check(
          scope &&
            Object.keys(scope).sort().join(",") ===
              "authorizationDigest,channelId,recoveryOnly,requestDigest,sequence" &&
            scope.recoveryOnly === true,
          "read-only receipt scope",
        );
        const savedPlan = await ledger.require("merchant:plan");
        check(
          scope.channelId === savedPlan.open.channelId &&
            Number.isInteger(scope.sequence) &&
            scope.sequence >= 1 &&
            scope.sequence <= maxCalls &&
            /^[a-f0-9]{64}$/.test(scope.authorizationDigest) &&
            scope.requestDigest ===
              sha(JSON.stringify({ body: "", method: "GET", url })),
          "receipt identifiers",
        );
        const saved = await ledger.require(
          "merchant:voucher:" + scope.sequence + ":response",
        );
        check(
          saved.authDigest === scope.authorizationDigest,
          "receipt authority digest differs",
        );
        const headers = Object.fromEntries(
          Object.entries(saved.response.headers).map(([k, v]) => [
            k.toLowerCase(),
            v,
          ]),
        );
        return {
          recoveryOnly: true,
          status: saved.response.status,
          url,
          requestDigest: scope.requestDigest,
          authorizationDigest: scope.authorizationDigest,
          bodyText: saved.response.bodyText,
          headers,
        };
      } catch {
        return {
          recoveryOnly: true,
          state: "unknown",
          newPaymentAllowed: false,
        };
      }
    },
    async request(actualUrl, authorization, recoveryOnly = false) {
      try {
        check(actualUrl === url, "request changed");
        if (!plan) plan = await ledger.get("merchant:plan");
        if (!plan && !recoveryOnly && !authorization) {
          check(Date.now() < expiresAt, "campaign expired before opening");
          await ensureChallenge();
        }
        if (!plan)
          return reply(503, {
            error: "recovery_unavailable",
            newPaymentAllowed: false,
          });
        if (!authorization) {
          if (recoveryOnly)
            return reply(503, {
              error: "recovery_unavailable",
              newPaymentAllowed: false,
            });
          const current = await currentChallenge();
          return {
            status: 402,
            bodyText: "",
            headers: {
              "WWW-Authenticate": current.rawChallenge,
              "Cache-Control": "no-store",
            },
          };
        }
        const credential = strictCredential(authorization),
          current = await retainedChallenge(credential);
        check(
          Challenge.serialize(credential.challenge) === current.rawChallenge,
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
        } else if (payload.action === "close") stage = "merchant:close";
        else throw Error("unsupported native action");
        const cached = await ledger.get(stage + ":response");
        if (cached) {
          check(cached.authDigest === authDigest, "different authorization");
          const progress = (await ledger.require("progress")).state;
          if (stage === "merchant:open" && progress === "open-inflight")
            await ledger.transition(progress, "active:0");
          else if (
            stage.startsWith("merchant:voucher:") &&
            progress === "voucher-inflight:" + stage.split(":").at(-1)
          )
            await ledger.transition(
              progress,
              "active:" + stage.split(":").at(-1),
            );
          else if (stage === "merchant:close" && progress === "close-inflight")
            await ledger.transition(progress, "close-requested");
          return cached.response;
        }
        if (recoveryOnly)
          return reply(503, {
            error: "recovery_unavailable",
            newPaymentAllowed: false,
          });
        check(Date.now() >= plan.observedAt, "clock rollback");
        if (payload.action !== "open")
          check(
            Date.now() < Date.parse(current.challenge.expires),
            "current merchant challenge expired",
          );
        check(
          Date.now() <
            (payload.action === "close" ? cleanupDeadline : expiresAt),
          "fixed campaign deadline expired",
        );
        if (payload.action === "close") {
          check(
            Object.keys(payload).sort().join(",") ===
              "action,channelId,voucher" &&
              payload.channelId === plan.open.channelId,
            "exact close scope",
          );
          const amount = BigInt(payload.voucher?.data?.cumulativeAmount),
            sequence = Number(amount / BigInt(perCallAtomic));
          check(
            sequence >= 1 &&
              sequence <= maxCalls &&
              amount === BigInt(sequence) * BigInt(perCallAtomic),
            "close cumulative cap",
          );
          const prior = await ledger.require(
            "merchant:voucher:" + sequence + ":voucher",
          );
          check(
            json(payload.voucher) === json(prior),
            "close cannot authorize a new amount",
          );
          await repairPrior(sequence + 1);
          await ledger.transition("active:" + sequence, "close-inflight");
          await ledger.once("merchant:close:request", { payload, authDigest });
          const response = await respond(
            stage,
            authDigest,
            plan.open.channelId,
            { closeRequested: true, chainSettled: false },
          );
          await ledger.transition("close-inflight", "close-requested");
          return response;
        }
        if (payload.action === "open") {
          check(
            current.rawChallenge === plan.rawChallenge,
            "only original opening authority",
          );
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
        await repairPrior(sequence);
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
