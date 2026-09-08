import { createHash } from "node:crypto";

const check = (x) => {
  if (!x) throw Error("unsupported_algorand_charge");
};
const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const keys = (v, required, optional = []) =>
  check(
    object(v) &&
      required.every((k) => Object.hasOwn(v, k)) &&
      Object.keys(v).every((k) => [...required, ...optional].includes(k)),
  );
const text = (v, max) =>
  check(
    typeof v === "string" &&
      Buffer.byteLength(v) > 0 &&
      Buffer.byteLength(v) <= max,
  );
const uint = (v) => {
  check(
    typeof v === "string" &&
      /^[1-9][0-9]{0,19}$/.test(v) &&
      BigInt(v) <= 2n ** 64n - 1n,
  );
  return BigInt(v);
};
function address(v) {
  check(
    typeof v === "string" &&
      /^[A-Z2-7]{58}$/.test(v) &&
      v !== "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
  );
  let bits = 0,
    value = 0,
    out = [];
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  for (const c of v) {
    value = (value << 5) | alphabet.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 255);
    }
  }
  check(bits === 2 && (value & 3) === 0);
  const b = Buffer.from(out);
  check(
    b.length === 36 &&
      b
        .subarray(32)
        .equals(
          createHash("sha512-256")
            .update(b.subarray(0, 32))
            .digest()
            .subarray(-4),
        ),
  );
}
export const ALGORAND_CHARGE_PROFILE = "algorand-mpp-charge-v1";
export const ALGORAND_CHARGE_NETWORK =
  "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
export const ALGORAND_CHARGE_ASSET = "31566704";
export const ALGORAND_CHARGE_KEYS = [
  "network",
  "asset",
  "recipient",
  "realm",
  "max_amount_atomic",
  "max_network_fee_micro_algo",
  "fee_payer",
];
export function validateAlgorandChargeLimits(l) {
  keys(l, ALGORAND_CHARGE_KEYS);
  check(
    l.network === ALGORAND_CHARGE_NETWORK && l.asset === ALGORAND_CHARGE_ASSET,
  );
  address(l.recipient);
  text(l.realm, 256);
  check(l.realm.trim().length > 0 && /^[\x20-\x7e]+$/.test(l.realm));
  uint(l.max_amount_atomic);
  uint(l.max_network_fee_micro_algo);
  if (l.fee_payer !== null) {
    address(l.fee_payer);
    check(l.fee_payer !== l.recipient);
  }
}

export function algorandChargeFeeModel(r) {
  const m = r.methodDetails,
    p = m.suggestedParams,
    sponsored = m.feePayer === true;
  const integer = (n) => {
    n = BigInt(n);
    return n <= 127n
      ? 1
      : n <= 255n
        ? 2
        : n <= 65535n
          ? 3
          : n <= 4294967295n
            ? 5
            : 9;
  };
  const str = (s) => {
    const n = Buffer.byteLength(s);
    return n + (n < 32 ? 1 : n <= 255 ? 2 : 3);
  };
  const bin = (n) => n + (n <= 255 ? 2 : 3),
    note =
      "mppx:" + m.challengeReference + (r.externalId ? ":" + r.externalId : "");
  const size = (kind, fee) => {
    const f = {
      fv: integer(p.firstValid),
      lv: integer(p.lastValid),
      gen: str("mainnet-v1.0"),
      gh: bin(32),
      grp: bin(32),
      snd: bin(32),
      type: str(kind),
    };
    if (fee > 0n) f.fee = integer(fee);
    if (kind === "pay") f.rcv = bin(32);
    else
      Object.assign(f, {
        arcv: bin(32),
        xaid: integer(m.asaId),
        aamt: integer(r.amount),
        lx: bin(32),
        note: bin(Buffer.byteLength(note)),
      });
    return (
      (Object.keys(f).length < 16 ? 1 : 3) +
      Object.entries(f).reduce((sum, [k, n]) => sum + str(k) + n, 0)
    );
  };
  const required = (n) => {
      const v = BigInt(p.fee) * BigInt(n);
      return v > BigInt(p.minFee) ? v : BigInt(p.minFee);
    },
    kinds = sponsored ? ["pay", "axfer"] : ["axfer"];
  const quoted = kinds.reduce((n, k) => n + required(size(k, 0n)), 0n),
    sizes = kinds.map((k, i) => size(k, i === 0 ? quoted : 0n));
  check(quoted >= sizes.reduce((n, size) => n + required(size + 75), 0n));
  return { fee: String(quoted), unsignedSizes: sizes };
}

export function validateAlgorandChargeProfile(r, ctx, l) {
  validateAlgorandChargeLimits(l);
  keys(ctx, ["url", "method", "body_sha256"]);
  check(
    ctx.method === "GET" &&
      ctx.body_sha256 === createHash("sha256").update("").digest("hex"),
  );
  keys(
    r,
    ["amount", "currency", "recipient", "methodDetails"],
    ["description", "externalId"],
  );
  text(r.currency, 64);
  check(
    r.recipient === l.recipient && uint(r.amount) <= uint(l.max_amount_atomic),
  );
  for (const [k, n] of [
    ["description", 4096],
    ["externalId", 256],
  ])
    if (Object.hasOwn(r, k)) text(r[k], n);
  const m = r.methodDetails;
  keys(
    m,
    ["network", "asaId", "challengeReference", "lease", "suggestedParams"],
    ["feePayer", "feePayerKey"],
  );
  check(
    m.network === ALGORAND_CHARGE_NETWORK && m.asaId === ALGORAND_CHARGE_ASSET,
  );
  text(m.challengeReference, 256);
  const lease = createHash("sha256")
    .update(m.challengeReference)
    .digest("base64");
  check(m.lease === lease);
  const sponsored = l.fee_payer !== null;
  if (sponsored) check(m.feePayer === true && m.feePayerKey === l.fee_payer);
  else
    check(
      (!Object.hasOwn(m, "feePayer") || m.feePayer === false) &&
        !Object.hasOwn(m, "feePayerKey"),
    );
  const p = m.suggestedParams;
  keys(p, [
    "fee",
    "firstValid",
    "lastValid",
    "genesisHash",
    "genesisId",
    "minFee",
  ]);
  check(
    p.genesisHash === ALGORAND_CHARGE_NETWORK.slice(9) &&
      p.genesisId === "mainnet-v1.0",
  );
  for (const k of ["fee", "firstValid", "lastValid", "minFee"])
    check(Number.isSafeInteger(p[k]) && p[k] >= 0);
  check(
    p.minFee >= 1000 &&
      p.firstValid > 0 &&
      p.firstValid <= p.lastValid &&
      p.lastValid <= p.firstValid + 1000,
  );
  const count = sponsored ? 2 : 1,
    total = BigInt(p.minFee) * BigInt(count);
  check(total <= uint(l.max_network_fee_micro_algo));
  const fee = algorandChargeFeeModel(r).fee;
  check(BigInt(fee) <= uint(l.max_network_fee_micro_algo));
  return {
    protocol: "mpp",
    method: "algorand",
    intent: "charge",
    network: ALGORAND_CHARGE_NETWORK,
    asset: ALGORAND_CHARGE_ASSET,
    recipient: r.recipient,
    amount_atomic: r.amount,
    currency_label: r.currency,
    fee_payer: l.fee_payer,
    transaction_count: count,
    minimum_group_fee_micro_algo: String(total),
    network_fee_micro_algo: fee,
    fee_quote_requires_buyer_validation: true,
    challenge_reference: m.challengeReference,
    lease,
    suggested_params: p,
  };
}
