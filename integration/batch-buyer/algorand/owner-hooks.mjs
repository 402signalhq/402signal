// Repository-only owner driver. Never imports wallet material in cloud or recovery.
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyBatchRoute } from "../../../sdk/route-guard/batch.mjs";
import { RouteClient } from "../../../sdk/route-guard/client.mjs";
import { FileAttemptStore } from "../../../sdk/route-guard/file-store.mjs";
import { BuyerJournal } from "../../reference-buyer/journal.mjs";
import {
  canonical,
  check,
  challengeOf,
  decode64,
  strictJson,
} from "../../reference-buyer/policy.mjs";
import { checkAlgorandGroup } from "../../lab/dist/src/mainnet-policy.js";
import { createRequire } from "node:module";
const labRequire = createRequire(
  new URL("../../lab/package.json", import.meta.url),
);
const { Address } = await import(
  labRequire.resolve("@algorandfoundation/algokit-utils")
);
const {
  decodeTransaction,
  decodeSignedTransaction,
  encodeTransactionRaw,
  bytesForSigning,
  transactionCodec,
} = await import(
  labRequire.resolve("@algorandfoundation/algokit-utils/transact")
);
const { ed25519Verifier } = await import(
  labRequire.resolve("@algorandfoundation/algokit-utils/crypto")
);

const copy = (x) => JSON.parse(canonical(x));
const encoded = (x) => Buffer.from(canonical(x)).toString("base64");
// The SDK represents an absent optional extension as an own undefined property.
// Normalize that one wire-only omission before checking or persisting the signed
// envelope. All other values must survive strict JSON serialization unchanged.
export function normalizeRouterPaymentPayload(payload) {
  check(
    payload && typeof payload === "object" && !Array.isArray(payload),
    "router_payment_json_refused",
  );
  const source = { ...payload };
  if (source.extensions === undefined) delete source.extensions;
  const raw = JSON.stringify(source, (_key, value) => {
    check(
      value !== undefined &&
        !["function", "symbol", "bigint"].includes(typeof value) &&
        (typeof value !== "number" || Number.isFinite(value)),
      "router_payment_json_refused",
    );
    return value;
  });
  const snapshot = strictJson(raw, 262144);
  check(
    canonical(snapshot) === canonical(source),
    "router_payment_json_refused",
  );
  return snapshot;
}

const bytes = (s) => {
  check(typeof s === "string" && s.length <= 8192, "signed_group_refused");
  const b = Buffer.from(s, "base64");
  check(b.toString("base64") === s, "signed_group_refused");
  return b;
};
function routerTerms(challenge, policy) {
  const matches = challenge.accepts.filter(
    (q) => q.network === policy.router.network,
  );
  check(matches.length === 1, "router_offer_ambiguous");
  const q = matches[0],
    p = policy.router;
  check(
    q.scheme === "exact" &&
      q.asset === p.asset &&
      q.amount === "3000" &&
      q.payTo === p.recipient &&
      q.extra?.feePayer === p.feePayer &&
      Number.isInteger(q.maxTimeoutSeconds) &&
      q.maxTimeoutSeconds > 0 &&
      q.maxTimeoutSeconds <= 60 &&
      (q.currency === undefined || q.currency === q.asset) &&
      challenge.resource?.url === p.url,
    "router_terms_refused",
  );
  check(
    Object.keys(q).every((k) =>
      [
        "scheme",
        "network",
        "asset",
        "amount",
        "payTo",
        "maxTimeoutSeconds",
        "extra",
        "currency",
      ].includes(k),
    ),
    "router_terms_refused",
  );
  check(
    Object.keys(q.extra).every((k) =>
      [
        "name",
        "facilitator",
        "feePayer",
        "displayAmount",
        "tag",
        "decimals",
        "unsignedGroup",
        "suggestedParams",
        "sender",
      ].includes(k),
    ),
    "router_metadata_refused",
  );
  const billing = challenge.billing;
  check(
    billing?.model === "success_only_v1" &&
      billing.amount_atomic === "3000" &&
      billing.asset === "USDC" &&
      billing.typed_misses_settled === false &&
      billing.seller_payment_separate === true,
    "router_billing_refused",
  );
  return q;
}
async function routerGroup(payload, requirement, policy) {
  check(
    payload?.x402Version === 2 &&
      payload.resource?.url === policy.router.url &&
      canonical(payload.accepted) === canonical(requirement) &&
      Object.keys(payload.payload ?? {})
        .sort()
        .join(",") === "paymentGroup,paymentIndex" &&
      payload.payload.paymentIndex === 1 &&
      Array.isArray(payload.payload.paymentGroup) &&
      payload.payload.paymentGroup.length === 2,
    "router_signed_terms_refused",
  );
  const signed = decodeSignedTransaction(
    bytes(payload.payload.paymentGroup[1]),
  );
  check(
    signed.sig?.length === 64 &&
      !signed.msig &&
      !signed.lsig &&
      !signed.authAddress,
    "router_signature_refused",
  );
  const raw = [
    bytes(payload.payload.paymentGroup[0]),
    encodeTransactionRaw(signed.txn),
  ];
  checkAlgorandGroup(raw, [1], requirement, policy.buyer);
  check(
    await ed25519Verifier(
      signed.sig,
      bytesForSigning.transaction(signed.txn),
      Address.fromString(policy.buyer).publicKey,
    ),
    "router_signature_refused",
  );
  return raw;
}
/** Owner signer is invoked only after the campaign's immutable5000 reservation
 * and this adapter's durable one-shot sign claim. All HTTP is plain, bounded,
 * exact-target and no-redirect. Recovery never loads a signer or submits a group.
 */
export function createAlgorandOwnerHooks(
  policy,
  {
    directory,
    id,
    owner,
    fetch: rawFetch = globalThis.fetch,
    pause = (ms) => new Promise((r) => setTimeout(r, ms)),
    clock = () => Math.floor(Date.now() / 1000),
  },
) {
  const journal = new BuyerJournal(directory, policy);
  const store = new FileAttemptStore(join(directory, "route-client"));
  const client = new RouteClient({
    store,
    routerUrl: policy.router.url,
    recoveryProfile: "http-route-v1",
    fetch: rawFetch,
    timeoutMs: 75000,
  });
  const rpcBase = policy.rpcUrl.replace(/\/$/, "");
  async function get(url, headers = {}) {
    check(
      url === policy.url ||
        url === rpcBase + "/v2/transactions/params" ||
        (url.startsWith(rpcBase + "/v2/transactions/pending/") &&
          /^[A-Z2-7]{52}$/.test(
            url.slice((rpcBase + "/v2/transactions/pending/").length),
          )),
      "owner_http_scope_refused",
    );
    const response = await rawFetch(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    check(
      Number(response.headers.get("content-length") || 0) <= 262144,
      "response_too_large",
    );
    const reader = response.body?.getReader(),
      chunks = [];
    let size = 0;
    if (reader)
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          check(size <= 262144, "response_too_large");
          chunks.push(part.value);
        }
      } catch (e) {
        await reader.cancel().catch(() => {});
        throw e;
      }
    const bodyText = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
    return {
      status: response.status,
      bodyText,
      body: bodyText ? strictJson(bodyText, 262144) : null,
      headers: response.headers,
    };
  }
  async function params() {
    const r = await get(rpcBase + "/v2/transactions/params"),
      p = r.body;
    check(
      r.status === 200 &&
        p?.["genesis-hash"] === policy.router.network.slice(9) &&
        p["genesis-id"] === "mainnet-v1.0" &&
        p["min-fee"] === 1000 &&
        p.fee === 0 &&
        Number.isSafeInteger(p["last-round"]) &&
        p["last-round"] > 0,
      "algod_params_refused",
    );
    return p;
  }
  async function confirmRouterOnce() {
    try {
      const saved = journal.get(id, "router_signed");
      check(saved, "router_intent_required");
      const raw = await routerGroup(saved.payload, saved.requirement, policy);
      await params();
      let round;
      const ids = [];
      for (const bytes of raw) {
        const expected = decodeTransaction(bytes),
          txid = expected.txId();
        ids.push(txid);
        const r = await get(rpcBase + "/v2/transactions/pending/" + txid),
          n = r.body?.["confirmed-round"];
        check(
          r.status === 200 &&
            Number.isSafeInteger(n) &&
            n > 0 &&
            !r.body?.["pool-error"],
          "router_unconfirmed",
        );
        const actual = transactionCodec.decode(r.body?.txn?.txn, "json");
        check(
          actual.txId() === txid &&
            Buffer.from(encodeTransactionRaw(actual)).equals(
              Buffer.from(bytes),
            ),
          "router_confirmation_mismatch",
        );
        check(
          round === undefined || round === n,
          "router_group_round_mismatch",
        );
        round = n;
      }
      return {
        state: "confirmed",
        network: policy.router.network,
        asset: policy.router.asset,
        buyer: policy.buyer,
        recipient: policy.router.recipient,
        feePayer: policy.router.feePayer,
        amountAtomic: "3000",
        buyerNativeFeeAtomic: "0",
        sponsorFeeMicroAlgo: decodeTransaction(raw[0]).fee.toString(),
        transactions: ids,
        confirmedRound: round,
      };
    } catch {
      return { state: "unknown" };
    }
  }
  const hooks = {
    async routeOnce(requestJson, routerPolicy) {
      check(
        owner &&
          typeof owner.routerSigner === "function" &&
          canonical(routerPolicy) === canonical(policy.router),
        "owner_router_signer_required",
      );
      check(
        canonical(journal.job(id).request) ===
          canonical(strictJson(requestJson)),
        "router_request_changed",
      );
      await client.prepare(id, requestJson);
      const initial = await client.challenge(id),
        challenge = challengeOf(initial, { router: true });
      const requirement = routerTerms(challenge, policy);
      await params();
      journal.put(id, "router_sign_claim", { requestJson, challenge });
      // Existing lab sdkSigner strips informational hints and independently guards
      // the two-transaction group before its buyer-side wallet callback.
      const payload = normalizeRouterPaymentPayload(
        await owner.routerSigner("algorand", {
          ...copy(challenge),
          accepts: [copy(requirement)],
        }),
      );
      await routerGroup(payload, requirement, policy);
      journal.put(id, "router_signed", { payload, requirement });
      await client.setPaymentHeader(id, { value: encoded(payload) });
      const result = await client.submit(id);
      check(
        result.response &&
          result.recoveryOnly === false &&
          result.classification?.settlementReport === "settled",
        "router_outcome_requires_readonly_review",
      );
      const response = result.response,
        body = strictJson(response.bodyText, 262144);
      check(
        response.status === 200 &&
          body.billing?.settled === true &&
          body.billing.settlement_attempted === true &&
          body.billing.settlement_state === "settled" &&
          body.billing.model === "success_only_v1" &&
          body.billing.amount_atomic === "3000" &&
          body.billing.asset === "USDC" &&
          body.billing.rail === "algorand",
        "router_settlement_unknown",
      );
      check(response.paymentResponse, "router_receipt_required");
      const receipt = decode64(response.paymentResponse),
        savedRaw = await routerGroup(payload, requirement, policy);
      check(
        receipt.success === true &&
          receipt.network === policy.router.network &&
          (receipt.amount === undefined || receipt.amount === "3000") &&
          savedRaw
            .map((x) => decodeTransaction(x).txId())
            .includes(receipt.transaction),
        "router_receipt_refused",
      );
      return { routeResponseJson: response.bodyText };
    },
    async confirmRouter() {
      for (let n = 0; n < 8; n++) {
        const value = await confirmRouterOnce();
        if (value.state === "confirmed" || n === 7) return value;
        await pause(1000);
      }
    },
    async readSellerChallenge(url) {
      check(url === policy.url, "seller_url_refused");
      const r = await get(url);
      check(
        !r.headers.get("X-PAYMENT-REQUIRED"),
        "legacy_seller_challenge_refused",
      );
      const challenge = {
        status: r.status,
        bodyText: r.bodyText,
        paymentRequired: r.headers.get("PAYMENT-REQUIRED"),
        wwwAuthenticate: r.headers.get("WWW-Authenticate"),
      };
      journal.put(id, "merchant_challenge", challenge);
      return challenge;
    },
    async suggestedParams() {
      const p = await params();
      return {
        genesisHash: p["genesis-hash"],
        genesisId: p["genesis-id"],
        minimumFee: "1000",
        feePerByte: "0",
        firstValid: String(p["last-round"]),
        lastValid: String(p["last-round"] + 60),
      };
    },
    async signGroup(raw, indexes) {
      check(
        owner && typeof owner.signGroup === "function",
        "owner_group_signer_required",
      );
      return owner.signGroup(raw, indexes);
    },
    async sendSeller(url, payment) {
      check(url === policy.url, "seller_url_refused");
      verifyBatchRoute({
        routeResponseJson: journal.get(id, "router_result").routeResponseJson,
        routeRequestJson: canonical(journal.job(id).request),
        trustedLogVkey: policy.trustedLogVkey,
        challenge: journal.get(id, "merchant_challenge"),
        now: clock(),
      });
      return get(url, { "PAYMENT-SIGNATURE": encoded(payment) });
    },
    async recoverSeller(url, payment, headers) {
      check(
        url === policy.url &&
          canonical(headers) === canonical({ "Replay-Only": "1" }),
        "recovery_contract_required",
      );
      return get(url, {
        "PAYMENT-SIGNATURE": encoded(payment),
        "Replay-Only": "1",
      });
    },
    async readAlgod(url, method) {
      check(
        method === "GET" && url.startsWith(rpcBase + "/v2/"),
        "readonly_algod_required",
      );
      return get(url);
    },
    async recoverRouter() {
      const response = await client.recover(id);
      return {
        status: response.response?.status ?? null,
        settlementReport:
          response.classification?.settlementReport ?? "unknown",
        newPaymentAllowed: false,
        confirmation: await confirmRouterOnce(),
      };
    },
    close() {
      journal.close();
    },
  };
  return hooks;
}
export async function createRunHooks(policy, context) {
  check(process.env.ALGORAND_BATCH_OWNER_FACTORY, "owner_factory_required");
  const module = await import(
    pathToFileURL(resolve(process.env.ALGORAND_BATCH_OWNER_FACTORY)).href
  );
  const owner = await module.createAlgorandOwner(copy(policy));
  return createAlgorandOwnerHooks(policy, { ...context, owner });
}
export async function createReadOnlyRecoveryHooks(policy, context) {
  return createAlgorandOwnerHooks(policy, context);
}
