import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
export const ALGORAND_BATCH_PATH: "/algorand/batch/sha256";
export const ALGORAND_BATCH_EXTENSION: "402signal-atomic-batch";
export interface AlgorandBatchManifest {
  version: number;
  network: string;
  asset: string;
  recipient: string;
  resource: string;
  requestHash: string;
  itemCount: number;
  itemAmount: string;
  totalAmount: string;
  paymentIndices: number[];
  sponsorIndex: number;
  feePayer: string;
  maxSponsorFeeMicroAlgo: string;
  jobHashes: string[];
}
export interface Group {
  groupId: string;
  totalAtomic: string;
  transfers: ReadonlyArray<{
    paymentIndex: number;
    transaction: string;
    payTo: string;
    amountAtomic: string;
  }>;
}
export interface AlgorandGenericLimits {
  network: string;
  asset: string;
  recipient: string;
  fee_payer: string;
  max_total_amount_atomic: string;
  max_sponsor_fee_micro_algo: string;
  max_item_amount_atomic: string;
  job_hashes: [string, string];
}
export interface AlgorandBatchPlan {
  profile?: "algorand-atomic-two-item-v1";
  buyerLimits?: AlgorandGenericLimits;
  id: string;
  scope: string;
  url: string;
  requirement: PaymentRequirements;
  manifest: AlgorandBatchManifest;
  buyer: string;
  raw: Uint8Array[];
  group: Group;
}
export interface Outcome {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}
export interface DurableLedger {
  lookup(
    id: string,
    scope: string,
  ): { run: false; outcome: Outcome } | undefined;
  reserve(id: string, scope: string): { run: boolean; outcome?: Outcome };
  attempting(id: string): void;
  finish(id: string, state: string, outcome: Outcome): void;
}
export type BuyerSigner = (
  raw: Uint8Array[],
  indexes: number[],
) => Promise<(Uint8Array | null | undefined)[]>;
export function algorandBatchRequest(
  url: string,
  origin: string,
): { url: string; items: { index: number; result: { sha256: string } }[] };
export function algorandBatchManifest(
  url: string,
  origin: string,
  requirement: PaymentRequirements,
): AlgorandBatchManifest;
export function buildAlgorandBatchTransactions(
  requirement: PaymentRequirements,
  buyer: string,
  firstValid: bigint,
  lastValid: bigint,
): Uint8Array[];
export function prepareAlgorandBatch(input: {
  url: string;
  origin: string;
  requirement: PaymentRequirements;
  buyer: string;
  raw: Uint8Array[];
  maxSpendAtomic: string;
  manifest: AlgorandBatchManifest;
  profile?: "algorand-atomic-two-item-v1";
  buyerLimits?: AlgorandGenericLimits;
}): AlgorandBatchPlan;
export function signAlgorandBatch(
  plan: AlgorandBatchPlan,
  sign: BuyerSigner,
): Promise<PaymentPayload>;
export function executeAlgorandBatch(
  ledger: DurableLedger,
  plan: AlgorandBatchPlan,
  sign: BuyerSigner,
  send: (url: string, payment: PaymentPayload) => Promise<Outcome>,
  authorize: (manifest: AlgorandBatchManifest) => Promise<void>,
): Promise<Outcome>;
export function confirmAlgorandBatchOnce(
  plan: AlgorandBatchPlan,
  rpcUrl: string,
  read: (
    url: string,
    method: "GET" | "POST",
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<{ status: number; body: any; headers?: Record<string, string> }>,
): Promise<
  | { state: "unknown" }
  | {
      state: "confirmed";
      groupId: string;
      confirmedRound: number;
      transactions: string[];
      totalAtomic: string;
      buyerNativeFeeAtomic: string;
      sponsorFeeMicroAlgo: string;
    }
>;
