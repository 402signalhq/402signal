import type { VerifiedAction } from "./index";

/** Minimal shape of @x402/core's PaymentRequirements. */
export interface X402PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

/** Minimal shape of @x402/core's PaymentRequired (the seller's 402 body). */
export interface X402PaymentRequired {
  x402Version: number;
  error?: string;
  resource: { url: string; description?: string; mimeType?: string };
  accepts: X402PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

/** The context @x402/core passes to onBeforePaymentCreation hooks. */
export interface X402PaymentCreationContext {
  paymentRequired: X402PaymentRequired;
  selectedRequirements: X402PaymentRequirements;
}

export type X402BeforePaymentCreationHook = (
  context: X402PaymentCreationContext,
) => Promise<void | { abort: true; reason: string }>;

export interface SignalGuardResult {
  status: number;
  /** Raw check response text. Retain it with the request for later verification. */
  text: string;
  body: unknown;
  verified: VerifiedAction | null;
  aborted: string | null;
}

export interface RawChallenge {
  status: number;
  bodyText?: string;
  paymentRequired?: string;
  xPaymentRequired?: string;
}

export interface SignalGuardOptions {
  /** The buyer's payment-capable fetch; it pays the $0.003 checking fee. */
  fetchWithPayment: (input: string, init: RequestInit) => Promise<Response>;
  /** Pinned C2SP Ed25519 log verification key from trusted configuration. */
  trustedLogVkey: string;
  /** Check endpoint. Default https://402signal.com/route. */
  router?: string;
  /** Plain fetch (no payment middleware) that re-reads the seller's unpaid challenge. Default globalThis.fetch. */
  rawFetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Supply the raw challenge the buyer already holds instead of re-reading it. */
  challengeFor?: (context: X402PaymentCreationContext) => RawChallenge | Promise<RawChallenge>;
  /** Replace the default { url, require_route_binding: true, networks } request. */
  requestFor?: (context: X402PaymentCreationContext) => Record<string, unknown>;
  /** Method the buyer uses for the seller request. The hosted check observes GET. */
  method?: "GET" | "POST";
  /** Behaviour when 402Signal reports no qualifying live offer. Default "abort". */
  onMiss?: "abort" | "allow";
  /** Optional private Replay-Key (64 lowercase hex) for lost-response recovery. */
  replayKey?: (context: X402PaymentCreationContext) => string;
  /** Called with every check outcome for retention or logging. */
  onResult?: (result: SignalGuardResult) => void;
  /** Unix-seconds clock override for deterministic tests. */
  now?: number | (() => number);
}

export const DEFAULT_ROUTER: string;
export function sameTerms(accepted: unknown, selected: unknown): boolean;
export function defaultRequest(
  resourceUrl: string,
  selected: X402PaymentRequirements | undefined,
  extra?: Record<string, unknown>,
): Record<string, unknown>;
export function fetchChallenge(
  rawFetch: (input: string, init: RequestInit) => Promise<Response>,
  url: string,
  method?: "GET" | "POST",
): Promise<RawChallenge>;
export function signalGuard(options: SignalGuardOptions): X402BeforePaymentCreationHook;
