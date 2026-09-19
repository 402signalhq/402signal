// Version2 payment manifests. No network, wallet access or implicit per-job pricing.
import { createHash } from "node:crypto";
const uint = (value) => {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(value) ||
    BigInt(value) > 2n ** 64n - 1n
  )
    throw new Error("unsupported_algorand_manifest");
  return BigInt(value);
};
const NETWORK = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
  ASSET = "31566704",
  EXTENSION = "402signal-atomic-batch";
const check = (x) => {
  if (!x) throw new Error("unsupported_algorand_manifest");
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
export const ATOMIC = "algorand-atomic-multi-item-v1";
export const INVOICE = "algorand-aggregate-invoice-v1";
export function validateAlgorandManifestLimits(profile, l) {
  check(profile === ATOMIC || profile === INVOICE);
  check(
    keys(l, [
      "network",
      "asset",
      "recipient",
      "fee_payer",
      "max_total_amount_atomic",
      "max_sponsor_fee_micro_algo",
      "job_hashes",
      ...(profile === ATOMIC ? ["max_item_amount_atomic"] : []),
    ]),
  );
  check(l.network === NETWORK && l.asset === ASSET);
  for (const [k, v] of Object.entries(l)) if (k.startsWith("max_")) uint(v);
  address(l.recipient);
  address(l.fee_payer);
  check(l.recipient !== l.fee_payer);
  check(
    Array.isArray(l.job_hashes) &&
      l.job_hashes.length >= 2 &&
      l.job_hashes.length <= (profile === ATOMIC ? 15 : 64) &&
      l.job_hashes.every(
        (h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h),
      ),
  );
  return l.job_hashes.length;
}
export function validateAlgorandFeeQuote(q, payments) {
  check(
    keys(q, [
      "network",
      "genesisHash",
      "genesisId",
      "transactionCount",
      "firstValid",
      "lastValid",
      "minFeeMicroAlgo",
      "feePerByteMicroAlgo",
      "sponsorFeeMicroAlgo",
      "observedAt",
      "expiresAt",
    ]),
  );
  check(
    q.network === NETWORK &&
      q.genesisHash === "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=" &&
      q.genesisId === "mainnet-v1.0" &&
      q.transactionCount === payments + 1,
  );
  const first = uint(q.firstValid),
    last = uint(q.lastValid),
    minimum = uint(q.minFeeMicroAlgo);
  check(
    first <= last &&
      last <= first + 1000n &&
      minimum >= 1000n &&
      minimum <= 5000n &&
      q.feePerByteMicroAlgo === "0",
  );
  check(uint(q.sponsorFeeMicroAlgo) === minimum * BigInt(payments + 1));
  check(
    Number.isSafeInteger(q.observedAt) &&
      q.observedAt > 0 &&
      Number.isSafeInteger(q.expiresAt) &&
      q.expiresAt > q.observedAt &&
      q.expiresAt <= q.observedAt + 60,
  );
  return q.expiresAt;
}
export function validateAlgorandManifestProfile(e, ctx, l, profile) {
  try {
    canonical(e);
    canonical(l);
    const count = validateAlgorandManifestLimits(profile, l);
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
    const url = new URL(ctx.url);
    check(
      ctx.url.startsWith("https://") &&
        url.protocol === "https:" &&
        url.hostname &&
        !url.username &&
        !url.password &&
        !url.hash &&
        !url.port,
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
          (v) => typeof v === "string" && Buffer.byteLength(v, "utf8") <= 4096,
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
        req.payTo === l.recipient &&
        Number.isSafeInteger(req.maxTimeoutSeconds) &&
        req.maxTimeoutSeconds >= 1 &&
        req.maxTimeoutSeconds <= 300,
    );
    const extra = req.extra;
    check(
      extra &&
        Object.keys(extra).every((k) => ["feePayer", "decimals"].includes(k)) &&
        extra.feePayer === l.fee_payer &&
        (!("decimals" in extra) || extra.decimals === 6),
    );
    const amount = uint(req.amount),
      payments = profile === ATOMIC ? count : 1,
      total = String(amount * BigInt(payments));
    uint(total);
    check(keys(e.extensions, [EXTENSION]));
    const manifest = e.extensions[EXTENSION];
    check(manifest && Object.hasOwn(manifest, "feeQuote"));
    const quote = manifest.feeQuote;
    validateAlgorandFeeQuote(quote, payments);
    const expected = {
      version: 2,
      profile,
      network: NETWORK,
      asset: ASSET,
      recipient: req.payTo,
      resource: ctx.url,
      requestHash: createHash("sha256").update(canonical(ctx)).digest("hex"),
      jobCount: count,
      paymentCount: payments,
      paymentAmount: req.amount,
      perJobAmount: profile === ATOMIC ? req.amount : null,
      totalAmount: total,
      paymentIndices: Array.from({ length: payments }, (_, i) => i + 1),
      sponsorIndex: 0,
      feePayer: extra.feePayer,
      jobHashes: l.job_hashes,
      feeQuote: quote,
    };
    check(canonical(manifest) === canonical(expected));
    check(
      BigInt(total) <= uint(l.max_total_amount_atomic) &&
        uint(quote.sponsorFeeMicroAlgo) <= uint(l.max_sponsor_fee_micro_algo),
    );
    if (profile === ATOMIC) check(amount <= uint(l.max_item_amount_atomic));
    return expected;
  } catch {
    throw new Error("unsupported_algorand_manifest");
  }
}
export const validateAlgorandAtomicMultiProfile = (e, c, l) =>
  validateAlgorandManifestProfile(e, c, l, ATOMIC);
export const validateAlgorandInvoiceProfile = (e, c, l) =>
  validateAlgorandManifestProfile(e, c, l, INVOICE);
