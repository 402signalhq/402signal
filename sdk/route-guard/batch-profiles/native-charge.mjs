import { createHash } from "node:crypto";
import { parse } from "../internal-json.mjs";
const check = (ok) => { if (!ok) throw new Error("unsupported_native_charge"); };
const canonical = (x) => Array.isArray(x) ? "[" + x.map(canonical).join(",") + "]"
  : x !== null && typeof x === "object" ? "{" + Object.keys(x).sort().map(k => JSON.stringify(k) + ":" + canonical(x[k])).join(",") + "}"
  : JSON.stringify(x);
const emptyDigest = "sha-256=" + createHash("sha256").update("").digest("base64");

/** Exact original segments; commas and escaped quotes inside values are data. */
export function nativeChargeChallenges(raw) {
  check(typeof raw === "string" && raw.length > 0 && raw.length <= 16384 && /^[\x20-\x7e]+$/.test(raw));
  const items = []; let at = 0;
  while (at < raw.length) {
    check(items.length < 16 && raw.startsWith("Payment ", at));
    const start = at; at += 8;
    const params = Object.create(null); let end;
    for (;;) {
      while (raw[at] === " ") at++;
      const match = /^([A-Za-z][A-Za-z0-9_-]*)="((?:[^"\\]|\\[\x20-\x7e])*)"/.exec(raw.slice(at));
      check(match); const name = match[1].toLowerCase(); check(!Object.hasOwn(params, name));
      params[name] = match[2].replace(/\\(.)/g, "$1"); at += match[0].length; end = at;
      while (raw[at] === " ") at++;
      if (at === raw.length) break;
      check(raw[at] === ","); at++; while (raw[at] === " ") at++;
      check(at < raw.length); if (raw.startsWith("Payment ", at)) break;
    }
    const required = ["id", "realm", "method", "intent", "request", "expires"];
    check(required.every(k => Object.hasOwn(params, k)) && Object.keys(params).every(k => [...required, "description", "digest", "opaque", "header"].includes(k)));
    check(params.id.length > 0 && params.id.length <= 256);
    check(!Object.hasOwn(params, "header") || ["authorization", "payment-authorization"].includes(params.header.toLowerCase()));
    check(/^[A-Za-z0-9_-]+$/.test(params.request)); const bytes = Buffer.from(params.request, "base64url");
    check(bytes.toString("base64url") === params.request);
    check(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(params.expires));
    const ms = Date.parse(params.expires); check(Number.isFinite(ms));
    const normalized = params.expires.replace(/(?:\.(\d{1,3}))?Z$/, (_, f) => "." + (f ?? "").padEnd(3, "0") + "Z");
    check(new Date(ms).toISOString() === normalized);
    items.push({ raw: raw.slice(start, end), params,
      request: parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes), { ordinaryNumbers: true, limit: 16384 }),
      expiry: Math.floor(ms / 1000), index: items.length });
  }
  check(items.length > 0); return items;
}

/** Exactly one explicit profile match. No price ranking or protocol fallback. */
export function selectNativeCharge(c, ctx, method, expectedRealm, validator, bodyDigest = emptyDigest) {
  check(c.status === 402 && typeof c.bodyText === "string" && Buffer.byteLength(c.bodyText) <= 16384);
  check(c.paymentRequired === null || typeof c.paymentRequired === "string" && c.paymentRequired.length > 0 && c.paymentRequired.length <= 16384 && /^[\x20-\x7e]+$/.test(c.paymentRequired));
  check(Buffer.byteLength(canonical(c)) <= 24576);
  const realm = expectedRealm ?? new URL(ctx.url).hostname;
  const matches = nativeChargeChallenges(c.wwwAuthenticate).filter(item => {
    const p = item.params;
    if (p.method !== method || p.intent !== "charge" || p.realm !== realm ||
        Object.hasOwn(p, "digest") && p.digest !== bodyDigest) return false;
    if (validator) { try { validator(item.request); } catch { return false; } }
    return true;
  });
  check(matches.length === 1); return matches[0];
}
export function nativeChargeWire(c, ctx, method, expectedRealm, validator) {
  const selected = selectNativeCharge(c, ctx, method, expectedRealm, validator);
  return [selected.request, selected.expiry];
}
