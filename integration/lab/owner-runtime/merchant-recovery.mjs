import { createHash } from "node:crypto";
import { parse } from "../sdk/route-guard/internal-json.mjs";
const sha = (x) => createHash("sha256").update(x).digest("hex");
/** Same saved authority, explicit recovery-only header, never an ordinary retry. */
export function createMerchantRecovery(
  url,
  { fetch: send = globalThis.fetch, native = false } = {},
) {
  const u = new URL(url);
  if (
    u.protocol !== "https:" ||
    u.href !== url ||
    u.username ||
    u.password ||
    u.hash
  )
    throw Error("recovery_url_refused");
  return async (credential) => {
    const value = native
      ? credential.authorization
      : Buffer.from(JSON.stringify(credential)).toString("base64");
    if (typeof value !== "string" || !value.length || value.length > 32768)
      throw Error("saved_credential_required");
    const r = await send(url, {
      method: "GET",
      headers: {
        [native ? "Authorization" : "PAYMENT-SIGNATURE"]: value,
        "Replay-Only": "1",
      },
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (r.status !== 200 || r.redirected || (r.url && r.url !== url))
      throw Error("merchant_recovery_unavailable");
    const reader = r.body?.getReader();
    let size = 0;
    const chunks = [];
    if (reader)
      try {
        for (;;) {
          const x = await reader.read();
          if (x.done) break;
          size += x.value.length;
          if (size > 16384) throw Error("merchant_recovery_bound");
          chunks.push(x.value);
        }
      } catch (e) {
        await reader.cancel().catch(() => {});
        throw e;
      }
    const bodyText = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
    const body = parse(bodyText, { ordinaryNumbers: true, limit: 16384 });
    const authorizationDigest = sha(value),
      identity = { url, status: 200, bodyText, authorizationDigest };
    return {
      recoveryOnly: true,
      url,
      authorizationDigest,
      evidenceDigest: sha(JSON.stringify(identity)),
      bodyText,
      body,
    };
  };
}
