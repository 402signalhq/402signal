import type { DatabaseSync } from 'node:sqlite';
import type { Hex } from 'viem';
import type { SessionLedger, CanonicalValue } from './common.js';
export function canonical(value: CanonicalValue): string;
export type OperationState = 'planned' | 'inflight' | 'provider_ack' | 'failed' | 'unknown' | 'chain_confirmed' | 'not_executed';
export interface OperationInput { readonly operationId: string; readonly kind: 'claim' | 'settle'; readonly scope: { readonly network: 'eip155:8453'; readonly receiver: string; readonly token: string }; readonly payloadDigest: string }
export interface OperationEvidence { readonly status: Exclude<OperationState, 'planned' | 'inflight'>; readonly evidenceDigest: string; readonly transactionHash?: Hex; readonly blockHash?: Hex; readonly blockNumber?: number }
export interface OperationRecord extends OperationInput { readonly state: OperationState; readonly events: readonly ({ readonly state: OperationState; readonly at: string } & Partial<OperationEvidence>)[] }
export interface OperationLease extends OperationInput { readonly sendToken: string }
export interface OperationJournal {
  initialize(): Promise<void>;
  get(id: string): Promise<OperationRecord | undefined>;
  plan(input: OperationInput): Promise<OperationRecord>;
  acquire(id: string): Promise<OperationLease | undefined>;
  recordOutcome(id: string, token: string, input: OperationEvidence & { readonly status: 'provider_ack' | 'failed' | 'unknown' }): Promise<OperationRecord>;
  reconcile(id: string, input: OperationEvidence & { readonly status: 'chain_confirmed' | 'not_executed' }): Promise<OperationRecord>;
}
export class LocalBatchLedger implements SessionLedger {
  constructor(directory: string, campaignId: string);
  readonly campaignId: string; readonly db: DatabaseSync;
  initialize(): Promise<void>;
  key(stage: string): string;
  get(stage: string): Promise<unknown>;
  require(stage: string): Promise<unknown>;
  once(stage: string, value: unknown): Promise<boolean>;
  bind(plan: unknown): Promise<void>;
  transition(expected: string, next: string): Promise<void>;
  close(): void;
}
export class LocalOperationJournal implements OperationJournal {
  constructor(ledger: LocalBatchLedger);
  readonly ledger: LocalBatchLedger;
  initialize(): Promise<void>;
  id(id: string): string;
  get(id: string): Promise<OperationRecord | undefined>;
  plan(input: OperationInput): Promise<OperationRecord>;
  acquire(id: string): Promise<OperationLease | undefined>;
  recordOutcome(id: string, token: string, input: OperationEvidence & { readonly status: 'provider_ack' | 'failed' | 'unknown' }): Promise<OperationRecord>;
  reconcile(id: string, input: OperationEvidence & { readonly status: 'chain_confirmed' | 'not_executed' }): Promise<OperationRecord>;
  proof(input: OperationEvidence): void;
  change<T>(id: string, mutator: (current: unknown) => T): T;
}
