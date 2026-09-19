import type { BaseSessionPlan } from './base.js';
import type { SolanaSessionPlan } from './solana.js';
export type Rail = 'base' | 'solana';
/** Arbitrary RPC responses stay unknown until the runtime observer validates them. */
export type ReadRpc = (method: string, params: readonly unknown[]) => Promise<unknown>;
export type JsonValue = null | boolean | string | number | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type CanonicalValue = null | boolean | string | number | bigint | readonly CanonicalValue[] | { readonly [key: string]: CanonicalValue };
export type Normalized<T> = T extends bigint ? string : T extends readonly (infer U)[] ? Normalized<U>[] : T extends object ? { [K in keyof T]: Normalized<T[K]> } : T;
export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export interface SessionPolicy {
  readonly version: 2;
  /** Runtime enforces 1..64 and the immutable deposit/cumulative budget. */
  readonly maxCalls: number;
  readonly perCallAtomic: string;
  readonly maxCumulativeAtomic: string;
  /** Absolute milliseconds; never renews the initial routing observation. */
  readonly expiresAt: number;
  readonly request: { readonly url: string; readonly method: 'GET' | 'POST'; readonly maxBodyBytes: number };
}
export interface CallerRequest { readonly url: string; readonly method: 'GET' | 'POST'; readonly body: string }
export interface RequestSnapshot extends CallerRequest { readonly bodySha256: string; readonly requestDigest: string }
export interface InitialObservation {
  readonly routeResponseJson: string;
  readonly routeRequestJson: string;
  readonly trustedLogVkey: string;
  readonly challenge: { readonly status: 402; readonly bodyText: string; readonly paymentRequired: string | null; readonly wwwAuthenticate: string | null };
  /** The runtime uses its own current time. */
  readonly now?: never;
}
export interface SessionOptions { readonly policy: SessionPolicy; readonly initialObservation?: InitialObservation }
/** Durable owner-controlled storage; read values require validation, not caller casts. */
export interface SessionLedger {
  readonly campaignId: string;
  initialize(): Promise<void>;
  get(stage: string): Promise<unknown>;
  require(stage: string): Promise<unknown>;
  once(stage: string, value: unknown): Promise<boolean>;
  bind(plan: unknown): Promise<void>;
  transition(expected: string, next: string): Promise<void>;
}
export interface SessionPacket {
  readonly request: RequestSnapshot;
  readonly authorization: string;
  readonly payload: unknown;
  readonly sequence: number;
  readonly channelId: string;
  readonly cumulativeAmount: string;
  readonly rail: Rail;
}
export interface SessionResponse {
  readonly status: number;
  readonly url: string;
  readonly requestDigest: string;
  readonly authorizationDigest: string;
  readonly bodyText: string;
  readonly headers: Readonly<Record<string, string>>;
}
export interface RecoveryScope {
  readonly recoveryOnly: true;
  readonly channelId: string;
  readonly sequence: number;
  readonly requestDigest: string;
  readonly authorizationDigest: string;
}
export interface RecoveryResponse extends SessionResponse { readonly recoveryOnly: true }
export type SendSession = (packet: SessionPacket) => Promise<SessionResponse>;
export type RecoverSession = (scope: RecoveryScope) => Promise<RecoveryResponse>;
export interface UnknownOutcome { readonly state: 'unknown'; readonly newPaymentAllowed: false }
export interface AcceptedCall {
  readonly state: 'voucher_accepted';
  readonly chainSettled: false;
  readonly authorizedCumulativeAtomic: string;
  readonly receipt?: unknown;
}
export type CallOutcome = AcceptedCall | UnknownOutcome;
export interface CallScope { readonly sequence: number; readonly cumulative: string; readonly increment: string; readonly request: RequestSnapshot }
export interface ObservationBinding {
  readonly profile: string;
  readonly request: { readonly url: string; readonly method: string; readonly body_sha256: string };
  readonly buyer_limits: Readonly<Record<string, unknown>>;
  readonly terms: Readonly<Record<string, unknown>>;
  readonly challenge: InitialObservation['challenge'];
  readonly observed_at: number;
  readonly expires_at: number;
}
export interface ContinuationState {
  readonly identity: { readonly version: 2; readonly rail: Rail; readonly policy: SessionPolicy; readonly planDigest: string; readonly proofDigest: string };
  readonly binding: ObservationBinding;
  readonly authorizedAt: number;
  readonly initialExpiresAt: number;
}
export interface ContinuationController { readonly ledger: SessionLedger; readonly plan: BaseSessionPlan | SolanaSessionPlan; continuation?: ContinuationState }
