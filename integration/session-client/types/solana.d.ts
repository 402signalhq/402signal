import type { KeyPairSigner } from '@solana/kit';
import type { SessionLedger, ReadRpc, SessionOptions, SessionPolicy, InitialObservation, ContinuationState, CallerRequest, SendSession, RecoverSession, CallOutcome, UnknownOutcome } from './common.js';
/** The supported push-only wire subset, kept local to avoid unrelated SDK optional peers. */
export interface NativeSessionTerms {
  readonly cap: string; readonly currency: string; readonly decimals: 6;
  readonly description?: string; readonly externalId?: string; readonly minVoucherDelta?: string;
  readonly modes?: readonly 'push'[]; readonly network: 'mainnet'; readonly operator: string;
  readonly programId: string; readonly recentBlockhash: string; readonly recentSlot: string;
  readonly recipient: string; readonly splits?: readonly never[];
}
export interface SessionChallenge {
  readonly id: string; readonly realm: string; readonly method: 'solana'; readonly intent: 'session';
  readonly request: NativeSessionTerms; readonly expires: string;
  readonly description?: string; readonly digest?: string; readonly opaque?: unknown;
}
export interface PaymentChannelOpenTransaction {
  readonly channelId: string; readonly deposit: string; readonly gracePeriod: number;
  readonly mint: string; readonly openSlot: string; readonly payee: string; readonly payer: string;
  readonly salt: string; readonly transaction: string;
}
export interface SignedVoucher {
  readonly data: { readonly channelId: string; readonly cumulativeAmount: string; readonly expiresAt: number; readonly nonce?: number };
  readonly signature: string;
}
export interface OpenPayload {
  readonly action: 'open'; readonly authorizedSigner: string; readonly mode: 'push';
  readonly channelId: string; readonly deposit: string; readonly gracePeriod: number;
  readonly mint: string; readonly payee: string; readonly payer: string; readonly recentSlot: string;
  readonly salt: string; readonly signature: string; readonly transaction: string;
}
export type SolanaMessageSigner = Pick<KeyPairSigner, 'address' | 'signMessages'>;
export type SolanaTransactionSigner = Pick<KeyPairSigner, 'address' | 'signTransactions'>;
export interface SolanaFundingPolicy {
  readonly payer: string; readonly operator: string; readonly recipient: string;
  readonly programDataAddress: string; readonly programDataSha256: string;
  readonly maximumOperatorOpenLamports: string; readonly depositAtomic: string;
  readonly maxSessionAtomic: string; readonly gracePeriod: 900;
  readonly voucherExpiresAt: number; readonly salt: string;
}
export interface SolanaInitialRequest { readonly url: string; readonly method: 'GET' | 'POST'; readonly digest: string }
export interface SolanaSessionPlan {
  readonly version: 1; readonly rawChallenge: string; readonly challenge: SessionChallenge;
  readonly request: SolanaInitialRequest; readonly policy: SolanaFundingPolicy;
  readonly open: PaymentChannelOpenTransaction; readonly messageBase64: string;
  readonly observedAt: number; readonly expiresAt: number; readonly intentDigest: string;
}
export interface SolanaOpenCredential { readonly payload: OpenPayload; readonly authorization: string }
export interface SolanaConfirmedOpen { readonly state: 'chain_confirmed'; readonly transactionSignature: string; readonly slot: number; readonly evidenceDigest: string; readonly channel: Readonly<Record<string, unknown>> }
export interface SolanaConfirmedClose { readonly state: 'chain_confirmed'; readonly transactionSignature: string; readonly slot: number; readonly merchantAtomic: string; readonly returnedBuyerAtomic: string; readonly channelRent: 'reclaim_pending' | 'account_deallocated'; readonly evidenceDigest: string }
export interface SolanaReady { readonly state: 'ready'; readonly operatorOpenLamports: string; readonly operatorRetainedReserveLamports: string; readonly operatorMinimumBalanceLamports: string; readonly buyerNativeLamports: '0'; readonly programDataSha256: string }
export function prepareSolanaSession(input: { readonly wwwAuthenticate: string; readonly request: SolanaInitialRequest; readonly policy: SolanaFundingPolicy }): Promise<SolanaSessionPlan>;
export function quoteSolanaSessionRent(rpc: ReadRpc): Promise<{ readonly channelBytes: number; readonly escrowBytes: 165; readonly operatorRentLamports: string; readonly buyerRentLamports: '0'; readonly transactionFeeLamports: 'requires prepared-message quote'; readonly rentReturn: string }>;
export function verifySolanaSessionDeployment(rpc: ReadRpc, plan: SolanaSessionPlan): Promise<SolanaReady>;
export function observeSolanaOpen(rpc: ReadRpc, plan: SolanaSessionPlan, signature: string): Promise<SolanaConfirmedOpen | UnknownOutcome>;
export function observeSolanaClose(rpc: ReadRpc, plan: SolanaSessionPlan, signature: string, voucher?: SignedVoucher): Promise<SolanaConfirmedClose | UnknownOutcome>;
export class SolanaSessionClient {
  constructor(ledger: SessionLedger, plan: SolanaSessionPlan, options: SessionOptions);
  readonly ledger: SessionLedger; readonly plan: SolanaSessionPlan;
  readonly sessionPolicy: SessionPolicy; readonly initialObservation?: InitialObservation; continuation?: ContinuationState;
  initialize(): Promise<void>;
  fresh(): void;
  signOpen(owner: SolanaTransactionSigner, rpc: ReadRpc): Promise<SolanaOpenCredential>;
  sendOpen(send: (credential: SolanaOpenCredential) => Promise<{ readonly reference: string }>): Promise<{ readonly state: 'provider_ack' } | UnknownOutcome>;
  confirmOpen(rpc: ReadRpc, signature?: string): Promise<SolanaConfirmedOpen | UnknownOutcome>;
  deliver(owner: SolanaMessageSigner, sequence: number, request: CallerRequest, wwwAuthenticate: string, send: SendSession): Promise<CallOutcome>;
  recoverDelivery(sequence: number, recover: RecoverSession): Promise<CallOutcome>;
  /** Legacy entry points deliberately throw; use deliver/recoverDelivery. */
  voucher(): Promise<never>;
  recoverVoucher(): Promise<never>;
  close(sequence: number, request: CallerRequest, wwwAuthenticate: string, send: SendSession): Promise<{ readonly state: 'provider_ack' | 'close_requested'; readonly chainSettled: false; readonly reference: string } | UnknownOutcome>;
  confirmClose(rpc: ReadRpc, signature: string): Promise<SolanaConfirmedClose | UnknownOutcome>;
}
