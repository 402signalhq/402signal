import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export type OperationKind = "claim" | "settle";
export type OperationState = "planned" | "inflight" | "provider_ack" | "failed" | "unknown" | "chain_confirmed" | "not_executed";
export interface OperationScope { network: string; receiver: string; token: string }
export interface OperationPlan { operationId: string; kind: OperationKind; scope: OperationScope; payloadDigest: string }
export interface OperationOutcome { status: "provider_ack" | "failed" | "unknown"; evidenceDigest: string; transactionHash?: string }
export interface OperationReconciliation {
  status: "chain_confirmed" | "not_executed"; evidenceDigest: string;
  transactionHash?: string; blockHash?: string; blockNumber?: number;
}
export interface OperationEvent {
  state: OperationState; at: string; evidenceDigest?: string; transactionHash?: string; blockHash?: string; blockNumber?: number;
}
export interface Operation extends OperationPlan { state: OperationState; events: OperationEvent[] }
export interface SendPermit extends OperationPlan { sendToken: string }
type StoredOperation = Operation & { sendToken?: string };
const TABLE = "public.lab_batch_operations_v1";
const DIGEST = /^[0-9a-f]{64}$/;
const HASH = /^0x[0-9a-f]{64}$/;

function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new Error("invalid operation id or digest");
}
function canonicalPlan(input: OperationPlan): OperationPlan {
  identifier(input.operationId); identifier(input.payloadDigest);
  if (input.kind !== "claim" && input.kind !== "settle") throw new Error("invalid operation kind");
  const scope = input.scope;
  if (!scope || typeof scope.network !== "string" || !/^eip155:[1-9][0-9]{0,19}$/.test(scope.network) ||
    ![scope.receiver, scope.token].every(v => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v))) throw new Error("invalid operation scope");
  return { operationId: input.operationId, kind: input.kind, scope: { network: scope.network,
    receiver: scope.receiver.toLowerCase(), token: scope.token.toLowerCase() }, payloadDigest: input.payloadDigest };
}
function exposed(value: StoredOperation): Operation {
  const { sendToken: _, ...operation } = value;
  return structuredClone(operation);
}
function event(state: OperationState, proof: Partial<OperationEvent> = {}): OperationEvent {
  return { state, at: new Date().toISOString(), ...proof };
}
function evidence(input: OperationOutcome | OperationReconciliation): Omit<OperationEvent, "state" | "at"> {
  identifier(input.evidenceDigest);
  if (input.transactionHash !== undefined && !HASH.test(input.transactionHash)) throw new Error("invalid transaction hash");
  const result: Omit<OperationEvent, "state" | "at"> = { evidenceDigest: input.evidenceDigest };
  if (input.transactionHash !== undefined) result.transactionHash = input.transactionHash;
  if (input.status === "chain_confirmed") {
    if (!input.transactionHash || typeof input.blockHash !== "string" || !HASH.test(input.blockHash) ||
      !Number.isSafeInteger(input.blockNumber) || input.blockNumber! < 0) throw new Error("chain observation requires transaction and block evidence");
    result.blockHash = input.blockHash; result.blockNumber = input.blockNumber;
  }
  return result;
}
function sameEvent(current: StoredOperation, state: OperationState, proof: Omit<OperationEvent, "state" | "at">): boolean {
  const last = current.events.at(-1);
  if (!last || current.state !== state) return false;
  return (["evidenceDigest", "transactionHash", "blockHash", "blockNumber"] as const)
    .every(key => last[key] === proof[key]);
}
function decode(raw: unknown, expectedId?: string): StoredOperation {
  if (!raw || typeof raw !== "object" || Buffer.byteLength(JSON.stringify(raw)) > 32768) throw new Error("invalid operation record");
  const value = structuredClone(raw) as StoredOperation;
  canonicalPlan(value);
  if (expectedId !== undefined && value.operationId !== expectedId) throw new Error("operation record id mismatch");
  if (!["planned", "inflight", "provider_ack", "failed", "unknown", "chain_confirmed", "not_executed"].includes(value.state) ||
    !Array.isArray(value.events) || value.events.length < 1 || value.events.length > 8 || value.events.at(-1)?.state !== value.state ||
    (value.state !== "planned" && (typeof value.sendToken !== "string" || !/^[0-9a-f-]{36}$/.test(value.sendToken)))) {
    throw new Error("invalid operation state");
  }
  const states = value.events.map(entry => entry.state);
  const terminal = value.state === "chain_confirmed" || value.state === "not_executed";
  const expectedLength = value.state === "planned" ? 1 : value.state === "inflight" ? 2 : terminal ? value.events.length : 3;
  if (states[0] !== "planned" || (states.length > 1 && states[1] !== "inflight") ||
    value.events.length !== expectedLength || (terminal && ![3, 4].includes(states.length)) ||
    (terminal && states.length === 4 && !["provider_ack", "unknown", "failed"].includes(states[2]!)) ||
    (value.state === "planned" && value.sendToken !== undefined) ||
    value.events.some(entry => typeof entry.at !== "string" || !Number.isFinite(Date.parse(entry.at)))) throw new Error("invalid operation history");
  for (const entry of value.events.slice(2)) {
    identifier(entry.evidenceDigest);
    if (entry.transactionHash !== undefined && !HASH.test(entry.transactionHash)) throw new Error("invalid recorded transaction hash");
    if (entry.state === "chain_confirmed" && (!entry.transactionHash || !entry.blockHash || !HASH.test(entry.blockHash) ||
      !Number.isSafeInteger(entry.blockNumber) || entry.blockNumber! < 0)) throw new Error("invalid recorded chain observation");
  }
  return value;
}

/** Lab-only intent journal. No signing, RPC, funds custody or automatic retries.
 * A send permit is never leased/reissued: process death or a lost DB acknowledgement
 * leaves the operation blocked until explicit reconciliation. Provider acknowledgement
 * is not final payment. Reconciliation records caller-supplied chain evidence; a
 * separate trusted observer must validate that evidence against the bound operation.
 * The caller must use a stable semantic operation ID across restarts and serialize
 * overlapping cycles; this store cannot infer that two distinct IDs mean one payout.
 */
export class PostgresBatchOperationJournal {
  constructor(private readonly pool: Pool, private readonly namespace: string) {
    if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(namespace)) throw new Error("invalid journal namespace");
  }
  async initialize(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      namespace text NOT NULL CHECK (namespace ~ '^[a-zA-Z0-9:_-]{1,128}$'),
      operation_id text NOT NULL CHECK (operation_id ~ '^[0-9a-f]{64}$'),
      record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=32768),
      PRIMARY KEY(namespace,operation_id)
    )`);
  }
  async plan(input: OperationPlan): Promise<Operation> {
    const plan = canonicalPlan(input);
    const value: StoredOperation = { ...plan, state: "planned", events: [event("planned")] };
    await this.pool.query(`INSERT INTO ${TABLE}(namespace,operation_id,record) VALUES($1,$2,$3::jsonb)
      ON CONFLICT(namespace,operation_id) DO NOTHING`, [this.namespace, plan.operationId, JSON.stringify(value)]);
    const existing = await this.get(plan.operationId);
    if (!existing || JSON.stringify(canonicalPlan(existing)) !== JSON.stringify(plan)) throw new Error("operation id conflicts with immutable plan");
    return existing;
  }
  async get(operationId: string): Promise<Operation | undefined> {
    identifier(operationId);
    const result = await this.pool.query(`SELECT record FROM ${TABLE} WHERE namespace=$1 AND operation_id=$2`, [this.namespace, operationId]);
    return result.rows[0] ? exposed(decode(result.rows[0].record, operationId)) : undefined;
  }
  async acquire(operationId: string): Promise<SendPermit | undefined> {
    identifier(operationId);
    return this.transaction(operationId, async (client, current) => {
      if (current.state !== "planned") return undefined;
      const sendToken = randomUUID();
      const next: StoredOperation = { ...current, sendToken, state: "inflight", events: [...current.events, event("inflight")] };
      await this.save(client, next);
      return { ...canonicalPlan(current), sendToken };
    });
  }
  async recordOutcome(operationId: string, sendToken: string, input: OperationOutcome): Promise<Operation> {
    if (!["provider_ack", "failed", "unknown"].includes(input.status)) throw new Error("invalid provider outcome");
    const proof = evidence(input);
    return this.transaction(operationId, async (client, current) => {
      if (current.sendToken !== sendToken || typeof sendToken !== "string") throw new Error("send token does not own operation");
      if (sameEvent(current, input.status, proof)) return exposed(current);
      if (current.state !== "inflight") throw new Error("operation outcome already recorded; reconcile explicitly");
      const next = { ...current, state: input.status, events: [...current.events, event(input.status, proof)] };
      await this.save(client, next);
      return exposed(next);
    });
  }
  async reconcile(operationId: string, input: OperationReconciliation): Promise<Operation> {
    if (input.status !== "chain_confirmed" && input.status !== "not_executed") throw new Error("invalid reconciliation outcome");
    const proof = evidence(input);
    return this.transaction(operationId, async (client, current) => {
      if (sameEvent(current, input.status, proof)) return exposed(current);
      if (["planned", "chain_confirmed", "not_executed"].includes(current.state)) throw new Error("operation cannot accept this reconciliation");
      const next = { ...current, state: input.status, events: [...current.events, event(input.status, proof)] };
      await this.save(client, next);
      return exposed(next);
    });
  }
  private async save(client: PoolClient, value: StoredOperation): Promise<void> {
    decode(value);
    await client.query(`UPDATE ${TABLE} SET record=$3::jsonb WHERE namespace=$1 AND operation_id=$2`,
      [this.namespace, value.operationId, JSON.stringify(value)]);
  }
  private async transaction<T>(operationId: string, action: (client: PoolClient, current: StoredOperation) => Promise<T>): Promise<T> {
    identifier(operationId);
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SET LOCAL lock_timeout='2s'");
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout='5s'");
      const result = await client.query(`SELECT record FROM ${TABLE} WHERE namespace=$1 AND operation_id=$2 FOR UPDATE`, [this.namespace, operationId]);
      if (!result.rows[0]) throw new Error("operation has not been planned");
      const value = await action(client, decode(result.rows[0].record, operationId));
      await client.query("COMMIT");
      return value;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { discard = true; }
      throw error;
    } finally { client.release(discard); }
  }
}
