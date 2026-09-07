import { parse } from "../../sdk/route-guard/internal-json.mjs";
import { createHash } from "node:crypto";
export const BASE = "eip155:8453";
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export function check(ok, code) {
  if (!ok) throw new Error(code);
}
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(v)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
      .join(",") +
    "}"
  );
}
export function digest(v) {
  return createHash("sha256")
    .update(typeof v === "string" ? v : canonical(v))
    .digest("hex");
}
export function atomic(s) {
  check(
    typeof s === "string" && /^(0|[1-9][0-9]{0,8})$/.test(s),
    "invalid_atomic_amount",
  );
  return BigInt(s);
}
export function address(s) {
  check(
    typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s),
    "invalid_address",
  );
  return s.toLowerCase();
}
export function https(s) {
  let u;
  try {
    u = new URL(s);
  } catch {}
  check(
    u &&
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.hash &&
      (!u.port || u.port === "443") &&
      u.href === s,
    "invalid_https_url",
  );
  return u;
}
export function decode64(s) {
  check(
    typeof s === "string" &&
      s.length <= 350000 &&
      s.length % 4 === 0 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(s),
    "invalid_payment_header",
  );
  const b = Buffer.from(s, "base64");
  check(b.toString("base64") === s, "invalid_payment_header");
  return parse(new TextDecoder("utf-8", { fatal: true }).decode(b), {
    ordinaryNumbers: true,
    limit: 262144,
  });
}
export function challengeOf(wire, { router = false } = {}) {
  check(
    wire.status === 402 &&
      typeof wire.bodyText === "string" &&
      Buffer.byteLength(wire.bodyText) <= 262144,
    "payment_challenge_required",
  );
  const body = parse(wire.bodyText, { ordinaryNumbers: true, limit: 262144 });
  const header = wire.paymentRequired ? decode64(wire.paymentRequired) : null;
  check(
    !header || canonical(body) === canonical(header),
    "challenge_channels_disagree",
  );
  check(!wire.xPaymentRequired, "legacy_challenge_refused");
  check(
    body &&
      body.x402Version === 2 &&
      Array.isArray(body.accepts) &&
      body.accepts.length >= 1 &&
      body.accepts.length <= (router ? 16 : 1),
    "single_v2_offer_required",
  );
  return body;
}
export function terms(challenge, expected, buyer, now) {
  const q = challenge.accepts[0];
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
        ...(expected.router ? ["currency"] : []),
      ].includes(k),
    ),
    "unknown_payment_authority",
  );
  check(
    q.scheme === "exact" &&
      q.network === BASE &&
      address(q.asset) === USDC.toLowerCase() &&
      address(q.payTo) === address(expected.payTo) &&
      address(q.payTo) !== address(buyer),
    "payment_authority_mismatch",
  );
  check(
    atomic(q.amount) > 0n &&
      atomic(q.amount) <= atomic(expected.maximumAtomic) &&
      (expected.exactAtomic === undefined || q.amount === expected.exactAtomic),
    "payment_amount_refused",
  );
  check(
    Number.isSafeInteger(q.maxTimeoutSeconds) &&
      q.maxTimeoutSeconds > 0 &&
      q.maxTimeoutSeconds <= expected.maxLifetimeSeconds,
    "payment_lifetime_refused",
  );
  if (expected.router) {
    check(
      (q.currency === undefined || q.currency === q.asset) &&
        q.extra &&
        Object.keys(q.extra).every((k) =>
          ["name", "version", "facilitator", "caip2", "displayAmount"].includes(
            k,
          ),
        ) &&
        q.extra.name === "USD Coin" &&
        q.extra.version === "2" &&
        (q.extra.caip2 === undefined || q.extra.caip2 === BASE) &&
        (q.extra.displayAmount === undefined ||
          q.extra.displayAmount === "$0.003"),
      "payment_domain_refused",
    );
    if (q.extra.facilitator !== undefined) https(q.extra.facilitator);
  } else
    check(
      canonical(q.extra) === canonical({ name: "USD Coin", version: "2" }),
      "payment_domain_refused",
    );
  check(Number.isSafeInteger(now), "invalid_clock");
  return structuredClone(q);
}
export const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};
export function checkTypedData(d, q, buyer, now, timing = "zero") {
  check(
    d.primaryType === "TransferWithAuthorization" &&
      canonical(d.types) === canonical(TYPES),
    "typed_data_type_refused",
  );
  check(
    canonical(d.domain) ===
      canonical({
        name: "USD Coin",
        version: "2",
        chainId: 8453,
        verifyingContract: USDC,
      }),
    "typed_data_domain_refused",
  );
  const m = d.message;
  check(
    m &&
      Object.keys(m).sort().join(",") ===
        "from,nonce,to,validAfter,validBefore,value" &&
      address(m.from) === address(buyer) &&
      address(m.to) === address(q.payTo) &&
      BigInt(m.value) === BigInt(q.amount) &&
      (timing === "zero"
        ? BigInt(m.validAfter) === 0n
        : timing === "recent" &&
          BigInt(m.validAfter) >= BigInt(now - 601) &&
          BigInt(m.validAfter) <= BigInt(now)) &&
      BigInt(m.validBefore) > BigInt(now) &&
      BigInt(m.validBefore) <= BigInt(now + q.maxTimeoutSeconds) &&
      /^0x[0-9a-fA-F]{64}$/.test(m.nonce),
    "typed_data_effects_refused",
  );
  return {
    network: BASE,
    asset: USDC,
    buyer,
    payTo: q.payTo,
    amount: q.amount,
    nonce: m.nonce,
    validBefore: String(m.validBefore),
    validAfter: String(m.validAfter),
  };
}
export function jsonSafe(v) {
  return JSON.parse(
    JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)),
  );
}

export function strictJson(raw, limit = 262144) {
  return parse(raw, { ordinaryNumbers: true, limit });
}
