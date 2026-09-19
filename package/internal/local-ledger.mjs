import { DatabaseSync } from "node:sqlite";
import { mkdirSync, lstatSync, openSync, closeSync, constants } from "node:fs";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
export const canonical = (x) =>
  JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));
const checked = (x) => {
  const raw = canonical(x);
  if (!raw || Buffer.byteLength(raw) > 65536)
    throw Error("bounded journal value required");
  return raw;
};
const digest = (x) => createHash("sha256").update(checked(x)).digest("hex");
function privatePath(path, directory) {
  const s = lstatSync(path);
  if (
    s.isSymbolicLink() ||
    (directory ? !s.isDirectory() : !s.isFile()) ||
    (s.mode & 0o077) !== 0 ||
    s.uid !== process.getuid()
  )
    throw Error("private owner journal required");
}
/** Local owner journal only. FULL-sync SQLite transactions never retry callbacks.
 * An uncertain process exit after a permit permanently consumes that permit. */
export class LocalBatchLedger {
  constructor(directory, campaignId) {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(campaignId))
      throw Error("invalid campaign");
    this.campaignId = campaignId;
    const dir = resolve(directory);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    privatePath(dir, true);
    const file = join(dir, "batch.sqlite");
    const fd = openSync(
      file,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(fd);
    privatePath(file, false);
    this.db = new DatabaseSync(file);
    this.db.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS stages(campaign TEXT,stage TEXT,value TEXT,PRIMARY KEY(campaign,stage));",
    );
  }
  async initialize() {}
  key(stage) {
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(stage)) throw Error("invalid stage");
    return stage;
  }
  async get(stage) {
    const r = this.db
      .prepare("SELECT value FROM stages WHERE campaign=? AND stage=?")
      .get(this.campaignId, this.key(stage));
    return r ? JSON.parse(r.value) : undefined;
  }
  async require(stage) {
    const v = await this.get(stage);
    if (v === undefined) throw Error("stage required");
    return v;
  }
  async once(stage, value) {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO stages VALUES(?,?,?)")
        .run(this.campaignId, this.key(stage), checked(value)).changes === 1
    );
  }
  async bind(plan) {
    await this.once("plan", plan);
    if (digest(await this.require("plan")) !== digest(plan))
      throw Error("immutable campaign conflict");
  }
  async transition(expected, next) {
    const r = this.db
      .prepare(
        "UPDATE stages SET value=? WHERE campaign=? AND stage='progress' AND json_extract(value,'$.state')=?",
      )
      .run(checked({ state: next }), this.campaignId, expected);
    if (r.changes !== 1)
      throw Error("campaign stage already claimed or unresolved");
  }
  close() {
    this.db.close();
  }
}
/** Structural operation-journal adapter for the qualified Base runner. All
 * records are in the same private owner database; no send lease expires. */
export class LocalOperationJournal {
  constructor(ledger) {
    this.ledger = ledger;
  }
  async initialize() {}
  id(id) {
    if (!/^[0-9a-f]{64}$/.test(id)) throw Error("invalid operation");
    return "op:" + id;
  }
  async get(id) {
    const v = await this.ledger.get(this.id(id));
    if (!v) return;
    const { sendToken, ...visible } = v;
    return visible;
  }
  async plan(input) {
    this.id(input.operationId);
    if (
      !["claim", "settle"].includes(input.kind) ||
      !/^[0-9a-f]{64}$/.test(input.payloadDigest) ||
      input.scope?.network !== "eip155:8453" ||
      ![input.scope.receiver, input.scope.token].every((x) =>
        /^0x[0-9a-f]{40}$/.test(x),
      )
    )
      throw Error("invalid plan");
    const plan = structuredClone(input);
    await this.ledger.once(this.id(input.operationId), {
      ...plan,
      state: "planned",
      events: [{ state: "planned", at: new Date().toISOString() }],
    });
    const current = await this.get(input.operationId);
    for (const k of ["operationId", "kind", "scope", "payloadDigest"])
      if (canonical(current[k]) !== canonical(plan[k]))
        throw Error("immutable operation conflict");
    return current;
  }
  change(id, mutator) {
    const db = this.ledger.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const key = this.id(id),
        row = db
          .prepare("SELECT value FROM stages WHERE campaign=? AND stage=?")
          .get(this.ledger.campaignId, key);
      if (!row) throw Error("operation missing");
      const current = JSON.parse(row.value),
        result = mutator(current);
      if (result)
        db.prepare(
          "UPDATE stages SET value=? WHERE campaign=? AND stage=?",
        ).run(checked(current), this.ledger.campaignId, key);
      db.exec("COMMIT");
      return result;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  async acquire(id) {
    return this.change(id, (current) => {
      if (current.state !== "planned") return;
      current.state = "inflight";
      current.sendToken = randomUUID();
      current.events.push({ state: "inflight", at: new Date().toISOString() });
      return {
        operationId: current.operationId,
        kind: current.kind,
        scope: current.scope,
        payloadDigest: current.payloadDigest,
        sendToken: current.sendToken,
      };
    });
  }
  proof(input) {
    if (
      !/^[0-9a-f]{64}$/.test(input.evidenceDigest) ||
      (input.transactionHash !== undefined &&
        !/^0x[0-9a-f]{64}$/.test(input.transactionHash))
    )
      throw Error("invalid evidence");
    if (
      input.status === "chain_confirmed" &&
      (!input.transactionHash ||
        !/^0x[0-9a-f]{64}$/.test(input.blockHash) ||
        !Number.isSafeInteger(input.blockNumber) ||
        input.blockNumber < 0)
    )
      throw Error("chain evidence required");
  }
  async recordOutcome(id, token, input) {
    this.proof(input);
    if (!["provider_ack", "failed", "unknown"].includes(input.status))
      throw Error("invalid outcome");
    this.change(id, (current) => {
      if (current.sendToken !== token || current.state !== "inflight")
        throw Error("outcome already recorded");
      current.state = input.status;
      current.events.push({
        ...input,
        state: input.status,
        at: new Date().toISOString(),
      });
      return true;
    });
    return this.get(id);
  }
  async reconcile(id, input) {
    this.proof(input);
    if (!["chain_confirmed", "not_executed"].includes(input.status))
      throw Error("invalid reconciliation");
    this.change(id, (current) => {
      if (
        !["inflight", "provider_ack", "failed", "unknown"].includes(
          current.state,
        )
      )
        throw Error("cannot reconcile");
      current.state = input.status;
      current.events.push({
        ...input,
        state: input.status,
        at: new Date().toISOString(),
      });
      return true;
    });
    return this.get(id);
  }
}
