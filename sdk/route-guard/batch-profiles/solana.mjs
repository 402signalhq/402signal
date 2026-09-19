// Native push session: cap and voucher increment never imply a call price.
import { uint } from "./base.mjs";
const check = (x) => {
  if (!x) throw new Error("unsupported_solana_session");
};
const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  ASSET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  PROGRAM = "CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX";
function address(v) {
  check(typeof v === "string" && v.length >= 32 && v.length <= 44);
  let n = 0n;
  const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  for (const c of v) {
    check(chars.includes(c));
    n = n * 58n + BigInt(chars.indexOf(c));
  }
  const size = n === 0n ? 0 : Math.ceil(n.toString(2).length / 8);
  check(size + v.length - v.replace(/^1+/, "").length === 32);
}
export function validateSolanaSessionProfile(e, ctx, l) {
  try {
    check(
      l &&
        Object.keys(l).sort().join(",") ===
          [
            "network",
            "asset",
            "recipient",
            "operator",
            "program_id",
            "max_session_cap_atomic",
          ]
            .sort()
            .join(","),
    );
    const required = [
      "cap",
      "currency",
      "decimals",
      "network",
      "operator",
      "programId",
      "recentBlockhash",
      "recentSlot",
      "recipient",
    ];
    check(
      e &&
        required.every((k) => Object.hasOwn(e, k)) &&
        Object.keys(e).every((k) =>
          [...required, "minVoucherDelta", "modes"].includes(k),
        ),
    );
    check(
      e.currency === ASSET &&
        e.decimals === 6 &&
        e.network === "mainnet" &&
        e.programId === PROGRAM &&
        (!("modes" in e) ||
          (Array.isArray(e.modes) &&
            e.modes.length === 1 &&
            e.modes[0] === "push")),
    );
    for (const k of ["operator", "recipient", "programId", "recentBlockhash"])
      address(e[k]);
    uint(e.recentSlot);
    const cap = uint(e.cap);
    if ("minVoucherDelta" in e) check(uint(e.minVoucherDelta) <= cap);
    check(
      l.network === NETWORK &&
        l.asset === ASSET &&
        l.recipient === e.recipient &&
        l.operator === e.operator &&
        l.program_id === PROGRAM &&
        cap <= uint(l.max_session_cap_atomic),
    );
    return {
      network: NETWORK,
      asset: ASSET,
      recipient: e.recipient,
      operator: e.operator,
      program_id: PROGRAM,
      session_cap_atomic: e.cap,
      min_voucher_delta_atomic: e.minVoucherDelta ?? null,
      recent_blockhash: e.recentBlockhash,
      recent_slot: e.recentSlot,
      mode: "push",
      per_call_amount_atomic: null,
    };
  } catch {
    throw new Error("unsupported_solana_session");
  }
}
