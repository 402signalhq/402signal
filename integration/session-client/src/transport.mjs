import { check, hash, frozen, exact } from "./policy.mjs";
async function textBounded(response) {
  if (response.body === null) return "";
  check(
    response.body && response.body.getReader,
    "bounded streaming response required",
  );
  const reader = response.body.getReader(),
    parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      check(size <= 16384, "response too large");
      parts.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts));
}
/** Caller-owned transport. No redirect, retry, credential refresh, challenge
 * fetch, deposit or paid routing call. Recovery receives identifiers only;
 * it cannot accidentally replay a voucher at an ordinary paid endpoint. */
export function createSessionTransport({
  fetch: fetchImplementation = globalThis.fetch,
  readReceipt,
} = {}) {
  check(
    typeof fetchImplementation === "function",
    "fetch implementation required",
  );
  async function send(packet) {
    const snapshot = packet.request,
      headers = { Accept: "application/json" };
    headers[packet.rail === "solana" ? "Authorization" : "PAYMENT-SIGNATURE"] =
      packet.authorization;
    const body = snapshot.method === "POST" ? snapshot.body : undefined;
    if (snapshot.method === "POST")
      headers["Content-Type"] = "application/json";
    const response = await fetchImplementation(snapshot.url, {
      method: snapshot.method,
      headers,
      body,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    check(
      !response.redirected && (!response.url || response.url === snapshot.url),
      "response redirected",
    );
    const bodyText = await textBounded(response),
      selected = {};
    for (const name of ["payment-receipt", "payment-response"]) {
      const value = response.headers.get(name);
      if (value !== null) selected[name] = value;
    }
    return frozen({
      status: response.status,
      url: snapshot.url,
      requestDigest: snapshot.requestDigest,
      authorizationDigest: hash(packet.authorization),
      bodyText,
      headers: selected,
    });
  }
  async function recover(scope) {
    exact(scope, [
      "recoveryOnly",
      "channelId",
      "sequence",
      "requestDigest",
      "authorizationDigest",
    ]);
    check(
      scope.recoveryOnly === true && typeof readReceipt === "function",
      "merchant read-only receipt lookup unavailable",
    );
    // Only return a previously recorded HTTP acknowledgment for these exact IDs.
    // A standard payment endpoint is not a receipt lookup capability.
    const result = await readReceipt(frozen(scope));
    return frozen({ ...result, recoveryOnly: true });
  }
  return Object.freeze({ send, recover });
}
