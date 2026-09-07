const CDP = "https://api.cdp.coinbase.com/platform/v2/x402";
async function body(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  let n = 0;
  const chunks = [];
  try {
    while (true) {
      const x = await reader.read();
      if (x.done) break;
      n += x.value.length;
      if (n > limit) throw Error("response bound");
      chunks.push(x.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}
export function createCdpBatchProvider({
  authorization,
  fetch: transport = globalThis.fetch,
}) {
  if (typeof authorization !== "function")
    throw Error("owner auth callback required");
  const call = async (kind, payload) => {
    if (!["supported", "verify", "settle"].includes(kind))
      throw Error("provider method refused");
    const url = CDP + "/" + kind,
      method = kind === "supported" ? "GET" : "POST";
    const headers = await authorization({ url, method });
    if (
      !headers ||
      typeof headers.Authorization !== "string" ||
      !headers.Authorization.startsWith("Bearer ") ||
      Object.keys(headers).some((k) => k !== "Authorization")
    )
      throw Error("provider authorization invalid");
    try {
      const response = await transport(url, {
        method,
        headers: { ...headers, "Content-Type": "application/json" },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(20000),
      });
      const text = await body(response, 262144);
      if (!response.ok) throw Error("provider rejected");
      return JSON.parse(text);
    } catch {
      throw Error("provider outcome unavailable; do not retry payment");
    }
  };
  return {
    getSupported: () => call("supported"),
    verify: (paymentPayload, paymentRequirements) =>
      call("verify", { x402Version: 2, paymentPayload, paymentRequirements }),
    settle: (paymentPayload, paymentRequirements) =>
      call("settle", { x402Version: 2, paymentPayload, paymentRequirements }),
  };
}
/** Explicit one-shot merchant callback. Caller durably claims a stage first. */
export function createMerchantSender(
  url,
  { fetch: transport = globalThis.fetch, native = false } = {},
) {
  const u = new URL(url);
  if (u.protocol !== "https:" || u.username || u.password || u.hash)
    throw Error("merchant URL refused");
  return async (credential) => {
    const value = native
      ? credential.authorization
      : Buffer.from(JSON.stringify(credential)).toString("base64");
    if (typeof value !== "string" || value.length > 32768)
      throw Error("credential bound");
    const response = await transport(url, {
      method: "GET",
      headers: { [native ? "Authorization" : "PAYMENT-SIGNATURE"]: value },
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(20000),
    });
    const text = await body(response, 65536);
    if (response.status !== 200) throw Error("merchant outcome unavailable");
    const result = JSON.parse(text);
    return native ? result : result.billing;
  };
}
