import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { BaseBatchLedger } from "../src/base-batch-ledger.js";
import { PostgresChannelStorage } from "../src/batch-postgres-storage.js";
import { BaseBatchMerchant } from "../src/base-batch-merchant.js";

test(
  "runtime schema checks use a restricted login, do not issue DDL, and fail closed",
  { skip: !process.env.LAB_BATCH_PG_DATABASE },
  async (t) => {
    assert.match(process.env.LAB_BATCH_PG_DATABASE!, /^lab_batch_/);
    const suffix = randomUUID().replaceAll("-", "");
    const database = "lab_batch_ready_" + suffix;
    const role = "lab_ready_" + suffix;
    // Independent disposable login credential; never inherit the admin password.
    const runtimePassword = randomUUID().replaceAll("-", "");
    const config = {
      host: process.env.LAB_BATCH_PG_HOST,
      port: Number(process.env.LAB_BATCH_PG_PORT),
      user: process.env.LAB_BATCH_PG_USER,
      max: 2,
    };
    // Dedicated disposable synthetic database, never the app's configured live URL.
    const admin = new Pool({
      ...config,
      database: process.env.LAB_BATCH_PG_DATABASE,
    });
    let migration: Pool | undefined, runtime: Pool | undefined;
    try {
      await admin.query(
        `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '${runtimePassword}'`,
      );
      await admin.query(`CREATE DATABASE ${database}`);
      migration = new Pool({ ...config, database });
      await migration.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
      await migration.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
      await migration.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
      await migration.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await new BaseBatchLedger(migration, "ready-migration").initialize();
      await new PostgresChannelStorage(
        migration,
        "ready:migration",
      ).initialize();
      await migration.query(
        `GRANT SELECT, INSERT, UPDATE ON public.lab_base_batch_stages_v1 TO ${role}`,
      );
      await migration.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON public.lab_batch_channels_v1 TO ${role}`,
      );
      runtime = new Pool({
        ...config,
        user: role,
        database,
        password: runtimePassword,
      });
      if (config.host && !config.host.startsWith("/")) {
        await t.test(
          "TCP runtime login requires its own password",
          async () => {
            const wrongPassword = new Pool({
              ...config,
              user: role,
              database,
              password: runtimePassword + "invalid",
            });
            try {
              await assert.rejects(
                wrongPassword.query("SELECT 1"),
                /password authentication failed/,
              );
            } finally {
              await wrongPassword.end();
            }
            assert.equal(
              (await runtime!.query("SELECT current_user AS role")).rows[0]
                .role,
              role,
            );
          },
        );
      }
      const statements: string[] = [];
      const checked = {
        query: async (sql: string, args?: unknown[]) => {
          statements.push(sql);
          return runtime!.query(sql, args);
        },
      } as unknown as Pool;
      const ledger = new BaseBatchLedger(checked, "ready-runtime");
      const storage = new PostgresChannelStorage(checked, "ready:runtime");
      await t.test(
        "exact DML permissions accept durable schema using SELECT only",
        async () => {
          await ledger.assertReady();
          await storage.assertReady();
          assert.equal(statements.length, 2);
          assert.ok(statements.every((sql) => /^SELECT\s/.test(sql)));
          assert.equal(
            (
              await runtime!.query(
                "SELECT current_user = session_user AS direct",
              )
            ).rows[0].direct,
            true,
          );
          await ledger.bind({ synthetic: true });
          assert.deepEqual(await ledger.require("plan"), { synthetic: true });
          await ledger.once("progress", { state: "new" });
          await ledger.transition("new", "done");
          await assert.rejects(
            runtime!.query("CREATE TABLE public.unauthorized (id int)"),
            /permission denied/,
          );
          await assert.rejects(
            runtime!.query("CREATE TEMP TABLE unauthorized (id int)"),
            /permission denied/,
          );
          await assert.rejects(
            runtime!.query("TRUNCATE public.lab_base_batch_stages_v1"),
            /permission denied/,
          );
          await assert.rejects(
            runtime!.query(
              "DELETE FROM public.lab_base_batch_stages_v1 WHERE false",
            ),
            /permission denied/,
          );
        },
      );
      await t.test(
        "missing required privilege and excess write privilege are refused",
        async () => {
          await migration!.query(
            `REVOKE INSERT ON public.lab_base_batch_stages_v1 FROM ${role}`,
          );
          await assert.rejects(ledger.assertReady(), /refused/);
          await migration!.query(
            `GRANT INSERT, DELETE ON public.lab_base_batch_stages_v1 TO ${role}`,
          );
          await assert.rejects(ledger.assertReady(), /refused/);
          await migration!.query(
            `REVOKE DELETE ON public.lab_base_batch_stages_v1 FROM ${role}`,
          );
          await ledger.assertReady();
        },
      );
      await t.test(
        "migration/admin role, inherited global reader, and schema creation are refused",
        async () => {
          await assert.rejects(
            new BaseBatchLedger(migration!, "ready-admin").assertReady(),
            /refused/,
          );
          await migration!.query(`GRANT pg_read_all_data TO ${role}`);
          await assert.rejects(ledger.assertReady(), /refused/);
          await migration!.query(`REVOKE pg_read_all_data FROM ${role}`);
          await migration!.query(`GRANT CREATE ON SCHEMA public TO ${role}`);
          await assert.rejects(ledger.assertReady(), /refused/);
          await migration!.query(`REVOKE CREATE ON SCHEMA public FROM ${role}`);
          await ledger.assertReady();
        },
      );
      await t.test(
        "unsafe commit settings and missing constraints are refused",
        async () => {
          const client = await runtime!.connect();
          try {
            await client.query("SET synchronous_commit = off");
            await assert.rejects(
              new BaseBatchLedger(
                client as unknown as Pool,
                "ready-unsafe",
              ).assertReady(),
              /refused/,
            );
            await client.query("SET synchronous_commit = on");
          } finally {
            client.release();
          }
          await migration!.query(
            "ALTER TABLE public.lab_base_batch_stages_v1 DROP CONSTRAINT lab_base_batch_stages_v1_value_check",
          );
          await assert.rejects(ledger.assertReady(), /refused/);
          await migration!.query(
            "ALTER TABLE public.lab_base_batch_stages_v1 ADD CHECK(octet_length(value::text)<=65536)",
          );
          await ledger.assertReady();
        },
      );
      await t.test(
        "real Base merchant default startup and reopen need no migration permission",
        async () => {
          const address = "0x" + "11".repeat(20),
            authorizer = "0x" + "33".repeat(20);
          let providerCalls = 0;
          const provider: any = {
            getSupported: async () => {
              providerCalls++;
              return {
                kinds: [
                  {
                    x402Version: 2,
                    scheme: "batch-settlement",
                    network: "eip155:8453",
                    extra: { receiverAuthorizer: authorizer },
                  },
                ],
                extensions: [],
                signers: {},
              };
            },
          };
          const cfg: any = {
            version: 1,
            campaignId: "runtime-ready",
            url: "https://merchant.example/base/batch/sha256",
            channelConfig: {
              payer: address,
              payerAuthorizer: address,
              receiver: "0x" + "22".repeat(20),
              receiverAuthorizer: authorizer,
              token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              withdrawDelay: 900,
              salt: "0x" + "44".repeat(32),
            },
            perCallAtomic: "1000",
            maxCalls: 2,
            expiresAt: Date.now() + 3600000,
          };
          const merchant = new BaseBatchMerchant(runtime!, cfg, provider);
          await merchant.initialize();
          assert.equal((await merchant.request(cfg.url)).status, 402);
          await new BaseBatchMerchant(runtime!, cfg, provider).initialize();
          assert.equal(providerCalls, 2);
          await migration!.query("DROP TABLE public.lab_base_batch_stages_v1");
          await assert.rejects(
            new BaseBatchMerchant(runtime!, cfg, provider).initialize(),
            /refused/,
          );
          assert.equal(
            providerCalls,
            2,
            "schema refusal precedes provider or campaign writes",
          );
          assert.equal(
            (
              await migration!.query(
                "SELECT to_regclass('public.lab_base_batch_stages_v1') AS table_name",
              )
            ).rows[0].table_name,
            null,
          );
        },
      );
    } finally {
      await runtime?.end();
      await migration?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    }
  },
);
