import type { VerifiedAction } from "./index.d.ts";

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

/** 402Signal's checking-fee terms on one CAIP-2 network (GET /rails). */
export interface FeeTerms {
  scheme: string;
  asset: string;
}

/** Bounds for fetchChallenge, the built-in seller reread. */
export interface ChallengeReadOptions {
  /** Largest body accepted, in bytes. Default MAX_CHALLENGE_BYTES (64 KiB). */
  maxBytes?: number;
  /** End-to-end deadline. Default DEFAULT_CHALLENGE_TIMEOUT_MS (10 s). */
  timeoutMs?: number;
  /** Caller's signal, forwarded to the fetch and the read. */
  signal?: AbortSignal;
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
  /** The exact body the buyer sends; bound into the verification. Required with method "POST". */
  bodyFor?: (context: X402PaymentCreationContext) => Uint8Array | string;
  /** Behaviour when 402Signal reports no qualifying live offer. Default "abort". */
  onMiss?: "abort" | "allow";
  /** Optional private Replay-Key (64 lowercase hex) for lost-response recovery. */
  replayKey?: (context: X402PaymentCreationContext) => string;
  /** Called with every check outcome for retention or logging. */
  onResult?: (result: SignalGuardResult) => void;
  /** Unix-seconds clock override for deterministic tests. */
  now?: number | (() => number);
  /** 402Signal fee recipients the recursion exemption may pay. Default DEFAULT_FEE_RECIPIENTS (GET /rails). */
  feeRecipients?: readonly string[];
  /** Largest atomic amount the exemption may pay. Default DEFAULT_MAX_FEE_ATOMIC (a session open). */
  maxFeeAtomic?: string;
  /** Fee terms by CAIP-2 network the exemption may pay on. Default DEFAULT_FEE_TERMS (GET /rails). */
  feeTerms?: Readonly<Record<string, FeeTerms>>;
  /** Largest seller challenge the built-in reread accepts, in bytes. Default MAX_CHALLENGE_BYTES. */
  maxChallengeBytes?: number;
  /** End-to-end deadline of the built-in reread. Default DEFAULT_CHALLENGE_TIMEOUT_MS. */
  challengeTimeoutMs?: number;
}

export const DEFAULT_ROUTER: string;
export const DEFAULT_FEE_RECIPIENTS: readonly string[];
export const DEFAULT_MAX_FEE_ATOMIC: string;
export const DEFAULT_FEE_TERMS: Readonly<Record<string, FeeTerms>>;
export const MAX_CHALLENGE_BYTES: number;
export const DEFAULT_CHALLENGE_TIMEOUT_MS: number;
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
  options?: ChallengeReadOptions,
): Promise<RawChallenge>;
export function signalGuard(options: SignalGuardOptions): X402BeforePaymentCreationHook;
