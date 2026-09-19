export type Rail = 'base' | 'solana' | 'algorand';
export interface ChainConfirmation {
  state: 'unknown' | 'confirmed';
  transaction?: string;
  level?: string;
  buyer_native_fee_atomic?: string;
}
export interface ReconcileOptions {
  rail: Rail;
  /** Existing transaction from the durable intent/receipt; never a new payment. */
  transaction: string;
  /** Trusted read-only verifier: match chain effects to your persisted intent. */
  observe: (request: Readonly<{rail: Rail; transaction: string; signal: AbortSignal}>) => Promise<ChainConfirmation>;
  maxObservations?: number;
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface Reconciliation {
  readonly state: 'confirmed' | 'unknown';
  readonly reason: string;
  readonly rail: Rail;
  readonly transaction: string;
  readonly observations: number;
  readonly elapsed_ms: number;
  readonly payment_resubmitted: false;
  readonly seller_execution_resumed: false;
  readonly budget_released: false;
  readonly confirmation?: Readonly<ChainConfirmation>;
}
export function reconcilePayment(options: ReconcileOptions): Promise<Reconciliation>;
