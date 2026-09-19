export interface GuardOptions {
  /** Exact response text from 402Signal; retain the complete receipt and reveal. */
  routeResponseJson: string;
  /** Actual request sent to /route, including require_route_binding: true. */
  routeRequestJson: string;
  /** Independently configured C2SP Ed25519 log verification key. */
  trustedLogVkey: string;
  request: { url: string; method: "GET" | "POST"; body?: Uint8Array };
  /** Actual seller HTTP response, no redirects. Supply both channels if present. */
  challenge: {
    status: number;
    bodyText?: string;
    paymentRequired?: string;
    xPaymentRequired?: string;
  };
  /** Trusted Unix-seconds clock override for deterministic tests. */
  now?: number;
}
export interface VerifiedAction {
  readonly model: "proof_carrying_route_v1";
  readonly request: Readonly<{
    url: string;
    method: "GET" | "POST";
    body_sha256: string;
  }>;
  readonly accepted: Readonly<Record<string, unknown>>;
  readonly expires_at: number;
  readonly quote_sha256: string;
}
export class RouteGuardError extends Error {
  readonly code: string;
}
export function verifyRoute(options: GuardOptions): VerifiedAction;
/** Explicit unpaid outcome only. Does not authorize a retry or release budget. */
export function isUnsettledRouteMiss(options: {
  httpStatus: number;
  routeResponseJson: string;
  /** Pass the result of headers.get("PAYMENT-RESPONSE"); null means absent. */
  paymentResponseHeader: string | null;
}): boolean;
export function withVerifiedRoute<T>(
  options: GuardOptions,
  authorize: (action: VerifiedAction) => T,
): T;

export interface ReceiptOptions {
  routeResponseJson: string;
  routeRequestJson: string;
  trustedLogVkey: string;
}
/** Historical signature/inclusion verification grants no spending authority. */
export function verifyReceipt(options: ReceiptOptions): Readonly<{
  proof: 'signature_and_inclusion_verified'; index: number; checkpoint_size: number;
  current_quote: 'not_checked'; payment_confirmation: 'not_checked';
  anchor: 'not_checked'; delivery: 'not_checked';
}>;
