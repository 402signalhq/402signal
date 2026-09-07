// Pure pinned Base batch offer. Capital is buyer policy, never the per-call price.
const check = (x) => {
  if (!x) throw new Error("unsupported_base_batch");
};
const exact = (x, keys) =>
  x &&
  Object.getPrototypeOf(x) === Object.prototype &&
  Object.keys(x).sort().join(",") === [...keys].sort().join(",");
export const uint = (v) => {
  check(typeof v === "string" && /^[1-9][0-9]{0,19}$/.test(v));
  const n = BigInt(v);
  check(n <= 2n ** 64n - 1n);
  return n;
};
const NETWORK = "eip155:8453",
  ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  AUTHORIZER = "0x3721824a31197dcDD2984cF43b92B6cc8A87c0Fb";
export function validateBaseBatchProfile(e, ctx, l) {
  try {
    check(
      exact(l, [
        "network",
        "asset",
        "recipient",
        "receiver_authorizer",
        "withdraw_delay_seconds",
        "max_call_amount_atomic",
        "max_capital_atomic",
        "max_cumulative_amount_atomic",
      ]),
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
    check(
      !("extensions" in e) ||
        exact(e.extensions, []) ||
        (exact(e.extensions, ["bazaar"]) && exact(e.extensions.bazaar, [])),
    );
    check(Array.isArray(e.accepts) && e.accepts.length === 1);
    const a = e.accepts[0];
    check(
      exact(a, [
        "scheme",
        "network",
        "asset",
        "amount",
        "payTo",
        "maxTimeoutSeconds",
        "extra",
      ]) &&
        a.scheme === "batch-settlement" &&
        a.network === NETWORK &&
        a.asset === ASSET,
    );
    check(
      typeof a.payTo === "string" &&
        /^0x[0-9a-fA-F]{40}$/.test(a.payTo) &&
        BigInt(a.payTo) > 0n &&
        Number.isSafeInteger(a.maxTimeoutSeconds) &&
        a.maxTimeoutSeconds >= 1 &&
        a.maxTimeoutSeconds <= 300,
    );
    check(
      exact(a.extra, [
        "name",
        "version",
        "assetTransferMethod",
        "receiverAuthorizer",
        "withdrawDelay",
      ]) &&
        a.extra.name === "USD Coin" &&
        a.extra.version === "2" &&
        a.extra.assetTransferMethod === "eip3009" &&
        a.extra.receiverAuthorizer === AUTHORIZER &&
        a.extra.withdrawDelay === 900,
    );
    check(
      l.network === NETWORK &&
        l.asset === ASSET &&
        l.recipient === a.payTo &&
        l.receiver_authorizer === AUTHORIZER &&
        l.withdraw_delay_seconds === 900,
    );
    check(
      uint(a.amount) <= uint(l.max_call_amount_atomic) &&
        uint(l.max_call_amount_atomic) <=
          uint(l.max_cumulative_amount_atomic) &&
        uint(l.max_cumulative_amount_atomic) <= uint(l.max_capital_atomic),
    );
    return {
      network: NETWORK,
      asset: ASSET,
      recipient: a.payTo,
      receiver_authorizer: AUTHORIZER,
      withdraw_delay_seconds: 900,
      call_amount_atomic: a.amount,
      max_timeout_seconds: a.maxTimeoutSeconds,
      scheme: "batch-settlement",
    };
  } catch {
    throw new Error("unsupported_base_batch");
  }
}
