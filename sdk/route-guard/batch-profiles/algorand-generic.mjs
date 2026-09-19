// Generic two-item same-payee manifest; buyer pins each job hash and price bounds.
import { createHash } from "node:crypto";
const uint = (value) => {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(value) ||
    BigInt(value) > 2n ** 64n - 1n
  )
    throw new Error("unsupported_algorand_two_item");
  return BigInt(value);
};
const NETWORK = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
  ASSET = "31566704",
  EXTENSION = "402signal-atomic-batch";
const check = (x) => {
  if (!x) throw new Error("unsupported_algorand_two_item");
};
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
const keys = (o, w) =>
  o &&
  Object.getPrototypeOf(o) === Object.prototype &&
  Object.keys(o).sort().join(",") === [...w].sort().join(",");
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
export function validateAlgorandGenericProfile(e, ctx, l) {
  try {
    check(
      keys(l, [
        "network",
        "asset",
        "recipient",
        "fee_payer",
        "max_item_amount_atomic",
        "max_total_amount_atomic",
        "max_sponsor_fee_micro_algo",
        "job_hashes",
      ]),
    );
    check(
      keys(ctx, ["url", "method", "body_sha256"]) &&
        ctx.method === "GET" &&
        ctx.body_sha256 === createHash("sha256").update("").digest("hex"),
    );
    check(
      typeof ctx.url === "string" &&
        ctx.url.length <= 4096 &&
        /^[\x21-\x7e]+$/.test(ctx.url) &&
        !/[\\#]/.test(ctx.url),
    );
    const u = new URL(ctx.url);
    check(
      u.protocol === "https:" &&
        u.hostname &&
        !u.username &&
        !u.password &&
        !u.hash &&
        !u.port,
    );
    check(
      Array.isArray(l.job_hashes) &&
        l.job_hashes.length === 2 &&
        l.job_hashes.every(
          (x) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x),
        ),
    );
    check(
      e &&
        Object.keys(e).every((k) =>
          [
            "x402Version",
            "resource",
            "accepts",
            "extensions",
            "error",
          ].includes(k),
        ) &&
        e.x402Version === 2,
    );
    check(
      e.resource &&
        Object.keys(e.resource).every((k) =>
          ["url", "mimeType", "description"].includes(k),
        ) &&
        e.resource.url === ctx.url &&
        Object.values(e.resource).every(
          (x) => typeof x === "string" && Buffer.byteLength(x, "utf8") <= 4096,
        ),
    );
    check(
      !("error" in e) ||
        (typeof e.error === "string" &&
          Buffer.byteLength(e.error, "utf8") <= 1024),
    );
    check(Array.isArray(e.accepts) && e.accepts.length === 1);
    const req = e.accepts[0];
    check(
      keys(req, [
        "scheme",
        "network",
        "asset",
        "amount",
        "payTo",
        "maxTimeoutSeconds",
        "extra",
      ]) &&
        req.scheme === "exact" &&
        req.network === NETWORK &&
        req.asset === ASSET &&
        Number.isSafeInteger(req.maxTimeoutSeconds) &&
        req.maxTimeoutSeconds >= 1 &&
        req.maxTimeoutSeconds <= 300,
    );
    const amount = uint(req.amount),
      total = String(amount * 2n);
    uint(total);
    const extra = req.extra;
    check(
      extra &&
        Object.keys(extra).every((k) => ["feePayer", "decimals"].includes(k)) &&
        (!("decimals" in extra) || extra.decimals === 6),
    );
    address(req.payTo);
    address(extra.feePayer);
    check(req.payTo !== extra.feePayer);
    const expected = {
      version: 1,
      network: NETWORK,
      asset: ASSET,
      recipient: req.payTo,
      resource: ctx.url,
      requestHash: createHash("sha256").update(canonical(ctx)).digest("hex"),
      itemCount: 2,
      itemAmount: req.amount,
      totalAmount: total,
      paymentIndices: [1, 2],
      sponsorIndex: 0,
      feePayer: extra.feePayer,
      maxSponsorFeeMicroAlgo: "15000",
      jobHashes: l.job_hashes,
    };
    check(
      keys(e.extensions, [EXTENSION]) &&
        canonical(e.extensions[EXTENSION]) === canonical(expected),
    );
    check(
      l.network === NETWORK &&
        l.asset === ASSET &&
        l.recipient === req.payTo &&
        l.fee_payer === extra.feePayer,
    );
    check(
      amount <= uint(l.max_item_amount_atomic) &&
        BigInt(total) <= uint(l.max_total_amount_atomic) &&
        uint(l.max_sponsor_fee_micro_algo) >= 15000n,
    );
    return expected;
  } catch {
    throw new Error("unsupported_algorand_two_item");
  }
}
