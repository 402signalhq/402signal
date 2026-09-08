/** Explicit native MPP charge. Never install automatic fetch/payment behavior. */
import { createHash } from "node:crypto";
import { Address } from "@algorandfoundation/algokit-utils";
import {
  Transaction,
  TransactionType,
  groupTransactions,
  encodeTransactionRaw,
  decodeTransaction,
  encodeSignedTransaction,
  decodeSignedTransaction,
  bytesForSigning,
  transactionCodec,
} from "@algorandfoundation/algokit-utils/transact";
import { ed25519Verifier } from "@algorandfoundation/algokit-utils/crypto";
import { algorand } from "@goplausible/algorand-mpp-sdk/client";
import { Challenge, Credential, Receipt } from "mppx";
import { selectNativeCharge } from "../../sdk/route-guard/batch-profiles/native-charge.mjs";
import {
  validateAlgorandChargeProfile,
  ALGORAND_CHARGE_PROFILE,
} from "../../sdk/route-guard/batch-profiles/algorand-charge.mjs";
import { parse } from "../../sdk/route-guard/internal-json.mjs";
import { verifyBatchRoute } from "../../sdk/route-guard/batch.mjs";
const check = (x, code = "unsupported_algorand_charge") => {
  if (!x) throw Error(code);
};
const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const canonical = (x) =>
  Array.isArray(x)
    ? "[" + x.map(canonical).join(",") + "]"
    : object(x)
      ? "{" +
        Object.keys(x)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + canonical(x[k]))
          .join(",") +
        "}"
      : JSON.stringify(x);
const snapshot = (x) => JSON.parse(canonical(x));
const sha = (x) => createHash("sha256").update(x).digest("hex");
const same = (a, b) => canonical(a) === canonical(b);
const b64 = (b) => Buffer.from(b).toString("base64");
const decode = (s, max = 4096) => {
  check(
    typeof s === "string" &&
      s.length <= Math.ceil(max / 3) * 4 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        s,
      ),
  );
  const b = Buffer.from(s, "base64");
  check(b.length <= max && b.toString("base64") === s);
  return b;
};
const stageKey = (id, stage) =>
  sha(canonical(["native-algorand-charge-v1", id, stage]));
const unknown = () => ({ state: "unknown", newPaymentAllowed: false });
function expectedTransactions(request, buyer) {
  const m = request.methodDetails,
    p = m.suggestedParams,
    sponsored = m.feePayer === true;
  const shared = {
    firstValid: BigInt(p.firstValid),
    lastValid: BigInt(p.lastValid),
    genesisId: p.genesisId,
    genesisHash: decode(p.genesisHash, 32),
  };
  const sponsor = {
    ...shared,
    type: TransactionType.Payment,
    sender: Address.fromString(m.feePayerKey ?? buyer),
    payment: {
      receiver: Address.fromString(m.feePayerKey ?? buyer),
      amount: 0n,
    },
  };
  const payment = {
    ...shared,
    type: TransactionType.AssetTransfer,
    sender: Address.fromString(buyer),
    lease: decode(m.lease, 32),
    note: Buffer.from(
      "mppx:" +
        m.challengeReference +
        (request.externalId ? ":" + request.externalId : ""),
    ),
    assetTransfer: {
      assetId: BigInt(m.asaId),
      receiver: Address.fromString(request.recipient),
      amount: BigInt(request.amount),
    },
  };
  const initial = groupTransactions([
    ...(sponsored ? [new Transaction({ ...sponsor, fee: 0n })] : []),
    new Transaction({ ...payment, fee: 0n }),
  ]);
  const required = (size) => {
    const n = BigInt(p.fee) * BigInt(size);
    return n > BigInt(p.minFee) ? n : BigInt(p.minFee);
  };
  const sdkFee = initial.reduce(
    (total, t) => total + required(encodeTransactionRaw(t).length),
    0n,
  );
  const final = groupTransactions([
    ...(sponsored ? [new Transaction({ ...sponsor, fee: sdkFee })] : []),
    new Transaction({ ...payment, fee: sponsored ? 0n : sdkFee }),
  ]);
  const fullRequired = final.reduce(
    (total, t) =>
      total +
      required(
        encodeSignedTransaction({ txn: t, sig: new Uint8Array(64).fill(1) })
          .length,
      ),
    0n,
  );
  // SDK0.9.4 quotes unsigned size. Refuse underfunded congestion before signing;
  // positive per-byte quotes are supported when the minimum covers actual wire.
  check(sdkFee >= fullRequired, "sdk_fee_quote_underfunds_signed_wire");
  return {
    raw: final.map(encodeTransactionRaw),
    fee: String(sdkFee),
    paymentIndex: sponsored ? 1 : 0,
    transactionIds: final.map((t) => t.txId()),
    groupId: b64(final[0].group),
  };
}
export function prepareNativeAlgorandCharge({
  request,
  challenge,
  limits,
  buyer,
  now = Math.floor(Date.now() / 1000),
}) {
  check(
    object(request) &&
      Object.keys(request).sort().join(",") === "body,method,url" &&
      request.method === "GET" &&
      request.body instanceof Uint8Array &&
      request.body.length === 0,
  );
  check(
    typeof request.url === "string" &&
      request.url.length <= 4096 &&
      /^[\x21-\x7e]+$/.test(request.url) &&
      !/[\\#]/.test(request.url),
  );
  const u = new URL(request.url);
  check(
    u.protocol === "https:" &&
      u.hostname &&
      !u.username &&
      !u.password &&
      !u.hash &&
      !u.port,
  );
  check(Number.isSafeInteger(now) && now > 0);
  check(Address.fromString(buyer).publicKey.some((x) => x !== 0));
  check(
    buyer !== limits.recipient && buyer !== limits.fee_payer,
    "payer_role_conflict",
  );
  const context = { url: request.url, method: "GET", body_sha256: sha("") };
  check(
    object(challenge) &&
      Object.keys(challenge).sort().join(",") ===
        "bodyText,paymentRequired,status,wwwAuthenticate" &&
      challenge.status === 402 &&
      typeof challenge.bodyText === "string" &&
      Buffer.byteLength(challenge.bodyText) <= 16384,
  );
  const selected = selectNativeCharge(challenge, context, "algorand", limits.realm,
      offer => validateAlgorandChargeProfile(offer, context, limits));
  const offer = selected.request, expiresAt = selected.expiry,
    terms = validateAlgorandChargeProfile(offer, context, limits);
  check(now < expiresAt && expiresAt - now <= 300, "expired_algorand_charge");
  const decoded = Challenge.deserialize(selected.raw);
  check(
    same(decoded.request, offer) &&
      decoded.id === selected.params.id &&
      decoded.realm === limits.realm &&
      decoded.method === "algorand" &&
      decoded.intent === "charge",
  );
  const tx = expectedTransactions(offer, buyer);
  check(
    tx.fee === terms.network_fee_micro_algo &&
      BigInt(tx.fee) <= BigInt(limits.max_network_fee_micro_algo),
    "native_fee_cap_exceeded",
  );
  const payload = {
    paymentGroup: tx.raw.map((b, i) =>
      b64(
        i === tx.paymentIndex
          ? encodeSignedTransaction({
              txn: decodeTransaction(b),
              sig: new Uint8Array(64).fill(1),
            })
          : b,
      ),
    ),
    paymentIndex: tx.paymentIndex,
    type: "transaction",
  };
  check(
    Credential.serialize({ challenge: decoded, source: buyer, payload })
      .length <= 16384,
    "native_credential_too_large",
  );
  const inspection = {
    profile: ALGORAND_CHARGE_PROFILE,
    request: context,
    challengeSha256: sha(canonical(challenge)),
    selectedChallengeSha256: sha(selected.raw),
    selectedChallengeId: selected.params.id,
    limits: snapshot(limits),
    buyer,
    terms,
    expiresAt,
    preparedAt: now,
    transactionIds: tx.transactionIds,
    groupId: tx.groupId,
    networkFeeMicroAlgo: tx.fee,
    buyerFeeMicroAlgo: limits.fee_payer === null ? tx.fee : "0",
    sponsorFeeMicroAlgo: limits.fee_payer === null ? "0" : tx.fee,
  };
  const id = sha(canonical(inspection)),
    authorityId = sha(canonical([terms.network, buyer, terms.lease]));
  return snapshot({
    id,
    authorityId,
    inspection,
    request: { url: request.url, method: "GET", bodyBase64: "" },
    challenge,
    decoded,
    raw: tx.raw.map(b64),
    paymentIndex: tx.paymentIndex,
  });
}
function rebuild(p) {
  const q = prepareNativeAlgorandCharge({
    request: { url: p.request.url, method: "GET", body: new Uint8Array() },
    challenge: p.challenge,
    limits: p.inspection.limits,
    buyer: p.inspection.buyer,
    now: p.inspection.preparedAt,
  });
  check(same(p, q), "changed_algorand_plan");
  return q;
}
function fresh(p, now) {
  check(
    Number.isSafeInteger(now) &&
      now >= p.inspection.preparedAt &&
      now < p.inspection.expiresAt,
    "expired_algorand_charge",
  );
}
export function checkNativeAlgorandCurrentParams(
  plan,
  params,
  now = Math.floor(Date.now() / 1000),
) {
  const p = rebuild(plan);
  fresh(p, now);
  const q = p.inspection.terms.suggested_params;
  check(
    params?.["genesis-hash"] === q.genesisHash &&
      params?.["genesis-id"] === q.genesisId &&
      params.fee === q.fee &&
      params["min-fee"] === q.minFee &&
      Number.isSafeInteger(params["last-round"]) &&
      params["last-round"] >= q.firstValid &&
      params["last-round"] <= q.lastValid,
    "changed_algorand_fee_or_round",
  );
  return p;
}
async function inspectCredential(p, value) {
  check(
    typeof value === "string" &&
      value.length <= 16384 &&
      value.startsWith("Payment "),
    "credential_refused",
  );
  const c = Credential.deserialize(value);
  check(
    same(c.challenge, p.decoded) &&
      c.source === p.inspection.buyer &&
      object(c.payload) &&
      Object.keys(c.payload).sort().join(",") ===
        "paymentGroup,paymentIndex,type",
  );
  check(
    c.payload.type === "transaction" &&
      c.payload.paymentIndex === p.paymentIndex &&
      Array.isArray(c.payload.paymentGroup) &&
      c.payload.paymentGroup.length === p.raw.length,
  );
  for (let i = 0; i < p.raw.length; i++) {
    const expected = decode(p.raw[i]),
      raw = decode(c.payload.paymentGroup[i]);
    if (i !== p.paymentIndex) {
      check(raw.equals(expected), "sponsor_signature_refused");
      continue;
    }
    const signed = decodeSignedTransaction(raw);
    check(
      signed.sig?.length === 64 &&
        !signed.msig &&
        !signed.lsig &&
        !signed.authAddress &&
        Buffer.from(encodeSignedTransaction(signed)).equals(raw) &&
        Buffer.from(encodeTransactionRaw(signed.txn)).equals(expected),
      "unexpected_signed_effects",
    );
    check(
      await ed25519Verifier(
        signed.sig,
        bytesForSigning.transaction(signed.txn),
        Address.fromString(p.inspection.buyer).publicKey,
      ),
      "signature_refused",
    );
  }
  return c;
}
function ack(p, out) {
  check(
    out?.status === 200 &&
      typeof out.bodyText === "string" &&
      Buffer.byteLength(out.bodyText) <= 32768 &&
      typeof out.paymentReceipt === "string" &&
      out.paymentReceipt.length <= 4096,
    "merchant_ack_unknown",
  );
  check(/^[A-Za-z0-9_-]+$/.test(out.paymentReceipt));
  const receiptBytes = Buffer.from(out.paymentReceipt, "base64url");
  check(receiptBytes.toString("base64url") === out.paymentReceipt);
  const receipt = Receipt.from(
    parse(new TextDecoder("utf-8", { fatal: true }).decode(receiptBytes), {
      ordinaryNumbers: true,
      limit: 4096,
    }),
  );
  check(
    receipt.method === "algorand" &&
      receipt.status === "success" &&
      receipt.reference === p.inspection.transactionIds[0],
    "merchant_receipt_mismatch",
  );
  return snapshot({
    state: "merchant_acknowledged",
    chainConfirmed: false,
    reference: receipt.reference,
    response: out,
  });
}
/** authorize is an idempotent fresh-proof/budget guard, never a payment method.
 * Caller supplies a bounded read-only params transport and one redirect-free
 * merchant send. Unknown outcomes are fenced across processes and operation IDs. */
export async function executeNativeAlgorandCharge(
  journal,
  operationId,
  plan,
  {
    authorize,
    readParams,
    sign,
    send,
    now = () => Math.floor(Date.now() / 1000),
  },
) {
  check(/^[A-Za-z0-9_-]{1,64}$/.test(operationId));
  const p = rebuild(plan),
    key = (s) => stageKey(operationId, s);
  if (!journal.once(key("attempt"), p)) {
    if (!same(journal.get(key("attempt")), p)) return unknown();
    const saved = journal.get(key("outcome"));
    return saved ? ack(p, saved.response) : unknown();
  }
  try {
    check(
      journal.once(stageKey(p.authorityId, "authority"), {
        id: p.id,
        operationId,
      }),
      "authority_already_claimed",
    );
    await authorize(snapshot(p.inspection));
    checkNativeAlgorandCurrentParams(p, await readParams(), now());
    check(
      journal.once(key("sign-permit"), { id: p.id }),
      "sign_already_claimed",
    );
    let calls = 0;
    const method = algorand.charge({
      senderAddress: p.inspection.buyer,
      algodUrl: "https://unused.invalid",
      signer: async (raw, indexes) => {
        fresh(p, now());
        check(
          ++calls === 1 &&
            same(indexes, [p.paymentIndex]) &&
            raw.length === p.raw.length &&
            raw.every((b, i) => Buffer.from(b).equals(decode(p.raw[i]))),
          "unexpected_wallet_request",
        );
        journal.once(key("sign-intent"), { id: p.id, raw: p.raw, indexes });
        const signed = await sign(
          raw.map((b) => new Uint8Array(b)),
          [...indexes],
        );
        fresh(p, now());
        return signed;
      },
    });
    const credential = await method.createCredential({
      challenge: snapshot(p.decoded),
    });
    check(calls === 1);
    await inspectCredential(p, credential);
    journal.once(key("credential"), { id: p.id, headerValue: credential });
    await authorize(snapshot(p.inspection));
    checkNativeAlgorandCurrentParams(p, await readParams(), now());
    check(
      journal.once(key("send-permit"), { id: p.id }),
      "send_already_claimed",
    );
    const headerName = p.decoded.header ?? "Authorization";
    const out = await send({
      url: p.request.url,
      method: "GET",
      headers: { [headerName]: credential },
      body: new Uint8Array(),
    });
    const result = ack(p, out);
    journal.once(key("outcome"), result);
    return result;
  } catch {
    return unknown();
  }
}
/** Native MPP does not promise a Replay-Only cache endpoint. Recover ONLY by
 * reading all retained transactions; never resend an Authorization credential. */
export async function confirmNativeAlgorandCharge(
  journal,
  operationId,
  plan,
  read,
) {
  try {
    const p = rebuild(plan),
      key = (s) => stageKey(operationId, s);
    check(
      same(journal.get(key("attempt")), p) &&
        journal.get(key("send-permit"))?.id === p.id,
    );
    const credential = journal.get(key("credential"));
    check(credential?.id === p.id);
    await inspectCredential(p, credential.headerValue);
    const params = await read({
      method: "GET",
      path: "/v2/transactions/params",
    });
    check(
      params.status === 200 &&
        params.body?.["genesis-hash"] ===
          p.inspection.terms.suggested_params.genesisHash &&
        params.body?.["genesis-id"] === "mainnet-v1.0",
    );
    let round;
    for (let i = 0; i < p.raw.length; i++) {
      const row = await read({
          method: "GET",
          path: "/v2/transactions/pending/" + p.inspection.transactionIds[i],
        }),
        n = row.body?.["confirmed-round"];
      check(
        row.status === 200 &&
          Number.isSafeInteger(n) &&
          n > 0 &&
          !row.body?.["pool-error"],
      );
      const t = transactionCodec.decode(row.body?.txn?.txn, "json");
      check(
        Buffer.from(encodeTransactionRaw(t)).equals(decode(p.raw[i])) &&
          t.txId() === p.inspection.transactionIds[i],
      );
      if (round === undefined) round = n;
      else check(round === n);
    }
    const out = {
      state: "chain_confirmed",
      confirmedRound: round,
      transactions: p.inspection.transactionIds,
      amountAtomic: p.inspection.terms.amount_atomic,
      networkFeeMicroAlgo: p.inspection.networkFeeMicroAlgo,
      buyerFeeMicroAlgo: p.inspection.buyerFeeMicroAlgo,
      sponsorFeeMicroAlgo: p.inspection.sponsorFeeMicroAlgo,
      resourceAcknowledged: !!journal.get(key("outcome")),
      newPaymentAllowed: false,
    };
    journal.once(key("confirmed"), out);
    return out;
  } catch {
    return unknown();
  }
}

/** Concrete v5 composition. The retained router fee and budget checks are
 * read-only/idempotent callbacks; this function never purchases a route. */
export function executeVerifiedNativeAlgorandCharge(
  journal,
  operationId,
  plan,
  { routeEvidence, confirmRouterPayment, reserveBudget, ...options },
) {
  const p = rebuild(plan),
    clock = options.now ?? (() => Math.floor(Date.now() / 1000));
  return executeNativeAlgorandCharge(journal, operationId, p, {
    ...options,
    now: clock,
    authorize: async (inspection) => {
      const proof = verifyBatchRoute({
        ...routeEvidence,
        challenge: p.challenge,
        now: clock(),
      });
      check(
        proof.profile === ALGORAND_CHARGE_PROFILE &&
          same(proof.request, p.inspection.request) &&
          same(proof.buyer_limits, p.inspection.limits) &&
          same(proof.terms, p.inspection.terms),
        "route_proof_mismatch",
      );
      check((await confirmRouterPayment()) === true, "router_payment_unknown");
      await reserveBudget(operationId, snapshot(inspection));
    },
  });
}
