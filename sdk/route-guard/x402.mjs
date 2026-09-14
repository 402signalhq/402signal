// 402Signal policy hook for the official x402 client (@x402/core >= 2).
//
//   import { x402Client } from "@x402/core/client";
//   import { wrapFetchWithPayment } from "@x402/fetch";
//   import { signalGuard } from "@402signal/route-guard/x402";
//
//   const client = new x402Client();
//   client.register("eip155:*", new ExactEvmScheme(signer));
//   const fetchWithPayment = wrapFetchWithPayment(fetch, client);
//   client.onBeforePaymentCreation(signalGuard({ fetchWithPayment, trustedLogVkey }));
//
// Before the client signs a seller payment, the hook asks 402Signal to check
// the same endpoint (paying the $0.003 checking fee with the buyer's own
// wallet through fetchWithPayment), fetches the seller's raw unpaid challenge
// once more with a plain fetch, verifies the signed receipt locally against
// that challenge with the pinned log key, and aborts the payment unless the
// verified offer matches the requirements the client selected. The hook's own
// checking-fee payment is let through without a check so it never recurses,
// but only while that check request is in flight, only for the exact check
// URL, only on 402Signal's published fee terms (exact scheme, USDC on a fee
// rail) to one of its fee recipients, and at most the fee amount: a seller
// cannot earn the exemption by naming the router in its challenge, and a
// challenge that claims the router's origin outside those bounds is refused
// outright.
//
// Zero dependencies. Never holds keys, never signs, never retries.

import { RouteGuardError, verifyRoute } from "./index.mjs";

export const DEFAULT_ROUTER = "https://402signal.com/route";

/**
 * 402Signal's checking-fee recipients (GET /rails), one per fee rail. The
 * recursion exemption is granted only to a payment that goes to one of these.
 * A rotation ships with a package release; pass feeRecipients from trusted
 * configuration to override.
 */
export const DEFAULT_FEE_RECIPIENTS = Object.freeze([
  "0xa2604ae688228af8349363770351bfcec66d4fa0", // base
  "C8qDYG8NTyvdY85gvGfs1WajwGhiLu6f1vi3JaG1r1iA", // solana
  "N2JSJZCSORMYGYO2NSIYRUEMBFRHEOMYODVXV2MXYYHB5H2JVUGG6NJ4NQ", // algorand
]);
/** $0.005 USDC: a hosted session open. A check is 3000. */
export const DEFAULT_MAX_FEE_ATOMIC = "5000";
/**
 * 402Signal's checking-fee terms (GET /rails) by CAIP-2 network: the exact
 * scheme and the USDC asset of each fee rail. The recursion exemption is
 * granted only to a payment on these terms; pass feeTerms from trusted
 * configuration to override.
 */
export const DEFAULT_FEE_TERMS = Object.freeze({
  "eip155:8453": Object.freeze({ scheme: "exact", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }), // base USDC
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": Object.freeze({ scheme: "exact", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }), // solana USDC
  "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=": Object.freeze({ scheme: "exact", asset: "31566704" }), // algorand USDC
});
/** The raw seller challenge the verifier accepts is at most 64 KiB; reading stops there. */
export const MAX_CHALLENGE_BYTES = 64 * 1024;
export const DEFAULT_CHALLENGE_TIMEOUT_MS = 10000;

const RAIL_BY_PREFIX = [
  ["eip155:", "base"],
  ["solana:", "solana"],
  ["algorand:", "algorand"],
];

function abort(reason) {
  return { abort: true, reason };
}

function railOf(network) {
  const text = typeof network === "string" ? network : "";
  for (const [prefix, rail] of RAIL_BY_PREFIX) {
    if (text.startsWith(prefix)) return rail;
  }
  return null;
}

function normalizeAddress(value, network) {
  const text = String(value ?? "");
  return typeof network === "string" && network.startsWith("eip155:") ? text.toLowerCase() : text;
}

function headerValue(response, name) {
  try {
    const value = response && response.headers && typeof response.headers.get === "function"
      ? response.headers.get(name)
      : null;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** True when the requirements the client selected are the terms 402Signal verified. */
export function sameTerms(accepted, selected) {
  if (!accepted || typeof accepted !== "object" || !selected || typeof selected !== "object") return false;
  for (const key of ["scheme", "network", "asset", "amount"]) {
    if (String(accepted[key] ?? "") !== String(selected[key] ?? "")) return false;
  }
  return normalizeAddress(accepted.payTo, accepted.network) === normalizeAddress(selected.payTo, selected.network);
}

/** Default check request: the exact resource URL, bound evidence, the selected rail only. */
export function defaultRequest(resourceUrl, selected, extra = {}) {
  const request = { url: resourceUrl, require_route_binding: true };
  const rail = railOf(selected && selected.network);
  if (rail) request.networks = [rail];
  return { ...request, ...extra };
}

function decodeJoined(chunks, total) {
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(joined);
}

async function readBounded(response, maxBytes, controller) {
  const body = response && response.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        const error = new RouteGuardError("challenge_too_large");
        try {
          await reader.cancel(error);
        } catch {
          // the stream is being abandoned either way
        }
        controller.abort(error);
        throw error;
      }
      chunks.push(value);
    }
    return decodeJoined(chunks, total);
  }
  if (body && typeof body[Symbol.asyncIterator] === "function") {
    // A Node readable (node-fetch style adapters): the same metered loop.
    const chunks = [];
    let total = 0;
    for await (const piece of body) {
      const chunk = typeof piece === "string"
        ? new TextEncoder().encode(piece)
        : piece instanceof Uint8Array ? piece : new Uint8Array(piece);
      total += chunk.byteLength;
      if (total > maxBytes) {
        const error = new RouteGuardError("challenge_too_large");
        if (typeof body.destroy === "function") body.destroy(error);
        controller.abort(error);
        throw error;
      }
      chunks.push(chunk);
    }
    return decodeJoined(chunks, total);
  }
  // Nothing to meter: an adapter that only offers text() is read when the
  // transport declares a length within the bound; otherwise it could hand back
  // an unbounded string and the guard fails closed instead.
  const declared = headerValue(response, "content-length");
  if (declared === undefined || !/^[0-9]{1,15}$/.test(declared)) {
    throw new RouteGuardError("challenge_unbounded_transport");
  }
  if (Number(declared) > maxBytes) throw new RouteGuardError("challenge_too_large");
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new RouteGuardError("challenge_too_large");
  return text;
}

/**
 * Fetch the seller's current unpaid challenge with a plain fetch: same URL and
 * method the check observed, redirects refused, both channels captured.
 *
 * The seller controls this response, so the read is bounded before anything is
 * parsed: at most maxBytes (default 64 KiB, the verifier's own cap) and at most
 * timeoutMs (default 10 s) end to end, with the caller's AbortSignal forwarded.
 * Over either bound the read fails closed with RouteGuardError
 * challenge_too_large or challenge_timeout, and the stream is cancelled. Web
 * streams and Node readables are metered as they arrive; a response that
 * offers neither is read only when it declares a Content-Length within the
 * bound, else challenge_unbounded_transport.
 */
export async function fetchChallenge(rawFetch, url, method = "GET", options = {}) {
  const { maxBytes = MAX_CHALLENGE_BYTES, timeoutMs = DEFAULT_CHALLENGE_TIMEOUT_MS, signal } = options;
  const controller = new AbortController();
  const aborted = new Promise((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  aborted.catch(() => {});
  // A strong timer on purpose: when a stalled seller response is the only thing
  // pending, the deadline must still fire (an unref'd timer let the loop drain and
  // left the read hanging, which is how the 0.7.5 publish test failed).
  const timer = setTimeout(() => controller.abort(new RouteGuardError("challenge_timeout")), timeoutMs);
  const forward = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) forward();
    else signal.addEventListener("abort", forward, { once: true });
  }
  try {
    const response = await Promise.race([
      rawFetch(url, {
        method,
        headers: { accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      }),
      aborted,
    ]);
    const bodyText = await Promise.race([readBounded(response, maxBytes, controller), aborted]);
    return {
      status: response.status,
      bodyText,
      paymentRequired: headerValue(response, "payment-required"),
      xPaymentRequired: headerValue(response, "x-payment-required"),
    };
  } catch (error) {
    const reason = controller.signal.aborted ? controller.signal.reason : undefined;
    throw reason instanceof RouteGuardError ? reason : error;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", forward);
  }
}

/**
 * Build an onBeforePaymentCreation hook for x402Client.
 *
 * options.fetchWithPayment  The buyer's payment-capable fetch (wrapFetchWithPayment).
 *                           It pays the 402Signal checking fee with the buyer's wallet.
 * options.trustedLogVkey    Pinned C2SP Ed25519 log key from trusted configuration,
 *                           never taken from a response.
 * options.router            402Signal check endpoint. Default https://402signal.com/route.
 * options.rawFetch          Plain fetch (no payment middleware) used to re-read the
 *                           seller's unpaid challenge for local verification.
 *                           Default globalThis.fetch.
 * options.challengeFor      Optional async (context) => { status, bodyText,
 *                           paymentRequired?, xPaymentRequired? } supplying the raw
 *                           challenge the buyer already holds, instead of rawFetch.
 * options.requestFor        Optional (context) => request body object, replacing the
 *                           default { url, require_route_binding: true, networks }.
 *                           Add max_price_usd or other constraints here.
 * options.method            Method the buyer uses for the seller request. The hosted
 *                           check observes GET; default "GET". POST is accepted only
 *                           with challengeFor, requestFor and bodyFor, because the
 *                           built-in reread sends no body and the receipt binds the
 *                           exact body bytes.
 * options.bodyFor           Optional (context) => Uint8Array | string, the exact body
 *                           the buyer sends; bound into the verification. Required
 *                           for POST.
 * options.feeRecipients     402Signal fee recipients the recursion exemption may pay
 *                           (default DEFAULT_FEE_RECIPIENTS; see GET /rails).
 * options.maxFeeAtomic      Largest atomic amount the exemption may pay (default
 *                           DEFAULT_MAX_FEE_ATOMIC, a session open).
 * options.feeTerms          Fee terms by CAIP-2 network, { scheme, asset } each
 *                           (default DEFAULT_FEE_TERMS; see GET /rails). The
 *                           exemption never pays another scheme, network or asset.
 * options.maxChallengeBytes, options.challengeTimeoutMs
 *                           Bounds for the built-in seller reread (64 KiB, 10 s).
 * options.onMiss            "abort" (default) or "allow" when 402Signal reports no
 *                           qualifying live offer or cannot bind.
 * options.replayKey         Optional (context) => 64 lowercase hex chars, sent as
 *                           Replay-Key so a lost check response can be recovered.
 * options.onResult          Optional (result) => void, called with the raw check text,
 *                           parsed body and verification outcome for retention.
 * options.now               Optional Unix-seconds clock override for tests.
 */
export function signalGuard(options = {}) {
  const {
    fetchWithPayment,
    trustedLogVkey,
    router = DEFAULT_ROUTER,
    rawFetch = globalThis.fetch,
    challengeFor,
    requestFor,
    bodyFor,
    method = "GET",
    onMiss = "abort",
    replayKey,
    onResult,
    now,
    feeRecipients = DEFAULT_FEE_RECIPIENTS,
    maxFeeAtomic = DEFAULT_MAX_FEE_ATOMIC,
    feeTerms = DEFAULT_FEE_TERMS,
    maxChallengeBytes = MAX_CHALLENGE_BYTES,
    challengeTimeoutMs = DEFAULT_CHALLENGE_TIMEOUT_MS,
  } = options;
  if (typeof fetchWithPayment !== "function") {
    throw new TypeError("signalGuard: fetchWithPayment (a payment-capable fetch) is required");
  }
  if (typeof trustedLogVkey !== "string" || trustedLogVkey.length === 0) {
    throw new TypeError("signalGuard: trustedLogVkey from trusted configuration is required");
  }
  if (typeof rawFetch !== "function" && typeof challengeFor !== "function") {
    throw new TypeError("signalGuard: rawFetch or challengeFor is required to read the seller challenge");
  }
  if (method !== "GET" && method !== "POST") {
    throw new TypeError("signalGuard: method must be GET or POST");
  }
  if (method === "POST" && (typeof challengeFor !== "function" || typeof requestFor !== "function" || typeof bodyFor !== "function")) {
    throw new TypeError(
      "signalGuard: POST needs challengeFor, requestFor and bodyFor carrying the exact request body; the built-in reread sends none",
    );
  }
  if (onMiss !== "abort" && onMiss !== "allow") {
    throw new TypeError("signalGuard: onMiss must be \"abort\" or \"allow\"");
  }
  if (!Array.isArray(feeRecipients) || feeRecipients.length === 0 || !feeRecipients.every((r) => typeof r === "string" && r.length > 0)) {
    throw new TypeError("signalGuard: feeRecipients must be a non-empty list of recipient strings");
  }
  if (!/^[0-9]{1,30}$/.test(String(maxFeeAtomic))) {
    throw new TypeError("signalGuard: maxFeeAtomic must be an atomic amount string");
  }
  const feeTermEntries = feeTerms && typeof feeTerms === "object" ? Object.entries(feeTerms) : [];
  if (
    feeTermEntries.length === 0
    || !feeTermEntries.every(([network, terms]) => network.length > 0 && terms && typeof terms === "object"
      && typeof terms.scheme === "string" && terms.scheme.length > 0 && typeof terms.asset === "string" && terms.asset.length > 0)
  ) {
    throw new TypeError("signalGuard: feeTerms must map each fee network to { scheme, asset }");
  }
  const routerUrl = new URL(router);
  if (routerUrl.protocol !== "https:" && routerUrl.hostname !== "127.0.0.1" && routerUrl.hostname !== "localhost") {
    throw new TypeError("signalGuard: router must be an https URL");
  }
  const feeRecipientSet = new Set(feeRecipients.map((r) => (r.startsWith("0x") ? r.toLowerCase() : r)));
  const feeCap = BigInt(String(maxFeeAtomic));
  // Counts this hook's own check requests currently awaiting the router. The
  // recursion exemption exists only while one is in flight.
  let feeCallsInFlight = 0;

  function ownFeeChallenge(target, selected) {
    if (feeCallsInFlight === 0 || target.href !== routerUrl.href) return false;
    if (!selected || typeof selected !== "object" || typeof selected.network !== "string") return false;
    const terms = Object.prototype.hasOwnProperty.call(feeTerms, selected.network) ? feeTerms[selected.network] : undefined;
    if (!terms || String(selected.scheme ?? "") !== terms.scheme) return false;
    if (normalizeAddress(selected.asset, selected.network) !== normalizeAddress(terms.asset, selected.network)) return false;
    if (!feeRecipientSet.has(normalizeAddress(selected.payTo, selected.network))) return false;
    const amount = String(selected.amount ?? "");
    return /^[0-9]{1,30}$/.test(amount) && BigInt(amount) <= feeCap;
  }

  return async function beforePaymentCreation(context) {
    const paymentRequired = context && context.paymentRequired;
    const selected = context && context.selectedRequirements;
    const resource = paymentRequired && paymentRequired.resource;
    let target;
    try {
      target = new URL(String(resource && resource.url));
    } catch {
      return abort("402signal: payment resource url is missing");
    }
    // The buyer is paying 402Signal's own checking fee for the check this hook
    // started: let it through, or a check of the checker would recurse forever.
    if (ownFeeChallenge(target, selected)) return undefined;
    // Anything else that claims the checker's origin is a seller trying to borrow
    // that exemption (the router does not check itself): refuse, whatever onMiss says.
    if (target.origin === routerUrl.origin) {
      return abort("402signal: seller challenge claims the checker's own url");
    }
    if (!selected || typeof selected !== "object") {
      return abort("402signal: no selected payment requirements");
    }

    const request = requestFor ? requestFor(context) : defaultRequest(target.href, selected);
    const routeRequestJson = JSON.stringify(request);
    const headers = { "content-type": "application/json", accept: "application/json" };
    if (replayKey) {
      const key = replayKey(context);
      if (typeof key === "string" && /^[0-9a-f]{64}$/.test(key)) headers["replay-key"] = key;
    }

    let response;
    let text;
    feeCallsInFlight += 1;
    try {
      response = await fetchWithPayment(routerUrl.href, {
        method: "POST",
        headers,
        body: routeRequestJson,
        redirect: "error",
      });
      text = await response.text();
    } catch (error) {
      return abort(`402signal: check request failed (${(error && error.message) || "network error"})`);
    } finally {
      feeCallsInFlight -= 1;
    }

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return abort("402signal: check returned invalid JSON");
    }
    const status = response.status;
    const outcome = { status, text, body, verified: null, aborted: null };

    if (status !== 200 || !body || body.live !== true) {
      const reason = (body && (body.binding_error || body.miss_reason || body.error)) || `http ${status}`;
      outcome.aborted = onMiss === "abort" ? `402signal: no qualifying offer (${reason})` : null;
      if (onResult) onResult(outcome);
      return outcome.aborted ? abort(outcome.aborted) : undefined;
    }

    let challenge;
    try {
      challenge = challengeFor
        ? await challengeFor(context)
        : await fetchChallenge(rawFetch, target.href, method, { maxBytes: maxChallengeBytes, timeoutMs: challengeTimeoutMs });
    } catch (error) {
      outcome.aborted = `402signal: seller challenge unavailable (${(error && error.message) || "network error"})`;
      if (onResult) onResult(outcome);
      return abort(outcome.aborted);
    }

    try {
      const requestContext = { url: target.href, method };
      if (bodyFor) {
        const body = bodyFor(context);
        requestContext.body = typeof body === "string" ? new TextEncoder().encode(body) : body;
      }
      const verified = verifyRoute({
        routeResponseJson: text,
        routeRequestJson,
        trustedLogVkey,
        request: requestContext,
        challenge,
        now: typeof now === "function" ? now() : now,
      });
      outcome.verified = verified;
      if (!sameTerms(verified.accepted, selected)) {
        outcome.aborted = "402signal: selected requirements differ from the verified offer";
      }
    } catch (error) {
      const code = error instanceof RouteGuardError ? error.code : "verification_failed";
      outcome.aborted = `402signal: receipt verification failed (${code})`;
    }
    if (onResult) onResult(outcome);
    return outcome.aborted ? abort(outcome.aborted) : undefined;
  };
}
