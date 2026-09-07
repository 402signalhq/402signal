import type { Pool } from "pg";
import { assertBatchSchemaReady } from "./batch-schema-readiness.js";
import { createHash } from "node:crypto";
export const canonical = (x: any): string => {
  if (typeof x === "bigint") return JSON.stringify(x.toString());
  if (Array.isArray(x)) return "[" + x.map(canonical).join(",") + "]";
  if (x && typeof x === "object")
    return (
      "{" +
      Object.keys(x)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(x[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(x);
};
export const digest = (x: any) =>
  createHash("sha256").update(canonical(x)).digest("hex");
const TABLE = "public.lab_base_batch_stages_v1";
/** Owner-controlled lab ledger. Immutable stage IDs are never leased/reissued.
 * Lost insert acknowledgement blocks execution; reads never recover permission.
 * Values may include payment authorizations: restrict this DB to the buyer/operator.
 */
export class BaseBatchLedger {
  constructor(
    private pool: Pool,
    readonly campaignId: string,
  ) {
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(campaignId))
      throw Error("invalid campaign");
  }
  /** Explicit migration helper; never called by the configured live merchant. */
  async assertReady() {
    await assertBatchSchemaReady(this.pool, "stages");
  }
  async initialize() {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${TABLE}(campaign text NOT NULL,stage text NOT NULL,value jsonb NOT NULL CHECK(octet_length(value::text)<=65536),PRIMARY KEY(campaign,stage))`,
    );
  }
  async get(stage: string): Promise<any> {
    const r = await this.pool.query(
      `SELECT value FROM ${TABLE} WHERE campaign=$1 AND stage=$2`,
      [this.campaignId, stage],
    );
    return r.rows[0]?.value;
  }
  async once(stage: string, value: any): Promise<boolean> {
    if (!/^[a-zA-Z0-9:_-]{1,100}$/.test(stage)) throw Error("invalid stage");
    const raw = canonical(value);
    if (Buffer.byteLength(raw) > 65536) throw Error("stage too large");
    const r = await this.pool.query(
      `INSERT INTO ${TABLE}(campaign,stage,value) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING RETURNING stage`,
      [this.campaignId, stage, raw],
    );
    return r.rowCount === 1;
  }
  async transition(expected: string, next: string) {
    const r = await this.pool.query(
      `UPDATE ${TABLE} SET value=$3::jsonb WHERE campaign=$1 AND stage='progress' AND value->>'state'=$2 RETURNING stage`,
      [this.campaignId, expected, JSON.stringify({ state: next })],
    );
    if (r.rowCount !== 1)
      throw Error("campaign stage already claimed or unresolved");
  }
  async bind(plan: any) {
    await this.once("plan", plan);
    if (digest(await this.get("plan")) !== digest(plan))
      throw Error("immutable campaign conflict");
  }
  async require(stage: string) {
    const v = await this.get(stage);
    if (!v) throw Error("stage required: " + stage);
    return v;
  }
}
