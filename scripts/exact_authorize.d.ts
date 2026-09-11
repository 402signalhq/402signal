import type { RouteClient, RouteResponse, RouteResult } from "@402signal/route-guard/client";
import type { VerifiedAction } from "@402signal/route-guard";

export class ExactAuthorizeError extends Error {
  readonly code: string;
}

export function parseExactAuthorizeRequest(requestJson: string): {
  url: string;
  method: "GET" | "POST";
  body: Uint8Array;
};

export interface ExactAuthorizeOptions {
  id: string;
  requestJson: string;
  client: RouteClient;
  trustedLogVkey: string;
  /** Existing routing-fee signer. The wrap does not replace the wallet. */
  signRouting: (challenge: RouteResponse) => Promise<string> | string;
  /** Existing seller signer. Invoked only after local verification. */
  signSeller: (
    verified: VerifiedAction,
    challenge: {
      status: number;
      bodyText?: string;
      paymentRequired?: string;
      xPaymentRequired?: string;
    },
  ) => unknown;
  confirmRouting?: (outcome: RouteResult) => Promise<boolean> | boolean;
  fetchSellerChallenge?: (request: {
    url: string;
    method: "GET" | "POST";
    body: Uint8Array;
  }) => Promise<{
    status: number;
    bodyText?: string;
    paymentRequired?: string;
    xPaymentRequired?: string;
  }>;
}

export type ExactAuthorizeResult = Readonly<{
  state: "authorized" | "miss" | "binding_unavailable" | "unresolved" | "routing_confirmation_unknown";
  keep_calling_route: boolean;
  next_action?: string;
  miss_reason?: string | null;
  binding_error_reason?: string | null;
  note?: string;
  sellerResult?: unknown;
  outcome?: RouteResult;
}>;

/** Wrap existing signRouting / signSeller. Same call on the next spend, including session=open. Hops do not wrap. */
export function wrapExactAuthorize(options: ExactAuthorizeOptions): Promise<ExactAuthorizeResult>;
