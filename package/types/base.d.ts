import type { Hex, LocalAccount } from 'viem';
import type { PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types';
import type { FacilitatorClient } from '@x402/core/server';
import type { SessionLedger, ReadRpc, SessionOptions, SessionPolicy, InitialObservation, ContinuationState, CallerRequest, SendSession, RecoverSession, CallOutcome, UnknownOutcome } from './common.js';
import type { OperationJournal, OperationRecord } from './ledger.js';
export interface BaseChannelConfig { readonly payer: Hex; readonly payerAuthorizer: Hex; readonly receiver: Hex; readonly receiverAuthorizer: Hex; readonly token: Hex; readonly withdrawDelay: number; readonly salt: Hex }
export interface BaseSessionPlan {
  readonly version: 1; readonly config: BaseChannelConfig; readonly resource: string;
  readonly perCallAtomic: string; readonly depositAtomic: string; readonly maxCalls: number;
  readonly expiresAt: number; readonly maximumBuyerGasWei: '0';
  readonly contractCodeHash: Hex; readonly collectorCodeHash: Hex; readonly deliveryObservationUntil?: number;
}
export type BaseOwnerSigner = Pick<LocalAccount, 'address' | 'signTypedData'>;
export type BaseDepositProvider = Pick<FacilitatorClient, 'verify' | 'settle'>;
export type BaseSettlementProvider = Pick<FacilitatorClient, 'settle'>;
export interface BaseState { readonly balance: string; readonly claimed: string; readonly receiverClaimed: string; readonly receiverSettled: string; readonly refundNonce: string; readonly withdrawAmount: string; readonly withdrawAt: string }
export interface BaseConfirmed {
  readonly state: 'chain_confirmed'; readonly transactionHash: Hex; readonly blockHash: Hex;
  readonly blockNumber: number; readonly evidenceDigest: string; readonly after: BaseState;
  readonly confirmedAtSeconds?: number;
}
export interface BaseEffect { readonly kind: 'deposit' | 'claim' | 'settle' | 'refund'; readonly config: BaseChannelConfig; readonly amount: string; readonly transactionHash: Hex; readonly payload: unknown; readonly baseline: Pick<BaseState, 'balance' | 'claimed' | 'receiverClaimed' | 'receiverSettled' | 'refundNonce'>; readonly maxBuyerGasWei: string }
export function observeBaseBatch(rpc: ReadRpc, effect: BaseEffect): Promise<BaseConfirmed | UnknownOutcome>;
export class BaseSessionClient {
  constructor(ledger: SessionLedger, journal: OperationJournal, rpc: ReadRpc, plan: BaseSessionPlan, options: SessionOptions);
  readonly ledger: SessionLedger; readonly journal: OperationJournal; readonly rpc: ReadRpc;
  readonly plan: BaseSessionPlan; readonly requirements: PaymentRequirements;
  readonly sessionPolicy: SessionPolicy; readonly initialObservation?: InitialObservation; continuation?: ContinuationState;
  initialize(): Promise<void>;
  fresh(): void;
  prepareDeposit(owner: BaseOwnerSigner): Promise<PaymentPayload>;
  sendDeposit(provider: BaseDepositProvider): Promise<SettleResponse | UnknownOutcome>;
  confirm(kind: 'deposit' | 'claim' | 'settle' | 'refund', transactionHash?: Hex): Promise<BaseConfirmed | UnknownOutcome>;
  deliver(owner: BaseOwnerSigner, sequence: number, request: CallerRequest, challengeBody: string, send: SendSession): Promise<CallOutcome>;
  recoverDelivery(sequence: number, recover: RecoverSession): Promise<CallOutcome>;
  close(sequence: number): Promise<void>;
  sendCloseOperation(kind: 'claim' | 'settle', provider: BaseSettlementProvider): Promise<{ readonly sent: boolean; readonly operation?: OperationRecord }>;
  sendRefund(provider: BaseSettlementProvider): Promise<SettleResponse | UnknownOutcome>;
  sendUnspentRefund(provider: BaseSettlementProvider): Promise<SettleResponse | UnknownOutcome>;
  closeEmpty(): Promise<void>;
  bindDeliveryObservation(value: { readonly proofDigest: string; readonly channelId: string; readonly termsDigest: string; readonly observedAt: number; readonly expiresAt: number; readonly depositTransactionHash: string }): Promise<void>;
}
