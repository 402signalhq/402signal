import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresBatchOperationJournal, type OperationPlan } from "../src/batch-operation-journal.js";

const database = process.env.LAB_BATCH_PG_DATABASE;
const config = { host: process.env.LAB_BATCH_PG_HOST ?? "/var/run/postgresql", database,
  user: process.env.LAB_BATCH_PG_USER ?? "root", connectionTimeoutMillis: 3000, max: 8 };
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const makePlan = (name: string): OperationPlan => ({ operationId: digest(name), kind: "claim", payloadDigest: digest(`payload:${name}`),
  scope: { network: "eip155:8453", receiver: `0x${"11".repeat(20)}`, token: `0x${"22".repeat(20)}` } });

test("PostgreSQL batch operation journal (explicit synthetic DB opt-in)", { skip: !database }, async t => {
  assert.match(database!, /^lab_batch_[a-z0-9_]+$/, "refuse non-lab database");
  const pool = new Pool(config); const peer = new Pool(config);
  const namespace = `journal:${randomUUID()}`;
  const journal = new PostgresBatchOperationJournal(pool, namespace);
  const other = new PostgresBatchOperationJournal(peer, namespace);
  await journal.initialize();
  try {
    await t.test("concurrent planning is idempotent; immutable digest and scope conflict", async () => {
      const plan = makePlan("race");
      const records = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? journal : other).plan(plan)));
      assert(records.every(row => row.state === "planned"));
      await assert.rejects(journal.plan({ ...plan, payloadDigest: digest("changed") }), /conflicts/);
      await assert.rejects(journal.plan({ ...plan, kind: "settle" }), /conflicts/);
      await assert.rejects(journal.plan({ ...plan, scope: { ...plan.scope, network: "eip155:84532" } }), /conflicts/);
    });
    await t.test("one send permit across 40 competing independent connections", async () => {
      const plan = makePlan("race");
      const permits = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? journal : other).acquire(plan.operationId)));
      assert.equal(permits.filter(Boolean).length, 1);
      assert.equal(permits.find(Boolean)!.payloadDigest, plan.payloadDigest);
      assert.equal((await journal.get(plan.operationId))!.state, "inflight");
      assert.equal(await other.acquire(plan.operationId), undefined);
    });
    await t.test("restart after send permit never reacquires; explicit reconciliation records observation", async () => {
      const plan = makePlan("race");
      const restartedPool = new Pool(config);
      try {
        const restarted = new PostgresBatchOperationJournal(restartedPool, namespace);
        assert.equal(await restarted.acquire(plan.operationId), undefined);
        const result = await restarted.reconcile(plan.operationId, { status: "chain_confirmed", evidenceDigest: digest("receipt"),
          transactionHash: `0x${"33".repeat(32)}`, blockHash: `0x${"44".repeat(32)}`, blockNumber: 100 });
        assert.equal(result.state, "chain_confirmed");
        assert.equal(result.events.length, 3);
        assert.equal((await restarted.reconcile(plan.operationId, { status: "chain_confirmed", evidenceDigest: digest("receipt"),
          transactionHash: `0x${"33".repeat(32)}`, blockHash: `0x${"44".repeat(32)}`, blockNumber: 100 })).events.length, 3,
          "identical chain observation stays idempotent after JSONB field reordering");
        assert.equal(await restarted.acquire(plan.operationId), undefined);
      } finally { await restartedPool.end(); }
    });
    await t.test("provider acknowledgement remains distinct from chain confirmation", async () => {
      const plan = makePlan("ack"); await journal.plan(plan);
      const permit = (await journal.acquire(plan.operationId))!;
      const ack = { status: "provider_ack" as const, evidenceDigest: digest("ack"), transactionHash: `0x${"55".repeat(32)}` };
      assert.equal((await journal.recordOutcome(plan.operationId, permit.sendToken, ack)).state, "provider_ack");
      assert.equal((await other.recordOutcome(plan.operationId, permit.sendToken, ack)).events.length, 3, "repeat identical acknowledgement is idempotent");
      assert.equal(await journal.acquire(plan.operationId), undefined);
      await assert.rejects(journal.reconcile(plan.operationId, { status: "chain_confirmed", evidenceDigest: digest("missing-proof") }), /requires/);
      await assert.rejects(journal.recordOutcome(plan.operationId, "bad-token", ack), /send token/);
    });
    await t.test("failed and unknown outcomes never silently resend or reset after reconciliation", async () => {
      for (const status of ["failed", "unknown"] as const) {
        const plan = makePlan(status); await journal.plan(plan);
        const permit = (await journal.acquire(plan.operationId))!;
        await journal.recordOutcome(plan.operationId, permit.sendToken, { status, evidenceDigest: digest(status) });
        assert.equal(await other.acquire(plan.operationId), undefined);
        await other.reconcile(plan.operationId, { status: "not_executed", evidenceDigest: digest(`${status}:checked`) });
        assert.equal(await journal.acquire(plan.operationId), undefined);
        assert.equal((await journal.plan(plan)).state, "not_executed");
        await assert.rejects(journal.reconcile(plan.operationId, { status: "chain_confirmed", evidenceDigest: digest("conflict"),
          transactionHash: `0x${"66".repeat(32)}`, blockHash: `0x${"77".repeat(32)}`, blockNumber: 101 }), /cannot accept/);
      }
    });
    await t.test("lost permit commit acknowledgement leaves durable inflight and no new permit", async () => {
      const plan = makePlan("lost-ack"); await journal.plan(plan);
      const uncertain = { connect: async () => {
        const client = await pool.connect();
        return { query: async (...args: any[]) => {
          const result = await (client.query as any)(...args);
          if (args[0] === "COMMIT") throw new Error("synthetic lost commit acknowledgement");
          return result;
        }, release: (discard: boolean) => client.release(discard) };
      } } as unknown as Pool;
      await assert.rejects(new PostgresBatchOperationJournal(uncertain, namespace).acquire(plan.operationId), /lost commit acknowledgement/);
      assert.equal((await other.get(plan.operationId))!.state, "inflight");
      assert.equal(await journal.acquire(plan.operationId), undefined);
    });
    await t.test("bounded IDs, data and namespace isolation; no signed payload persisted", async () => {
      await assert.rejects(journal.plan({ ...makePlan("bad"), operationId: "../bad" }), /invalid/);
      await assert.rejects(journal.plan({ ...makePlan("bad"), payloadDigest: "private signed object" }), /invalid/);
      await assert.rejects(journal.acquire(digest("unplanned")), /not been planned/);
      assert.equal(await new PostgresBatchOperationJournal(pool, `${namespace}:other`).get(makePlan("ack").operationId), undefined);
      const row = (await journal.get(makePlan("ack").operationId))!;
      assert(!("sendToken" in row));
      assert(!("payload" in row));
      assert.equal(row.payloadDigest, makePlan("ack").payloadDigest);
    });
  } finally {
    await pool.query("DELETE FROM public.lab_batch_operations_v1 WHERE namespace=$1", [namespace]);
    await Promise.all([pool.end(), peer.end()]);
  }
});
