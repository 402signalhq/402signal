import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { assertBatchSchemaReady } from "./batch-schema-readiness.js";
import type {
  Channel,
  ChannelStorage,
} from "@x402/evm/batch-settlement/server";

const TABLE = "public.lab_batch_channels_v1";
const MAX_RECORD_BYTES = 32768;
const UINT256 = (1n << 256n) - 1n;

function channelKey(value: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error("invalid channel id");
  return value.toLowerCase();
}
function uint(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^(0|[1-9][0-9]{0,77})$/.test(value) &&
    BigInt(value) <= UINT256
  );
}
function timestamp(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function record(value: unknown, id: string): Channel {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid channel record");
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw) > MAX_RECORD_BYTES)
    throw new Error("channel record too large");
  const c = JSON.parse(raw) as Channel;
  if (channelKey(c.channelId) !== id) throw new Error("channel id mismatch");
  const cfg = c.channelConfig;
  if (
    !cfg ||
    ![
      cfg.payer,
      cfg.payerAuthorizer,
      cfg.receiver,
      cfg.receiverAuthorizer,
      cfg.token,
    ].every((x) => typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x)) ||
    typeof cfg.salt !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(cfg.salt) ||
    !timestamp(cfg.withdrawDelay)
  ) {
    throw new Error("invalid channel configuration");
  }
  if (
    ![
      c.chargedCumulativeAmount,
      c.signedMaxClaimable,
      c.balance,
      c.totalClaimed,
    ].every(uint) ||
    ![c.withdrawRequestedAt, c.refundNonce, c.lastRequestTimestamp].every(
      timestamp,
    ) ||
    (c.onchainSyncedAt !== undefined && !timestamp(c.onchainSyncedAt)) ||
    typeof c.signature !== "string" ||
    !/^(?:|0x(?:[0-9a-fA-F]{2})*)$/.test(c.signature)
  ) {
    throw new Error("invalid channel state");
  }
  if (c.pendingRequest !== undefined) {
    const pending = c.pendingRequest;
    if (
      !pending ||
      typeof pending.pendingId !== "string" ||
      !/^[a-zA-Z0-9:_-]{1,128}$/.test(pending.pendingId) ||
      !uint(pending.signedMaxClaimable) ||
      !timestamp(pending.expiresAt)
    )
      throw new Error("invalid pending request");
  }
  c.channelId = id;
  return c;
}

/** Lab qualification adapter; not wired into the router or a production migration.
 * All writers must use this adapter's transaction lock protocol. The caller owns
 * the Pool and its connection/TLS/timeouts. Call initialize with a migration role;
 * runtime roles only need SELECT/INSERT/UPDATE/DELETE on this fixed table.
 * Namespace must separate deployment, chain, contract and receiver identities.
 */
export class PostgresChannelStorage implements ChannelStorage {
  constructor(
    private readonly pool: Pool,
    private readonly namespace: string,
    private readonly maxListRows = 1000,
  ) {
    if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(namespace))
      throw new Error("invalid storage namespace");
    if (
      !Number.isSafeInteger(maxListRows) ||
      maxListRows < 1 ||
      maxListRows > 10000
    )
      throw new Error("invalid list bound");
  }

  async assertReady(): Promise<void> {
    await assertBatchSchemaReady(this.pool, "channels");
  }

  /** Explicit migration helper; the live merchant uses assertReady instead. */
  async initialize(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      namespace text NOT NULL CHECK (namespace ~ '^[a-zA-Z0-9:_-]{1,128}$'),
      channel_id text NOT NULL CHECK (channel_id ~ '^0x[0-9a-f]{64}$'),
      record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object' AND octet_length(record::text) <= 32768),
      PRIMARY KEY (namespace, channel_id)
    )`);
  }

  async get(channelId: string): Promise<Channel | undefined> {
    const id = channelKey(channelId);
    const result = await this.pool.query(
      `SELECT record FROM ${TABLE} WHERE namespace=$1 AND channel_id=$2`,
      [this.namespace, id],
    );
    return result.rows[0] ? record(result.rows[0].record, id) : undefined;
  }

  /** Fail on oversized result sets rather than silently omit channels from claims.
   * A production settlement scheduler needs a paginated work queue instead.
   */
  async list(): Promise<Channel[]> {
    const result = await this.pool.query(
      `SELECT channel_id, record FROM ${TABLE} WHERE namespace=$1 ORDER BY channel_id LIMIT $2`,
      [this.namespace, this.maxListRows + 1],
    );
    if (result.rows.length > this.maxListRows)
      throw new Error("channel list exceeds configured bound");
    return result.rows.map((row) => record(row.record, row.channel_id));
  }

  /** Synchronous callbacks must be fast, side-effect-free and return a new object
   * to persist a change. Never retries the callback (including an uncertain COMMIT).
   * On a connection error, the caller must read/reconcile state before retrying an
   * economic operation. This backend does not make external settlement idempotent.
   */
  async updateChannel(
    channelId: string,
    update: (current: Channel | undefined) => Channel | undefined,
  ) {
    const id = channelKey(channelId);
    const lock = createHash("sha256")
      .update(`${this.namespace}\0${id}`)
      .digest()
      .readBigInt64BE(0)
      .toString();
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query(
        "SET LOCAL idle_in_transaction_session_timeout = '5s'",
      );
      // Transaction-scoped backend lock also covers a channel's first insert.
      // A hash collision only serializes unrelated keys; it cannot mix records.
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [lock]);
      const result = await client.query(
        `SELECT record FROM ${TABLE} WHERE namespace=$1 AND channel_id=$2`,
        [this.namespace, id],
      );
      const stored = result.rows[0]
        ? record(result.rows[0].record, id)
        : undefined;
      const current =
        stored === undefined ? undefined : structuredClone(stored);
      const next = update(current);
      let channel: Channel | undefined;
      let status: "updated" | "unchanged" | "deleted";
      if (next === current) {
        // A callback mutating and returning current still means unchanged per SDK.
        channel = stored;
        status = "unchanged";
      } else if (next === undefined) {
        await client.query(
          `DELETE FROM ${TABLE} WHERE namespace=$1 AND channel_id=$2`,
          [this.namespace, id],
        );
        channel = undefined;
        status = stored === undefined ? "unchanged" : "deleted";
      } else {
        channel = record(next, id);
        await client.query(
          `INSERT INTO ${TABLE} (namespace, channel_id, record) VALUES ($1,$2,$3::jsonb)
          ON CONFLICT (namespace,channel_id) DO UPDATE SET record=EXCLUDED.record`,
          [this.namespace, id, JSON.stringify(channel)],
        );
        status = "updated";
      }
      await client.query("COMMIT");
      return { channel, status };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }
}
