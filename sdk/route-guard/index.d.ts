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
/** Published checking-fee shapes by atomic amount: "3000" the check, "5000" a hosted session open, "0" hops and typed session misses. */
export const FEE_SHAPES: Readonly<Record<"3000" | "5000" | "0", string>>;
/** True when a success_only_v1 billing block names one of FEE_SHAPES on a fee rail (or $0.000 with rail "unknown"). */
export function isKnownFeeShape(billing: unknown): boolean;
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

/** Slim /route compared[] row. Additive; the verifier does not require these fields. */
export type ComparedExcludedReason =
  | "payTo_pending"
  | "payTo_changed"
  | "constraints_unmet"
  | "incomplete_payment"
  | "not_cheapest_comparable"
  | "ranked_below_winner"
  | "binding_unavailable";
export interface ComparedRow {
  url?: string | null;
  selected?: boolean;
  selectable?: boolean;
  payTo_pending?: boolean;
  payTo_changed?: boolean;
  risk?: string[];
  excluded_reason?: ComparedExcludedReason | null;
}

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
