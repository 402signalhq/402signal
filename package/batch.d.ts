/** Offline observation proof only; does not authorize funding, signing or settlement. */
export interface BatchChallenge {
  status: 402;
  bodyText: string;
  paymentRequired: string | null;
  wwwAuthenticate: string | null;
}
export interface BatchRouteOptions {
  routeResponseJson: string;
  routeRequestJson: string;
  trustedLogVkey: string;
  challenge: BatchChallenge;
  now?: number;
}
export interface BatchObservation {
  model: "proof_carrying_batch_observation_v1";
  profile:
    | "algorand-mpp-charge-v1"
    | "base-mpp-charge-v1"
    | "base-x402-batch-v1"
    | "solana-mpp-session-v1"
    | "algorand-atomic-batch-v1"
    | "algorand-atomic-two-item-v1"
    | "algorand-atomic-multi-item-v1"
    | "algorand-aggregate-invoice-v1";
  request: { url: string; method: "GET"; body_sha256: string };
  buyer_limits: Record<string, string | number | string[] | null>;
  challenge: BatchChallenge;
  challenge_sha256: string;
  terms: Record<string, unknown>;
  observed_at: number;
  expires_at: number;
}
export class RouteGuardError extends Error {
  readonly code: string;
}
export function verifyBatchRoute(options: BatchRouteOptions): BatchObservation;
export function withVerifiedBatchRoute<T>(
  options: BatchRouteOptions,
  callback: (observation: BatchObservation) => T | Promise<T>,
): Promise<T>;
