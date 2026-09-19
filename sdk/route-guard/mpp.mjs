// 402Signal guard for mppx, the Machine Payments Protocol client.
//
//   import { Mppx } from "mppx";
//   import { mppGuard } from "@402signal/route-guard/mpp";
//
//   const guard = mppGuard({
//     fetchWithPayment: (url, init) => mppx.fetch(url, init), // pays the $0.003 checking fee
//     trustedLogVkey,                                          // pinned log key from configuration
//     maxCallAmountAtomic: "1000",                             // your per-call cap, atomic USDC
//   });
//   const mppx = Mppx.create({ methods, onChallenge: guard.onChallenge });
//   mppx.onChallengeReceived(guard.onChallengeReceived);
//
// mppx runs `challenge.received` observers first and `onChallenge` just before
// it creates a credential. The observer records which URL produced each
// challenge; the hook then asks 402Signal for a Check group offer observation
// of that URL under your caps (paying the checking fee with the same wallet),
// verifies the signed receipt locally against the pinned log key, and compares
// the verified terms with the live challenge mppx is about to pay. A thrown
// error propagates out of mppx's fetch, so nothing is signed. 402Signal's own
// fee challenge is let through, so the guard never recurses.
//
// MPP challenge ids and expiries are per request, so the live challenge is
// compared on its economic terms (network, asset, recipient, amount, intent,
// realm) rather than byte for byte. Hosted Check group offer must be enabled
// on the router (see /capabilities.json check_group_offer.codecs); otherwise
// every check is a miss and the guard aborts unless onMiss is "allow".
//
// Zero dependencies. Never holds keys, never signs, never retries.

import { RouteGuardError } from "./index.mjs";
import { verifyBatchRoute } from "./batch.mjs";
import { nativeChargeChallenges } from "./batch-profiles/native-charge.mjs";

export const DEFAULT_ROUTER = "https://402signal.com/route";
export const BASE_NETWORK = "eip155:8453";
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const MAX_REMEMBERED = 256;

export class MppGuardError extends RouteGuardError {
  constructor(code, detail) {
    super(code);
    this.name = "MppGuardError";
    this.detail = detail === undefined ? null : detail;
    if (detail !== undefined && detail !== null) this.message = `${code}: ${detail}`;
  }
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const lower = (value) => String(value ?? "").toLowerCase();

/** The exact URL string the buyer used; the router binds it byte for byte, so never normalise it. */
function requestUrl(input) {
  let url;
  if (typeof input === "string") url = input;
  else if (input instanceof URL) url = input.href;
  else if (isObject(input) && typeof input.url === "string") url = input.url;
  else throw new MppGuardError("mpp_guard_url_unknown", "request input has no url");
  new URL(url); // must parse
  return url;
}

function headerValue(response, name) {
  try {
    const value = response && response.headers && typeof response.headers.get === "function"
      ? response.headers.get(name)
      : null;
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Parse one raw WWW-Authenticate value into mppx-shaped challenge objects (strict, expires required). */
export function parseChallengeHeader(raw) {
  return nativeChargeChallenges(raw).map((item) => ({
    id: item.params.id,
    realm: item.params.realm,
    method: item.params.method,
    intent: item.params.intent,
    request: item.request,
    expires: item.params.expires,
    ...(Object.hasOwn(item.params, "description") ? { description: item.params.description } : {}),
    ...(Object.hasOwn(item.params, "digest") ? { digest: item.params.digest } : {}),
    ...(Object.hasOwn(item.params, "header") ? { header: item.params.header } : {}),
    ...(Object.hasOwn(item.params, "opaque") ? { opaque: item.params.opaque } : {}),
    raw: item.raw,
  }));
}

/** Economic terms of an mppx challenge object, or null when it is not a charge we understand. */
export function challengeTerms(challenge) {
  if (!isObject(challenge) || !isObject(challenge.request)) return null;
  const request = challenge.request;
  const details = isObject(request.methodDetails) ? request.methodDetails : {};
  return {
    realm: typeof challenge.realm === "string" ? challenge.realm : "",
    method: typeof challenge.method === "string" ? challenge.method : "",
    intent: typeof challenge.intent === "string" ? challenge.intent : "",
    amount: request.amount === undefined ? "" : String(request.amount),
    currency: typeof request.currency === "string" ? request.currency : "",
    recipient: typeof request.recipient === "string" ? request.recipient : "",
    chainId: Number.isSafeInteger(details.chainId) ? details.chainId : null,
  };
}

/**
 * Default buyer_limits for the hosted Check group offer: Base USDC charges only.
 * Returns null for anything the router cannot observe yet (other methods,
 * chains, assets or intents), which the guard treats as unsupported.
 */
export function defaultLimits(challenge, maxCallAmountAtomic) {
  const terms = challengeTerms(challenge);
  if (!terms || terms.method !== "evm" || terms.intent !== "charge" || terms.chainId !== 8453) return null;
  if (lower(terms.currency) !== lower(BASE_USDC)) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(terms.recipient) || !terms.realm) return null;
  const cap = String(maxCallAmountAtomic ?? "");
  if (!/^[1-9][0-9]*$/.test(cap)) return null;
  return {
    network: BASE_NETWORK,
    asset: BASE_USDC,
    recipient: terms.recipient,
    max_call_amount_atomic: cap,
    realm: terms.realm,
  };
}

/** Default check request: the exact URL, the buyer caps, bound evidence. */
export function defaultRequest(url, limits) {
  return { url, buyer_limits: limits, require_route_binding: true };
}

/** True when the live challenge carries exactly the terms 402Signal verified. */
export function sameTerms(verifiedTerms, challenge) {
  const live = challengeTerms(challenge);
  if (!isObject(verifiedTerms) || !live) return false;
  if (verifiedTerms.intent !== "charge" || live.intent !== "charge") return false;
  if (String(verifiedTerms.per_call_amount_atomic ?? "") !== live.amount) return false;
  if (lower(verifiedTerms.recipient) !== lower(live.recipient)) return false;
  if (lower(verifiedTerms.asset) !== lower(live.currency)) return false;
  return live.chainId !== null && verifiedTerms.network === `eip155:${live.chainId}`;
}

/**
 * Build the mppx guard.
 *
 * options.fetchWithPayment     Payment-capable fetch that pays the checking fee (mppx.fetch or an
 *                              x402 fetch). Required.
 * options.trustedLogVkey       Pinned C2SP Ed25519 log key from trusted configuration. Required.
 * options.maxCallAmountAtomic  Per-call cap in atomic USDC (string) or (challenge) => string.
 *                              Required unless limitsFor or requestFor is supplied.
 * options.limitsFor            Optional (challenge, url) => buyer_limits | null, replacing defaultLimits.
 * options.requestFor           Optional (context) => request body, replacing defaultRequest.
 * options.urlFor               Optional (challenge) => url when no challenge.received observer ran.
 * options.router               Check endpoint. Default https://402signal.com/route.
 * options.onMiss               "abort" (default) or "allow" when 402Signal reports no qualifying offer.
 * options.onUnsupported        "abort" (default) or "allow" for challenges the router cannot observe.
 * options.replayKey            Optional (context) => 64 lowercase hex chars, sent as Replay-Key.
 * options.onResult             Optional (result) => void with the raw check text and outcome.
 * options.now                  Optional Unix-seconds clock override for tests.
 */
export function mppGuard(options = {}) {
  const {
    fetchWithPayment,
    trustedLogVkey,
    maxCallAmountAtomic,
    limitsFor,
    requestFor,
    urlFor,
    router = DEFAULT_ROUTER,
    onMiss = "abort",
    onUnsupported = "abort",
    replayKey,
    onResult,
    now,
  } = options;
  if (typeof fetchWithPayment !== "function") {
    throw new TypeError("mppGuard: fetchWithPayment (a payment-capable fetch) is required");
  }
  if (typeof trustedLogVkey !== "string" || trustedLogVkey.length === 0) {
    throw new TypeError("mppGuard: trustedLogVkey from trusted configuration is required");
  }
  if (typeof limitsFor !== "function" && typeof requestFor !== "function") {
    const cap = typeof maxCallAmountAtomic === "function" ? "1" : String(maxCallAmountAtomic ?? "");
    if (!/^[1-9][0-9]*$/.test(cap)) {
      throw new TypeError("mppGuard: maxCallAmountAtomic (atomic USDC, e.g. \"1000\") is required");
    }
  }
  for (const [name, value] of [["onMiss", onMiss], ["onUnsupported", onUnsupported]]) {
    if (value !== "abort" && value !== "allow") throw new TypeError(`mppGuard: ${name} must be "abort" or "allow"`);
  }
  const routerUrl = new URL(router);
  if (routerUrl.protocol !== "https:" && routerUrl.hostname !== "127.0.0.1" && routerUrl.hostname !== "localhost") {
    throw new TypeError("mppGuard: router must be an https URL");
  }

  const remembered = new Map();
  function remember(id, record) {
    if (typeof id !== "string" || id.length === 0) return;
    remembered.delete(id);
    remembered.set(id, record);
    while (remembered.size > MAX_REMEMBERED) remembered.delete(remembered.keys().next().value);
  }

  /** mppx `challenge.received` observer: records the URL and raw challenge behind each challenge id. */
  function onChallengeReceived(event) {
    try {
      const challenge = event && event.challenge;
      const id = challenge && challenge.id;
      const url = requestUrl(event.input);
      remember(id, {
        url,
        status: event.response && typeof event.response.status === "number" ? event.response.status : null,
        wwwAuthenticate: headerValue(event.response, "www-authenticate"),
      });
    } catch {
      // Observers never influence payment handling; a missing URL surfaces in onChallenge.
    }
    return undefined;
  }

  /** Run the check for one URL and live challenge. Resolves with the outcome or throws MppGuardError. */
  async function check(url, challenge, seen = null) {
    const exactUrl = requestUrl(url);
    const context = { url: exactUrl, challenge, raw: seen };
    const limits = limitsFor ? limitsFor(challenge, exactUrl)
      : defaultLimits(challenge, typeof maxCallAmountAtomic === "function" ? maxCallAmountAtomic(challenge) : maxCallAmountAtomic);
    if (!limits && !requestFor) {
      const terms = challengeTerms(challenge) || {};
      const detail = `${terms.method || "?"}.${terms.intent || "?"} on chain ${terms.chainId ?? "?"}`;
      if (onUnsupported === "allow") return { status: null, text: null, body: null, verified: null, skipped: `unsupported (${detail})`, aborted: null };
      throw new MppGuardError("mpp_guard_unsupported_challenge", detail);
    }
    const request = requestFor ? requestFor({ ...context, limits }) : defaultRequest(exactUrl, limits);
    const routeRequestJson = JSON.stringify(request);
    const headers = { "content-type": "application/json", accept: "application/json" };
    if (replayKey) {
      const key = replayKey(context);
      if (typeof key === "string" && /^[0-9a-f]{64}$/.test(key)) headers["replay-key"] = key;
    }

    let response;
    let text;
    try {
      response = await fetchWithPayment(routerUrl.href, { method: "POST", headers, body: routeRequestJson, redirect: "error" });
      text = await response.text();
    } catch (error) {
      throw new MppGuardError("mpp_guard_check_failed", (error && error.message) || "network error");
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new MppGuardError("mpp_guard_check_failed", "invalid JSON from the check endpoint");
    }
    const outcome = { status: response.status, text, body, verified: null, skipped: null, aborted: null };

    if (response.status !== 200 || !isObject(body) || body.live !== true) {
      const reason = (isObject(body) && (body.binding_error || body.miss_reason || body.error)) || `http ${response.status}`;
      if (onMiss === "allow") {
        outcome.skipped = `miss (${reason})`;
        if (onResult) onResult(outcome);
        return outcome;
      }
      outcome.aborted = `no qualifying offer (${reason})`;
      if (onResult) onResult(outcome);
      throw new MppGuardError("mpp_guard_no_qualifying_offer", String(reason));
    }

    try {
      const bound = isObject(body.batch_binding) ? body.batch_binding.challenge : undefined;
      outcome.verified = verifyBatchRoute({
        routeResponseJson: text,
        routeRequestJson,
        trustedLogVkey,
        challenge: bound,
        ...(now === undefined ? {} : { now: typeof now === "function" ? now() : now }),
      });
    } catch (error) {
      // batch.mjs raises its own RouteGuardError class; read the typed code from any
      // guard error rather than testing one module's class (security review F4).
      const code = error && typeof error.code === "string" && error.code ? error.code : "verification_failed";
      outcome.aborted = `receipt verification failed (${code})`;
      if (onResult) onResult(outcome);
      throw new MppGuardError("mpp_guard_verification_failed", code);
    }
    if (outcome.verified.request.url !== exactUrl) {
      outcome.aborted = "verified observation is for a different url";
      if (onResult) onResult(outcome);
      throw new MppGuardError("mpp_guard_verification_failed", "url_mismatch");
    }
    if (!sameTerms(outcome.verified.terms, challenge)) {
      outcome.aborted = "live challenge differs from the verified terms";
      if (onResult) onResult(outcome);
      throw new MppGuardError("mpp_guard_terms_changed");
    }
    if (onResult) onResult(outcome);
    return outcome;
  }

  /** mppx `onChallenge` hook: returns undefined to let mppx create the credential, throws to abort. */
  async function onChallenge(challenge) {
    const id = isObject(challenge) ? challenge.id : undefined;
    const seen = typeof id === "string" ? remembered.get(id) : undefined;
    let url = seen ? seen.url : undefined;
    if (!url && typeof urlFor === "function") url = urlFor(challenge);
    if (typeof url !== "string" || url.length === 0) {
      throw new MppGuardError("mpp_guard_url_unknown", "register guard.onChallengeReceived with mppx.onChallengeReceived or pass urlFor");
    }
    // The buyer is paying 402Signal's own checking fee. Let it through; a check
    // of the checker would recurse forever.
    if (new URL(url).origin === routerUrl.origin) return undefined;
    await check(url, challenge, seen || null);
    return undefined;
  }

  return { onChallengeReceived, onChallenge, check };
}
