import type { BatchObservation, RouteGuardError } from "./batch.d.ts";

/** Minimal shape of an mppx Challenge (parsed from WWW-Authenticate: Payment). */
export interface MppChallenge {
  id: string;
  realm: string;
  method: string;
  intent: string;
  request: Record<string, unknown>;
  expires?: string;
  description?: string;
  digest?: string;
  header?: string;
  opaque?: string;
}

/** The payload mppx passes to `challenge.received` observers. */
export interface MppChallengeReceivedEvent {
  challenge: MppChallenge;
  input: string | URL | { url: string };
  init?: RequestInit;
  response?: Response;
  method?: unknown;
}

export interface MppChallengeTerms {
  realm: string;
  method: string;
  intent: string;
  amount: string;
  currency: string;
  recipient: string;
  chainId: number | null;
}

export interface MppBuyerLimits {
  network: string;
  asset: string;
  recipient: string;
  max_call_amount_atomic: string;
  realm: string;
}

export interface MppGuardContext {
  url: string;
  challenge: MppChallenge;
  raw: { url: string; status: number | null; wwwAuthenticate: string | null } | null;
  limits?: MppBuyerLimits | Record<string, unknown> | null;
}

export interface MppGuardResult {
  status: number | null;
  /** Raw check response text. Retain it with the request for later verification. */
  text: string | null;
  body: unknown;
  verified: BatchObservation | null;
  /** Set when the guard let the payment through without a verified check (onMiss/onUnsupported "allow"). */
  skipped: string | null;
  aborted: string | null;
}

export interface MppGuardOptions {
  /** Payment-capable fetch that pays the $0.003 checking fee (mppx.fetch or an x402 fetch). */
  fetchWithPayment: (input: string, init: RequestInit) => Promise<Response>;
  /** Pinned C2SP Ed25519 log verification key from trusted configuration. */
  trustedLogVkey: string;
  /** Per-call cap in atomic USDC, or a function of the challenge. Required unless limitsFor or requestFor is given. */
  maxCallAmountAtomic?: string | ((challenge: MppChallenge) => string);
  /** Replace defaultLimits; return null for challenges the router cannot observe. */
  limitsFor?: (challenge: MppChallenge, url: string) => MppBuyerLimits | Record<string, unknown> | null;
  /** Replace defaultRequest. */
  requestFor?: (context: MppGuardContext) => Record<string, unknown>;
  /** Supply the request URL when no challenge.received observer recorded it. */
  urlFor?: (challenge: MppChallenge) => string;
  /** Check endpoint. Default https://402signal.com/route. */
  router?: string;
  /** Behaviour when 402Signal reports no qualifying live offer. Default "abort". */
  onMiss?: "abort" | "allow";
  /** Behaviour for challenges the router cannot observe (non-Base, non-charge). Default "abort". */
  onUnsupported?: "abort" | "allow";
  /** Optional private Replay-Key (64 lowercase hex) for lost-response recovery. */
  replayKey?: (context: MppGuardContext) => string;
  /** Called with every check outcome for retention or logging. */
  onResult?: (result: MppGuardResult) => void;
  /** Unix-seconds clock override for deterministic tests. */
  now?: number | (() => number);
}

export interface MppGuard {
  /** Register with `mppx.onChallengeReceived(guard.onChallengeReceived)`. */
  onChallengeReceived: (event: MppChallengeReceivedEvent) => undefined;
  /** Pass as `Mppx.create({ onChallenge: guard.onChallenge })`. Throws MppGuardError to abort. */
  onChallenge: (challenge: MppChallenge, helpers?: unknown) => Promise<undefined>;
  /** Run one check directly; resolves with the outcome or throws MppGuardError. */
  check: (url: string, challenge: MppChallenge) => Promise<MppGuardResult>;
}

export class MppGuardError extends RouteGuardError {
  readonly detail: string | null;
}

export const DEFAULT_ROUTER: string;
export const BASE_NETWORK: string;
export const BASE_USDC: string;
export function parseChallengeHeader(raw: string): Array<MppChallenge & { raw: string }>;
export function challengeTerms(challenge: unknown): MppChallengeTerms | null;
export function defaultLimits(challenge: unknown, maxCallAmountAtomic: string): MppBuyerLimits | null;
export function defaultRequest(url: string, limits: MppBuyerLimits | Record<string, unknown>): Record<string, unknown>;
export function sameTerms(verifiedTerms: unknown, challenge: unknown): boolean;
export function mppGuard(options: MppGuardOptions): MppGuard;
