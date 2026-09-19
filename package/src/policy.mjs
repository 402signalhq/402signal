import { createHash } from "node:crypto";
import { verifyBatchRoute } from "../route-guard/batch.mjs";
import { parse } from "../route-guard/internal-json.mjs";
export const check = (value, message) => {
  if (!value) throw Error(message);
};
export const canonical = (value) => {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value))
    return String(value);
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (
    value &&
    typeof value === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  throw Error("unsupported local policy value");
};
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const digest = (value) => hash(canonical(value));
export const clone = (value) => JSON.parse(canonical(value));
export const frozen = (value) => {
  const copy = clone(value);
  const visit = (v) => {
    if (v && typeof v === "object") {
      Object.values(v).forEach(visit);
      Object.freeze(v);
    }
    return v;
  };
  return visit(copy);
};
export const atomic = (value) => {
  check(
    typeof value === "string" &&
      /^[1-9][0-9]{0,19}$/.test(value) &&
      BigInt(value) < 2n ** 64n,
    "bounded positive atomic amount required",
  );
  return BigInt(value);
};
export function exact(value, keys) {
  check(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(",") === [...keys].sort().join(","),
    "unexpected fields",
  );
}
export function requestSnapshot(request, policy) {
  exact(request, ["url", "method", "body"]);
  check(
    request.url === policy.request.url &&
      request.method === policy.request.method &&
      typeof request.body === "string",
    "caller request scope changed",
  );
  check(
    Buffer.byteLength(request.body, "utf8") <= policy.request.maxBodyBytes &&
      Buffer.from(request.body, "utf8").toString("utf8") === request.body,
    "request body exceeds local bound or is not exact UTF8",
  );
  if (request.method === "GET") check(request.body === "", "GET body refused");
  else {
    check(request.body.length > 0, "JSON POST body required");
    parse(request.body, {
      ordinaryNumbers: true,
      limit: policy.request.maxBodyBytes,
    });
  }
  return frozen({
    ...request,
    bodySha256: hash(request.body),
    requestDigest: digest(request),
  });
}
export function validatePolicy(policy, plan, rail) {
  exact(policy, [
    "version",
    "maxCalls",
    "perCallAtomic",
    "maxCumulativeAtomic",
    "expiresAt",
    "request",
  ]);
  exact(policy.request, ["url", "method", "maxBodyBytes"]);
  check(
    policy.version === 2 &&
      Number.isSafeInteger(policy.maxCalls) &&
      policy.maxCalls >= 1 &&
      policy.maxCalls <= 64,
    "continuation call bound",
  );
  const u = new URL(policy.request.url);
  check(
    u.protocol === "https:" &&
      u.href === policy.request.url &&
      !u.username &&
      !u.password &&
      !u.hash &&
      !u.port &&
      policy.request.url ===
        (rail === "base" ? plan.resource : plan.request.url),
    "continuation endpoint",
  );
  check(
    ["GET", "POST"].includes(policy.request.method) &&
      Number.isSafeInteger(policy.request.maxBodyBytes) &&
      policy.request.maxBodyBytes >= 0 &&
      policy.request.maxBodyBytes <= 4096,
    "request policy refused",
  );
  check(
    policy.request.method !== "GET" || policy.request.maxBodyBytes === 0,
    "GET bytes policy",
  );
  check(
    policy.request.method !== "POST" || policy.request.maxBodyBytes > 0,
    "POST bytes policy",
  );
  const total = atomic(policy.perCallAtomic) * BigInt(policy.maxCalls);
  check(
    total <= atomic(policy.maxCumulativeAtomic) &&
      atomic(policy.maxCumulativeAtomic) <=
        atomic(
          rail === "base" ? plan.depositAtomic : plan.policy.depositAtomic,
        ),
    "continuation capital bound",
  );
  if (rail === "base")
    check(
      policy.maxCalls === plan.maxCalls &&
        policy.perCallAtomic === plan.perCallAtomic,
      "funding plan economics changed",
    );
  if (rail === "solana")
    check(
      policy.expiresAt <=
        (plan.policy.voucherExpiresAt - plan.policy.gracePeriod) * 1000,
      "voucher settlement window",
    );
  check(
    Number.isSafeInteger(policy.expiresAt) && policy.expiresAt > 0,
    "fixed session deadline required",
  );
  return frozen(policy);
}
/** Original signed proof stays private and durable, including receipts larger
 * than one ledger row. Chunking does not discard any request/response bytes. */
export async function readInitialObservation(ledger) {
  const metadata = await ledger.require("continuation:proof");
  check(
    Number.isInteger(metadata.chunks) &&
      metadata.chunks >= 1 &&
      metadata.chunks <= 16 &&
      Number.isInteger(metadata.bytes) &&
      metadata.bytes <= 524288,
    "bounded stored observation",
  );
  const parts = [];
  for (let i = 0; i < metadata.chunks; i++) {
    const part = await ledger.require("continuation:proof:" + i);
    check(part.encoding === "base64", "stored proof encoding");
    const bytes = Buffer.from(part.data, "base64");
    check(
      bytes.toString("base64") === part.data &&
        bytes.length <= 32768 &&
        hash(bytes) === part.sha256,
      "stored proof chunk mismatch",
    );
    parts.push(bytes);
  }
  const bytes = Buffer.concat(parts);
  check(
    bytes.length === metadata.bytes && hash(bytes) === metadata.sha256,
    "stored observation digest mismatch",
  );
  return frozen(
    parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes), {
      ordinaryNumbers: true,
      limit: 524288,
    }),
  );
}
async function retainInitialObservation(ledger, proof) {
  const bytes = Buffer.from(canonical(proof));
  check(
    bytes.length > 0 && bytes.length <= 524288,
    "initial observation storage bound",
  );
  const chunks = Math.ceil(bytes.length / 32768);
  for (let i = 0; i < chunks; i++) {
    const part = bytes.subarray(i * 32768, (i + 1) * 32768),
      entry = {
        encoding: "base64",
        data: part.toString("base64"),
        sha256: hash(part),
      };
    await ledger.once("continuation:proof:" + i, entry);
    check(
      canonical(await ledger.require("continuation:proof:" + i)) ===
        canonical(entry),
      "original proof immutable conflict",
    );
  }
  const metadata = { bytes: bytes.length, chunks, sha256: hash(bytes) };
  await ledger.once("continuation:proof", metadata);
  check(
    canonical(await ledger.require("continuation:proof")) ===
      canonical(metadata),
    "original proof metadata conflict",
  );
}
/** Authenticate once while the initial observation is fresh. Later identical
 * restarts retain it as historical evidence, never as a fresh health claim. */
export async function initializeContinuation(
  controller,
  policy,
  options,
  rail,
  match,
) {
  const p = validatePolicy(policy, controller.plan, rail),
    proof =
      options === undefined
        ? await readInitialObservation(controller.ledger)
        : frozen(options);
  check(!Object.hasOwn(proof, "now"), "caller clock override refused");
  const identity = {
    version: 2,
    rail,
    policy: p,
    planDigest: digest(controller.plan),
    proofDigest: digest(proof),
  };
  const prior = await controller.ledger.get("continuation:v2");
  if (prior) {
    check(
      canonical(prior.identity) === canonical(identity),
      "immutable continuation conflict",
    );
    check(
      digest(await readInitialObservation(controller.ledger)) ===
        identity.proofDigest,
      "stored initial proof mismatch",
    );
    controller.continuation = frozen(prior);
    return;
  }
  check(
    (await controller.ledger.require("progress")).state === "new",
    "new policy cannot adopt existing funding authority",
  );
  const binding = verifyBatchRoute({
    ...proof,
    now: Math.floor(Date.now() / 1000),
  });
  check(
    binding.profile ===
      (rail === "base" ? "base-x402-batch-v1" : "solana-mpp-session-v1") &&
      binding.request.url === p.request.url,
    "initial observed profile/endpoint mismatch",
  );
  check(
    p.expiresAt > Date.now() &&
      p.expiresAt <= binding.observed_at * 1000 + 86400000,
    "maximum one-day buyer session policy",
  );
  match(binding, p);
  await retainInitialObservation(controller.ledger, proof);
  const value = {
    identity,
    binding,
    authorizedAt: Date.now(),
    initialExpiresAt: binding.expires_at * 1000,
  };
  await controller.ledger.once("continuation:v2", value);
  const saved = await controller.ledger.require("continuation:v2");
  check(
    canonical(saved.identity) === canonical(identity),
    "continuation policy race",
  );
  controller.continuation = frozen(saved);
}
export function fundingFresh(controller) {
  check(
    controller.continuation &&
      Date.now() >= controller.continuation.authorizedAt &&
      Date.now() < controller.continuation.initialExpiresAt,
    "initial routing observation expired or not authorized",
  );
}
export function continuationFresh(controller, challengeExpiresAt) {
  const c = controller.continuation;
  check(
    c &&
      Date.now() >= c.authorizedAt &&
      Date.now() < c.identity.policy.expiresAt,
    "buyer session policy expired",
  );
  if (challengeExpiresAt !== undefined)
    check(Date.now() < challengeExpiresAt, "merchant challenge expired");
}
export function callScope(controller, sequence, request) {
  const p = controller.continuation?.identity.policy;
  continuationFresh(controller);
  check(
    Number.isSafeInteger(sequence) && sequence >= 1 && sequence <= p.maxCalls,
    "call sequence exceeds policy",
  );
  const cumulative = (atomic(p.perCallAtomic) * BigInt(sequence)).toString();
  check(
    BigInt(cumulative) <= atomic(p.maxCumulativeAtomic),
    "cumulative budget exceeded",
  );
  return {
    sequence,
    cumulative,
    increment: p.perCallAtomic,
    request: requestSnapshot(request, p),
  };
}
export async function retainAcceptance(
  controller,
  rail,
  scope,
  packet,
  response,
  validateReceipt,
) {
  exact(response, [
    "status",
    "url",
    "requestDigest",
    "authorizationDigest",
    "bodyText",
    "headers",
  ]);
  check(
    Number.isInteger(response.status) &&
      response.status >= 200 &&
      response.status < 300 &&
      response.url === scope.request.url &&
      response.requestDigest === scope.request.requestDigest &&
      response.authorizationDigest === hash(packet.authorization),
    "response request/authority mismatch",
  );
  check(
    typeof response.bodyText === "string" &&
      Buffer.byteLength(response.bodyText) <= 16384 &&
      Buffer.byteLength(canonical(response.headers)) <= 8192,
    "bounded response required",
  );
  const receipt = validateReceipt(response);
  const stage = (rail === "base" ? "delivery:" : "voucher:") + scope.sequence;
  const evidence = {
    requestDigest: scope.request.requestDigest,
    authorizationDigest: hash(packet.authorization),
    responseDigest: digest(response),
    receipt,
    authorizedCumulativeAtomic: scope.cumulative,
    incrementAtomic: scope.increment,
    chainSettled: false,
  };
  await controller.ledger.once(stage + ":continuation-evidence", evidence);
  check(
    canonical(
      await controller.ledger.require(stage + ":continuation-evidence"),
    ) === canonical(evidence),
    "conflicting retained response",
  );
  await controller.ledger.once(
    stage + ":accepted",
    rail === "base"
      ? { cap: scope.cumulative }
      : { cumulative: scope.cumulative },
  );
  const inflight =
    (rail === "base" ? "delivery-inflight:" : "voucher-inflight:") +
    scope.sequence;
  if ((await controller.ledger.require("progress")).state === inflight)
    await controller.ledger.transition(inflight, "active:" + scope.sequence);
  return {
    state: "voucher_accepted",
    chainSettled: false,
    authorizedCumulativeAtomic: scope.cumulative,
    receipt,
  };
}
export async function recoverCall(
  controller,
  rail,
  sequence,
  recover,
  validateReceipt,
) {
  const p = controller.continuation?.identity.policy;
  check(
    p &&
      Number.isSafeInteger(sequence) &&
      sequence >= 1 &&
      sequence <= p.maxCalls,
    "recovery sequence",
  );
  const stage = (rail === "base" ? "delivery:" : "voucher:") + sequence,
    entry = await controller.ledger.require(stage + ":continuation");
  const existing = await controller.ledger.get(stage + ":accepted");
  if (existing) {
    check(
      (rail === "base" ? existing.cap : existing.cumulative) ===
        entry.scope.cumulative,
      "accepted amount mismatch",
    );
    const inflight =
      (rail === "base" ? "delivery-inflight:" : "voucher-inflight:") + sequence;
    if ((await controller.ledger.require("progress")).state === inflight)
      await controller.ledger.transition(inflight, "active:" + sequence);
    return {
      state: "voucher_accepted",
      chainSettled: false,
      authorizedCumulativeAtomic: entry.scope.cumulative,
    };
  }
  check(
    (await controller.ledger.require("progress")).state ===
      (rail === "base" ? "delivery-inflight:" : "voucher-inflight:") + sequence,
    "no unresolved call",
  );
  let claimed = false;
  for (let i = 1; i <= 6; i++)
    if (
      await controller.ledger.once(stage + ":continuation-recovery:" + i, {
        authorizationDigest: hash(entry.packet.authorization),
      })
    ) {
      claimed = true;
      break;
    }
  check(claimed, "read-only recovery attempts exhausted");
  try {
    const result = await recover(
      frozen({
        recoveryOnly: true,
        channelId: entry.packet.channelId,
        sequence,
        requestDigest: entry.scope.request.requestDigest,
        authorizationDigest: hash(entry.packet.authorization),
      }),
    );
    check(
      result?.recoveryOnly === true,
      "explicit read-only recovery result required",
    );
    const { recoveryOnly, ...response } = result;
    return await retainAcceptance(
      controller,
      rail,
      entry.scope,
      entry.packet,
      response,
      (r) => validateReceipt(r, entry),
    );
  } catch {
    return { state: "unknown", newPaymentAllowed: false };
  }
}
