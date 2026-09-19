// Pure two-job Algorand profile. Never signs, sends, or chooses buyer limits.
import { createHash } from "node:crypto";
const EXTENSION = "402signal-atomic-batch",
  NETWORK = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
  ASSET = "31566704";
const check = (x) => {
  if (!x) throw new Error("unsupported_algorand_batch");
};
const sha = (x) => createHash("sha256").update(x).digest("hex");
const canonical = (x) => {
  if (x === null || typeof x === "boolean" || typeof x === "string")
    return JSON.stringify(x);
  if (Number.isSafeInteger(x)) return String(x);
  if (Array.isArray(x)) return "[" + x.map(canonical).join(",") + "]";
  check(x && Object.getPrototypeOf(x) === Object.prototype);
  return (
    "{" +
    Object.keys(x)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(x[k]))
      .join(",") +
    "}"
  );
};
const keys = (o, want) =>
  o &&
  Object.getPrototypeOf(o) === Object.prototype &&
  Object.keys(o).sort().join(",") === [...want].sort().join(",");
const address = (s) => {
  check(typeof s === "string" && /^[A-Z2-7]{58}$/.test(s));
  let bits = 0,
    value = 0;
  const out = [];
  for (const c of s) {
    value = (value << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 255);
    }
  }
  const b = Buffer.from(out);
  check(
    (value & ((1 << bits) - 1)) === 0 &&
      createHash("sha512-256")
        .update(b.subarray(0, 32))
        .digest()
        .subarray(-4)
        .equals(b.subarray(32)),
  );
};
const uint = (s) => {
  check(typeof s === "string" && /^[1-9][0-9]{0,19}$/.test(s));
  const n = BigInt(s);
  check(n <= 2n ** 64n - 1n);
  return n;
};
export function validateAlgorandBatchProfile(envelope, context, limits) {
  try {
    check(
      keys(limits, [
        "network",
        "asset",
        "recipient",
        "fee_payer",
        "max_total_amount_atomic",
        "max_sponsor_fee_micro_algo",
      ]),
    );
    check(
      keys(context, ["url", "method", "body_sha256"]) &&
        context.method === "GET" &&
        context.body_sha256 === sha(""),
    );
    const url = context.url;
    check(
      typeof url === "string" &&
        url.length <= 4096 &&
        /^[\x21-\x7e]+$/.test(url) &&
        !url.includes(String.fromCharCode(92)),
    );
    const u = new URL(url);
    check(
      u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        !u.hash &&
        !u.port &&
        /^https:\/\/[^/?#]+\/algorand\/batch\/sha256\?[^#]+$/.test(url),
    );
    check(!/%(?![0-9a-fA-F]{2})/.test(u.search));
    decodeURIComponent(u.search.replace(/\+/g, " "));
    const entries = [...u.searchParams];
    check(
      entries.length === 2 &&
        entries
          .map(([k]) => k)
          .sort()
          .join(",") === "left,right",
    );
    const texts = ["left", "right"].map((k) => u.searchParams.get(k));
    check(
      texts.every(
        (t) => t.length >= 1 && t.length <= 1024 && !/[\uD800-\uDFFF]/u.test(t),
      ),
    );
    check(
      envelope &&
        Object.keys(envelope).every((k) =>
          [
            "x402Version",
            "resource",
            "accepts",
            "extensions",
            "error",
          ].includes(k),
        ) &&
        envelope.x402Version === 2,
    );
    check(
      envelope.resource?.url === url &&
        Array.isArray(envelope.accepts) &&
        envelope.accepts.length === 1,
    );
    const r = envelope.accepts[0];
    check(
      r &&
        Object.keys(r).every((k) =>
          [
            "scheme",
            "network",
            "asset",
            "amount",
            "payTo",
            "maxTimeoutSeconds",
            "extra",
          ].includes(k),
        ) &&
        r.scheme === "exact" &&
        r.network === NETWORK &&
        r.asset === ASSET &&
        r.amount === "1000" &&
        Number.isSafeInteger(r.maxTimeoutSeconds) &&
        r.maxTimeoutSeconds >= 1 &&
        r.maxTimeoutSeconds <= 300,
    );
    check(
      r.extra &&
        Object.keys(r.extra).every((k) =>
          ["feePayer", "decimals"].includes(k),
        ) &&
        (!("decimals" in r.extra) || r.extra.decimals === 6),
    );
    address(r.payTo);
    address(r.extra.feePayer);
    check(r.payTo !== r.extra.feePayer);
    const expected = {
      version: 1,
      network: NETWORK,
      asset: ASSET,
      recipient: r.payTo,
      resource: url,
      requestHash: sha(canonical(context)),
      itemCount: 2,
      itemAmount: "1000",
      totalAmount: "2000",
      paymentIndices: [1, 2],
      sponsorIndex: 0,
      feePayer: r.extra.feePayer,
      maxSponsorFeeMicroAlgo: "15000",
      jobHashes: texts.map(sha),
    };
    check(
      keys(envelope.extensions, [EXTENSION]) &&
        canonical(envelope.extensions[EXTENSION]) === canonical(expected),
    );
    check(
      limits.network === NETWORK &&
        limits.asset === ASSET &&
        limits.recipient === expected.recipient &&
        limits.fee_payer === expected.feePayer &&
        uint(limits.max_total_amount_atomic) >= 2000n &&
        uint(limits.max_sponsor_fee_micro_algo) >= 15000n,
    );
    return expected;
  } catch {
    throw new Error("unsupported_algorand_batch");
  }
}
