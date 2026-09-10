/** Default exact authorize wrap for an existing wallet / pay-fetch / MCP signer.
 *
 * Observe → bind → local verify → only then the caller's seller callback.
 * Fail closed. No unguarded fallback. Not a marketplace, wallet, or chk_grp demo.
 * Imports the installed @402signal/route-guard package (published 0.7.2).
 */
import { isUnsettledRouteMiss, withVerifiedRoute } from "@402signal/route-guard";

const LIMIT = 262144;

export class ExactAuthorizeError extends Error {
  constructor(code) {
    super(code);
    this.name = "ExactAuthorizeError";
    this.code = code;
  }
}

function fail(code) {
  throw new ExactAuthorizeError(code);
}

export function parseExactAuthorizeRequest(requestJson) {
  if (typeof requestJson !== "string" || requestJson.length < 2 || requestJson.length > LIMIT) {
    fail("invalid_route_request");
  }
  let body;
  try {
    body = JSON.parse(requestJson);
  } catch {
    fail("invalid_route_request");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("invalid_route_request");
  if (body.require_route_binding !== true) fail("require_route_binding");
  if (Object.hasOwn(body, "buyer_limits") || Object.hasOwn(body, "merchant_profile")) {
    fail("exact_path_only");
  }
  if (body.job != null || body.codec != null) fail("exact_path_only");
  if (typeof body.url !== "string") fail("exact_url_required");
  let url;
  try {
    url = new URL(body.url);
  } catch {
    fail("unsupported_resource");
  }
  if (
    !body.url.startsWith("https://") ||
    url.protocol !== "https:" ||
    url.username ||
    url.password
  ) {
    fail("unsupported_resource");
  }
  const method = body.method == null ? "GET" : body.method;
  if (method !== "GET" && method !== "POST") fail("unsupported_resource");
  const rawBody = body.body;
  const bytes = rawBody == null
    ? new Uint8Array()
    : rawBody instanceof Uint8Array
      ? rawBody
      : fail("unsupported_resource");
  if (method === "GET" && bytes.length) fail("unsupported_resource");
  return { url: body.url, method, body: bytes };
}

function routeOutcome(response) {
  if (!response || typeof response.bodyText !== "string") return null;
  try {
    const body = JSON.parse(response.bodyText);
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const taught = body.route_outcome && typeof body.route_outcome === "object"
      ? body.route_outcome
      : null;
    return { body, taught };
  } catch {
    return null;
  }
}

function teach(outcome) {
  const response = outcome?.response;
  if (!response) return null;
  const parsed = routeOutcome(response);
  // Prefer the bind reason when a 503 carries both unsettled-miss markers and
  // binding_error=route_binding_unavailable. Embedders branch on state.
  if (parsed?.body?.binding_error === "route_binding_unavailable") {
    return Object.freeze({
      state: "binding_unavailable",
      keep_calling_route: true,
      binding_error_reason: parsed.body.binding_error_reason ?? null,
      next_action: parsed.taught?.next_action || "fix_request_or_compatibility",
      note: "policy working; not a broken router",
      outcome,
    });
  }
  const miss = isUnsettledRouteMiss({
    httpStatus: response.status,
    routeResponseJson: response.bodyText,
    paymentResponseHeader: response.paymentResponse,
  });
  if (miss) {
    return Object.freeze({
      state: "miss",
      keep_calling_route: true,
      miss_reason: parsed?.body?.miss_reason ?? null,
      next_action: parsed?.taught?.next_action || "change_constraints",
      note: "policy working; not a broken router",
      outcome,
    });
  }
  return null;
}

async function defaultSellerChallenge(request) {
  const init = {
    method: request.method,
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  };
  if (request.method === "POST") init.body = request.body;
  const response = await fetch(request.url, init);
  if (response.redirected || response.status !== 402) fail("seller_challenge_unavailable");
  const chunks = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > LIMIT) fail("seller_challenge_too_large");
        chunks.push(item.value);
      }
    } catch (error) {
      await reader.cancel();
      throw error;
    }
  }
  const bodyText = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  return {
    status: response.status,
    bodyText,
    paymentRequired: response.headers.get("PAYMENT-REQUIRED") ?? undefined,
    xPaymentRequired: response.headers.get("X-PAYMENT-REQUIRED") ?? undefined,
  };
}

/** Wrap existing signRouting / signSeller. Same call on the next spend. */
export async function wrapExactAuthorize(options) {
  if (!options || typeof options !== "object") fail("invalid_options");
  const {
    id,
    requestJson,
    client,
    trustedLogVkey,
    signRouting,
    signSeller,
    confirmRouting,
    fetchSellerChallenge,
  } = options;
  if (typeof id !== "string" || typeof requestJson !== "string") fail("invalid_options");
  if (!client || typeof client.prepare !== "function") fail("invalid_options");
  if (typeof trustedLogVkey !== "string" || !trustedLogVkey) fail("invalid_options");
  if (typeof signRouting !== "function" || typeof signSeller !== "function") fail("invalid_options");
  const request = parseExactAuthorizeRequest(requestJson);
  await client.prepare(id, requestJson);
  const challenge = await client.challenge(id);
  if (!challenge || challenge.status !== 402) fail("routing_challenge_unavailable");
  await client.setPaymentHeader(id, { value: await signRouting(challenge) });
  const outcome = await client.submit(id);
  const taught = teach(outcome);
  if (taught) return taught;
  if (outcome?.response?.status !== 200 || outcome.classification?.settlementReport !== "settled") {
    return Object.freeze({
      state: "unresolved",
      keep_calling_route: true,
      next_action: "reconcile_existing_payment",
      note: "uncertain routing outcome; do not send a new payment identity",
      outcome,
    });
  }
  if (typeof confirmRouting === "function" && !await confirmRouting(outcome)) {
    return Object.freeze({
      state: "routing_confirmation_unknown",
      keep_calling_route: false,
      next_action: "reconcile_existing_payment",
      outcome,
    });
  }
  const sellerChallenge = await (typeof fetchSellerChallenge === "function"
    ? fetchSellerChallenge(request)
    : defaultSellerChallenge(request));
  const sellerResult = await withVerifiedRoute(
    {
      routeResponseJson: outcome.response.bodyText,
      routeRequestJson: requestJson,
      trustedLogVkey,
      request: { url: request.url, method: request.method, body: request.body },
      challenge: sellerChallenge,
    },
    (verified) => signSeller(verified, sellerChallenge),
  );
  return Object.freeze({
    state: "authorized",
    keep_calling_route: true,
    next_action: "none",
    sellerResult,
    outcome,
  });
}
