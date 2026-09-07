import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Pool } from "pg";
import type { Channel } from "@x402/evm/batch-settlement/server";
import { PostgresChannelStorage } from "../src/batch-postgres-storage.js";

const database = process.env.LAB_BATCH_PG_DATABASE;
const config = { host: process.env.LAB_BATCH_PG_HOST ?? "/var/run/postgresql", database, user: process.env.LAB_BATCH_PG_USER ?? "root", connectionTimeoutMillis: 3000, max: 8 };
const id = `0x${"ab".repeat(32)}`;
function sample(channelId = id): Channel {
  return { channelId, channelConfig: { payer: `0x${"11".repeat(20)}`, payerAuthorizer: `0x${"22".repeat(20)}`,
    receiver: `0x${"33".repeat(20)}`, receiverAuthorizer: `0x${"44".repeat(20)}`, token: `0x${"55".repeat(20)}`,
    withdrawDelay: 600, salt: `0x${"66".repeat(32)}` }, chargedCumulativeAmount: "0", signedMaxClaimable: "1000000",
    signature: "0x", balance: "1000000", totalClaimed: "0", withdrawRequestedAt: 0, refundNonce: 0, lastRequestTimestamp: 0 };
}

test("PostgreSQL batch storage integration (explicit synthetic DB opt-in)", { skip: !database }, async t => {
  assert.match(database!, /^lab_batch_[a-z0-9_]+$/, "refuse non-lab database");
  const pool = new Pool(config);
  const peer = new Pool(config);
  const namespace = `test:${randomUUID()}`;
  const store = new PostgresChannelStorage(pool, namespace);
  const other = new PostgresChannelStorage(peer, namespace);
  await store.initialize();
  try {
    await t.test("persists across independent pools and reopened clients; records detached", async () => {
      assert.equal((await store.updateChannel(id, () => sample())).status, "updated");
      const fetched = (await other.get(id.toUpperCase().replace("0X", "0x")))!;
      fetched.balance = "1";
      assert.equal((await store.get(id))!.balance, "1000000");
      const reopened = new Pool(config);
      try { assert.equal((await new PostgresChannelStorage(reopened, namespace).get(id))!.balance, "1000000"); }
      finally { await reopened.end(); }
    });
    await t.test("atomic 100 competing updates across independent connections", async () => {
      let calls = 0;
      await Promise.all(Array.from({ length: 100 }, (_, i) => (i % 2 ? store : other).updateChannel(id, current => {
        calls++; return { ...current!, chargedCumulativeAmount: (BigInt(current!.chargedCumulativeAmount) + 1n).toString() };
      })));
      assert.equal(calls, 100);
      assert.equal((await store.get(id))!.chargedCumulativeAmount, "100");
    });
    await t.test("independent Node workers serialize against the same backend", async () => {
      const code = `import { Pool } from 'pg'; import { PostgresChannelStorage } from './dist/src/batch-postgres-storage.js';
        const pool=new Pool(JSON.parse(process.env.WORKER_PG_CONFIG));
        const s=new PostgresChannelStorage(pool,process.env.WORKER_NAMESPACE);
        for(let i=0;i<25;i++) await s.updateChannel(process.env.WORKER_ID,c=>({...c,chargedCumulativeAmount:(BigInt(c.chargedCumulativeAmount)+1n).toString()}));
        await pool.end();`;
      const run = promisify(execFile);
      await Promise.all([0, 1].map(() => run(process.execPath, ["--input-type=module", "-e", code], {
        env: { ...process.env, WORKER_PG_CONFIG: JSON.stringify(config), WORKER_NAMESPACE: namespace, WORKER_ID: id }, timeout: 15000,
      })));
      assert.equal((await store.get(id))!.chargedCumulativeAmount, "150");
    });
    await t.test("first insert race and namespace isolation", async () => {
      const fresh = `0x${"cd".repeat(32)}`;
      await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? store : other).updateChannel(fresh, c => {
        const row = c ?? sample(fresh); return { ...row, chargedCumulativeAmount: (BigInt(row.chargedCumulativeAmount) + 1n).toString() };
      })));
      assert.equal((await store.get(fresh))!.chargedCumulativeAmount, "20");
      assert.equal(await new PostgresChannelStorage(pool, `${namespace}:other`).get(fresh), undefined);
    });
    await t.test("same-object callback is unchanged; exceptions roll back exactly once", async () => {
      const unchanged = await store.updateChannel(id, c => { c!.balance = "2"; return c; });
      assert.equal(unchanged.status, "unchanged"); assert.equal(unchanged.channel!.balance, "1000000");
      let calls = 0;
      await assert.rejects(store.updateChannel(id, c => { calls++; c!.balance = "3"; throw new Error("synthetic callback failure"); }), /synthetic/);
      assert.equal(calls, 1); assert.equal((await store.get(id))!.balance, "1000000");
      assert.equal((await store.updateChannel(id, c => ({ ...c!, balance: "999999" }))).status, "updated");
    });
    await t.test("invalid records roll back and bounded identifiers reject before callbacks", async () => {
      let calls = 0;
      await assert.rejects(store.updateChannel("../../bad", () => { calls++; return sample(); }), /invalid channel id/);
      assert.equal(calls, 0);
      await assert.rejects(store.updateChannel(id, () => sample(`0x${"ff".repeat(32)}`)), /mismatch/);
      await assert.rejects(store.updateChannel(id, c => ({ ...c!, balance: "-1" })), /invalid channel state/);
      await assert.rejects(store.updateChannel(id, c => ({ ...c!, balance: (1n << 256n).toString() })), /invalid channel state/);
      await assert.rejects(store.updateChannel(id, c => ({ ...c!, signature: `0x${"ab".repeat(20000)}` })), /too large/);
      assert.equal((await store.get(id))!.balance, "999999");
      assert.throws(() => new PostgresChannelStorage(pool, "bad;sql"), /namespace/);
      await assert.rejects(new PostgresChannelStorage(pool, namespace, 1).list(), /list exceeds/);
    });
    await t.test("blocked lock times out before mutation callback and never retries", async () => {
      const blocker = await peer.connect();
      const lock = createHash("sha256").update(`${namespace}\0${id}`).digest().readBigInt64BE(0).toString();
      let calls = 0;
      try {
        await blocker.query("BEGIN"); await blocker.query("SELECT pg_advisory_xact_lock($1::bigint)", [lock]);
        await assert.rejects(store.updateChannel(id, c => { calls++; return c; }), /lock timeout/);
        assert.equal(calls, 0);
      } finally { await blocker.query("ROLLBACK"); blocker.release(); }
      assert.equal((await store.get(id))!.balance, "999999");
    });
    await t.test("uncertain COMMIT is surfaced without re-running economic callback", async () => {
      const uncertain = { connect: async () => {
        const client = await pool.connect();
        return {
          query: async (...args: any[]) => {
            const result = await (client.query as any)(...args);
            if (args[0] === "COMMIT") throw new Error("synthetic lost commit acknowledgement");
            return result;
          },
          release: (discard: boolean) => client.release(discard),
        };
      } } as unknown as Pool;
      let calls = 0;
      await assert.rejects(new PostgresChannelStorage(uncertain, namespace).updateChannel(id, c => {
        calls++; return { ...c!, chargedCumulativeAmount: "153" };
      }), /lost commit acknowledgement/);
      assert.equal(calls, 1);
      assert.equal((await other.get(id))!.chargedCumulativeAmount, "153", "read/reconcile committed outcome after acknowledgement failure");
    });
    await t.test("corrupt persisted state fails closed on reads", async () => {
      const corruptId = `0x${"ef".repeat(32)}`;
      await pool.query("INSERT INTO public.lab_batch_channels_v1(namespace,channel_id,record) VALUES($1,$2,$3::jsonb)",
        [namespace, corruptId, JSON.stringify({ ...sample(corruptId), balance: "bad" })]);
      await assert.rejects(store.get(corruptId), /invalid channel state/);
      await assert.rejects(store.list(), /invalid channel state/);
      await pool.query("DELETE FROM public.lab_batch_channels_v1 WHERE namespace=$1 AND channel_id=$2", [namespace, corruptId]);
    });
    await t.test("pending reservation survives reconnect; delete does not resurrect", async () => {
      await store.updateChannel(id, c => ({ ...c!, pendingRequest: { pendingId: "request-1", signedMaxClaimable: "3000", expiresAt: 99999 } }));
      assert.deepEqual((await other.get(id))!.pendingRequest, { pendingId: "request-1", signedMaxClaimable: "3000", expiresAt: 99999 });
      assert.equal((await other.updateChannel(id, () => undefined)).status, "deleted");
      assert.equal((await store.updateChannel(id, c => c)).status, "unchanged");
      assert.equal(await store.get(id), undefined);
    });
  } finally {
    await pool.query("DELETE FROM public.lab_batch_channels_v1 WHERE namespace=$1", [namespace]);
    await Promise.all([pool.end(), peer.end()]);
  }
});
