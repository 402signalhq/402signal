import {
  type GuardOptions,
  type VerifiedAction,
  verifyRoute,
  withVerifiedRoute,
} from "@402signal/route-guard";
import {
  DEFAULT_CHALLENGE_TIMEOUT_MS,
  DEFAULT_FEE_RECIPIENTS,
  DEFAULT_FEE_TERMS,
  DEFAULT_MAX_FEE_ATOMIC,
  MAX_CHALLENGE_BYTES,
  fetchChallenge,
  type RawChallenge,
  type SignalGuardOptions,
  signalGuard,
  type X402BeforePaymentCreationHook,
} from "@402signal/route-guard/x402";

const options: GuardOptions = {
  routeResponseJson: "{}",
  routeRequestJson: "{}",
  trustedLogVkey: "configured-pin",
  request: { url: "https://example.com/api", method: "GET" },
  challenge: { status: 402, bodyText: "{}" },
};
const action: VerifiedAction = verifyRoute(options);
const synchronous: string = withVerifiedRoute(options, (terms) => terms.model);
const asynchronous: Promise<string> = withVerifiedRoute(
  options,
  async (terms) => terms.request.url,
);
void synchronous;
void asynchronous;
// @ts-expect-error The selected terms must not be mutated after verification.
action.accepted.payTo = "other";
// @ts-expect-error The request must not be mutated after verification.
action.request.method = "POST";
// @ts-expect-error DELETE is outside the supported observed request profile.
options.request.method = "DELETE";

// The x402 hook: a typed POST consumer needs no cast for the body callback or the bounds.
const guardOptions: SignalGuardOptions = {
  fetchWithPayment: async (input, init) => globalThis.fetch(input, init),
  trustedLogVkey: "configured-pin",
  method: "POST",
  challengeFor: async () => ({ status: 402, bodyText: "{}" }),
  requestFor: () => ({ url: "https://example.com/api", require_route_binding: true }),
  bodyFor: () => new TextEncoder().encode('{"q":"x"}'),
  feeRecipients: DEFAULT_FEE_RECIPIENTS,
  maxFeeAtomic: DEFAULT_MAX_FEE_ATOMIC,
  feeTerms: DEFAULT_FEE_TERMS,
  maxChallengeBytes: MAX_CHALLENGE_BYTES,
  challengeTimeoutMs: DEFAULT_CHALLENGE_TIMEOUT_MS,
};
const hook: X402BeforePaymentCreationHook = signalGuard(guardOptions);
const bounded: Promise<RawChallenge> = fetchChallenge(globalThis.fetch, "https://example.com/api", "GET", {
  maxBytes: 4096,
  timeoutMs: 1000,
});
void hook;
void bounded;
// @ts-expect-error The fee cap is an atomic amount string, never a number.
guardOptions.maxFeeAtomic = 5000;
