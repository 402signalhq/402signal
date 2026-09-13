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
// verified offer matches the requirements the client selected. 402Signal's
// own fee challenge is allowed through without a check, so the hook never
// recurses.
//
// Zero dependencies. Never holds keys, never signs, never retries.

import { RouteGuardError, verifyRoute } from "./index.mjs";

export const DEFAULT_ROUTER = "https://402signal.com/route";

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

/**
 * Fetch the seller's current unpaid challenge with a plain fetch: same URL and
 * method the check observed, redirects refused, both channels captured.
 */
export async function fetchChallenge(rawFetch, url, method = "GET") {
  const response = await rawFetch(url, {
    method,
    headers: { accept: "application/json" },
    redirect: "error",
  });
  const bodyText = await response.text();
  return {
    status: response.status,
    bodyText,
    paymentRequired: headerValue(response, "payment-required"),
    xPaymentRequired: headerValue(response, "x-payment-required"),
  };
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
 *                           check observes GET; default "GET".
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
    method = "GET",
    onMiss = "abort",
    replayKey,
    onResult,
    now,
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
  if (onMiss !== "abort" && onMiss !== "allow") {
    throw new TypeError("signalGuard: onMiss must be \"abort\" or \"allow\"");
  }
  const routerUrl = new URL(router);
  if (routerUrl.protocol !== "https:" && routerUrl.hostname !== "127.0.0.1" && routerUrl.hostname !== "localhost") {
    throw new TypeError("signalGuard: router must be an https URL");
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
    // The buyer is paying 402Signal's own checking fee. Let it through; a check
    // of the checker would recurse forever.
    if (target.origin === routerUrl.origin) return undefined;
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
      challenge = challengeFor ? await challengeFor(context) : await fetchChallenge(rawFetch, target.href, method);
    } catch (error) {
      outcome.aborted = `402signal: seller challenge unavailable (${(error && error.message) || "network error"})`;
      if (onResult) onResult(outcome);
      return abort(outcome.aborted);
    }

    try {
      const verified = verifyRoute({
        routeResponseJson: text,
        routeRequestJson,
        trustedLogVkey,
        request: { url: target.href, method },
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
