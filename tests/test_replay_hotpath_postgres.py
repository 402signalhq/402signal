"""Sharded replay counters and the per-process pool against disposable loopback PostgreSQL only."""

from __future__ import annotations

import concurrent.futures
import multiprocessing
import os
import re
import time
import unittest
from pathlib import Path

from live402.replay_postgres import PostgresStore
from live402.replay_store import StoreError
from test_replay_storage import AUTHORITY, KEY, SCOPE, pg_contender

ROOT = Path(__file__).resolve().parents[1]
FUNCTIONS_SQL = ROOT / "ops" / "replay-postgres-functions.sql"
EXPIRY_SQL = ROOT / "ops" / "replay-postgres-identity-expiry.sql"
FENCE_SQL = ROOT / "ops" / "replay-postgres-fence.sql"
HOTPATH_SQL = ROOT / "ops" / "replay-postgres-hotpath.sql"
ADMIT_SQL = ROOT / "ops" / "replay-postgres-admit-shard-invoker.sql"
PASSWORD = "isolated-fixture-only"


def shard_of(key: str) -> int:
    return int(key[:2], 16) % 16


class HotpathSqlShape(unittest.TestCase):
    def test_installs_without_grant_or_revoke(self):
        code = "\n".join(line.split("--", 1)[0] for line in HOTPATH_SQL.read_text(encoding="utf-8").splitlines())
        self.assertIsNone(re.search(r"\b(GRANT|REVOKE)\b", code, re.IGNORECASE))

    def test_never_rewrites_identities_or_authority_limits(self):
        code = HOTPATH_SQL.read_text(encoding="utf-8")
        self.assertNotRegex(code, r"(?i)(DELETE FROM|INSERT INTO)\s+signal_replay\.authority\b")
        self.assertNotRegex(code, r"(?i)UPDATE\s+signal_replay\.authority\s+SET\s+(max_rows|max_bytes|active|authority_id)")
        self.assertIn("upgrade_writers_stopped", code)


@unittest.skipUnless(os.environ.get("LIVE402_PG_TEST_DESTRUCTIVE") == "isolated-ci-only",
                     "requires disposable loopback PostgreSQL")
class ReplayHotpathPostgres(unittest.TestCase):
    def setUp(self):
        import psycopg
        from psycopg.conninfo import conninfo_to_dict, make_conninfo

        cfg = conninfo_to_dict(os.environ["LIVE402_PG_TEST_DSN"])
        if cfg.get("host") != "127.0.0.1" or cfg.get("dbname") != "402signal_ci":
            raise RuntimeError("refusing destructive tests outside loopback CI")
        self.psycopg = psycopg
        self.admin = psycopg.connect(**cfg, autocommit=True)
        self.admin.execute("DROP SCHEMA IF EXISTS signal_replay CASCADE")
        if not self.admin.execute("SELECT 1 FROM pg_roles WHERE rolname='managed_runtime'").fetchone():
            self.admin.execute("CREATE ROLE managed_runtime LOGIN PASSWORD '%s'" % PASSWORD)
            self.admin.execute("GRANT pg_read_all_data TO managed_runtime")
        self.runtime_dsn = make_conninfo(**dict(cfg, user="managed_runtime", password=PASSWORD))
        self.settings = {
            "LIVE402_PG_TEST_SUPPORT": "1",
            "LIVE402_REPLAY_AUTHORITY_ID": AUTHORITY,
            "LIVE402_REPLAY_POSTGRES_DSN": self.runtime_dsn,
            "LIVE402_REPLAY_POSTGRES_API": "functions-v1",
        }
        self.admin.execute(FUNCTIONS_SQL.read_text(encoding="utf-8"))
        self.admin.execute(
            "INSERT INTO signal_replay.authority VALUES(TRUE,%s,1,TRUE,TRUE,0,1000,268435456,%s)",
            (AUTHORITY, "0" * 64))
        self.admin.execute(
            "INSERT INTO signal_replay.runtime_policy VALUES(TRUE,%s,'managed_runtime',"
            "(extract(epoch FROM pg_postmaster_start_time())*1000000)::bigint,inet_server_addr())",
            (AUTHORITY,))
        self.admin.execute(EXPIRY_SQL.read_text(encoding="utf-8"))
        self.admin.execute(FENCE_SQL.read_text(encoding="utf-8"))
        self.store = PostgresStore(environ=self.settings)
        self.runtime = psycopg.connect(self.runtime_dsn, autocommit=True)

    def tearDown(self):
        self.store.close()
        self.runtime.close()
        self.admin.close()

    def _install(self):
        self.admin.execute("SET live402.upgrade_writers_stopped='1'")
        try:
            self.admin.execute(HOTPATH_SQL.read_text(encoding="utf-8"))
        finally:
            self.admin.execute("RESET live402.upgrade_writers_stopped")
        self.store.close()
        self.store = PostgresStore(environ=self.settings)

    def _shards(self):
        return self.admin.execute(
            "SELECT shard, admitted, outcome_bytes, max_rows, max_bytes FROM signal_replay.authority_shard ORDER BY shard"
        ).fetchall()

    def _totals(self):
        return self.admin.execute(
            "SELECT coalesce(sum(admitted),0), coalesce(sum(outcome_bytes),0) FROM signal_replay.authority_shard"
        ).fetchone()

    def _entries(self):
        return self.admin.execute(
            "SELECT count(*), coalesce(sum(octet_length(outcome_json)),0) FROM signal_replay.entries").fetchone()

    def _fence(self):
        cur = self.admin.execute("SELECT * FROM signal_replay.fence_status()")
        return dict(zip([column.name for column in cur.description], cur.fetchone()))

    def test_migration_refuses_without_the_writers_stopped_assertion(self):
        with self.assertRaises(self.psycopg.Error):
            self.admin.execute(HOTPATH_SQL.read_text(encoding="utf-8"))
        self.admin.execute("ROLLBACK")
        self.assertIsNone(self.admin.execute("SELECT to_regclass('signal_replay.authority_shard')").fetchone()[0])
        self.assertTrue(self.store.ready())

    def test_migration_refuses_inconsistent_counters_and_splits_quotas_exactly(self):
        self.assertTrue(self.store.reserve(KEY, SCOPE, time.time() + 120))
        self.store.finish(KEY, "settled", "private", True)
        self.admin.execute("UPDATE signal_replay.authority SET admitted = admitted + 1")
        self.admin.execute("SET live402.upgrade_writers_stopped='1'")
        with self.assertRaises(self.psycopg.Error):
            self.admin.execute(HOTPATH_SQL.read_text(encoding="utf-8"))
        self.admin.execute("ROLLBACK")
        self.admin.execute("UPDATE signal_replay.authority SET admitted = admitted - 1, max_rows = 1003")
        self.admin.execute("RESET live402.upgrade_writers_stopped")
        self._install()
        shards = self._shards()
        self.assertEqual(len(shards), 16)
        self.assertEqual(sum(row[3] for row in shards), 1003)
        self.assertEqual(sum(row[4] for row in shards), 268435456)
        self.assertEqual(sum(row[1] for row in shards), 1)
        self.assertEqual(sum(row[2] for row in shards), 7)
        self.assertEqual(shards[shard_of(KEY)][1:3], (1, 7))
        self.assertEqual(self._fence()["counters_consistent"], True)
        self.assertEqual(self._fence()["admitted_count"], 1)
        # The migration is idempotent once the shards exist.
        self._install()
        self.assertEqual(self._shards(), shards)
        self.assertTrue(self.store.ready())

    def test_lifecycle_keeps_shard_totals_equal_to_the_entries_table(self):
        self._install()
        self.assertTrue(self.store.ready())
        self.assertTrue(self.store.reserve(KEY, SCOPE, time.time() + 120, authorization_expires=time.time() + 60))
        self.assertFalse(self.store.reserve(KEY, SCOPE, time.time() + 120))
        self.store.finish(KEY, "settled", "private response", True)
        self.assertEqual(self.store.lookup(KEY)[:2], ("settled", "private response"))
        self.assertEqual(self._totals(), self._entries())
        self.assertEqual(self._totals(), (1, 16))
        # The frozen authority counters are no longer maintained.
        self.assertEqual(self.admin.execute("SELECT admitted, outcome_bytes FROM signal_replay.authority").fetchone(), (0, 0))
        self.assertEqual(self.store.capacity(), (1, 1000, 268435456, 16))
        self.assertTrue(self._fence()["counters_consistent"])
        self.admin.execute("UPDATE signal_replay.authority_shard SET outcome_bytes = outcome_bytes + 1 WHERE shard = %s",
                           (shard_of(KEY),))
        self.assertFalse(self._fence()["counters_consistent"])

    def test_capacity_is_enforced_per_shard_and_readiness_needs_one_open_shard(self):
        self._install()
        key_a = "00" + "a" * 62
        key_b = "00" + "b" * 62
        key_c = "01" + "c" * 62
        self.assertEqual((shard_of(key_a), shard_of(key_b), shard_of(key_c)), (0, 0, 1))
        self.admin.execute("UPDATE signal_replay.authority_shard SET max_rows = 1 WHERE shard = 0")
        self.assertTrue(self.store.reserve(key_a, SCOPE, time.time() + 120))
        with self.assertRaises(StoreError):
            self.store.reserve(key_b, SCOPE, time.time() + 120)
        self.assertIsNone(self.store.lookup(key_b))
        self.assertTrue(self.store.reserve(key_c, SCOPE, time.time() + 120))
        self.assertTrue(self.store.ready())
        self.admin.execute("UPDATE signal_replay.authority_shard SET max_rows = admitted")
        self.assertFalse(self.store.ready())
        with self.assertRaises(StoreError):
            self.store.reserve("02" + "d" * 62, SCOPE, time.time() + 120)
        self.assertEqual(self._totals()[0], 2)
        self.assertEqual(self.store.capacity()[0], 2)

    def test_byte_quota_is_enforced_per_shard_without_rejecting_completion(self):
        self._install()
        self.admin.execute("UPDATE signal_replay.authority_shard SET max_bytes = 512 + 8 WHERE shard = 0")
        key = "00" + "e" * 62
        self.assertTrue(self.store.reserve(key, SCOPE, time.time() + 120))
        self.store.finish(key, "settled", "x" * 9, True)
        self.assertEqual(self.store.lookup(key)[:2], ("settled", None))
        self.assertEqual(self._shards()[0][2], 0)
        other = "01" + "f" * 62
        self.assertEqual(shard_of(other), 1)
        self.assertTrue(self.store.reserve(other, SCOPE, time.time() + 120))
        self.store.finish(other, "settled", "x" * 9, True)
        self.assertEqual(self.store.lookup(other)[:2], ("settled", "x" * 9))

    def test_prune_and_expiry_apply_deltas_to_every_shard(self):
        self._install()
        keys = ["%02x" % (i * 17) + "0" * 62 for i in range(16)]
        past = time.time() - 7200
        for key in keys:
            self.assertTrue(self.store.reserve(key, SCOPE, time.time() + 120, authorization_expires=past))
            self.store.finish(key, "settled", "body-" + key[:2], True)
        self.assertEqual(self._totals(), (16, 16 * 7))
        self.assertEqual(sorted(row[1] for row in self._shards()), [1] * 16)
        self.admin.execute("UPDATE signal_replay.entries SET expires_at = 0 WHERE fp_hash < %s", (keys[8],))
        self.store.last_prune = 0
        self.store.prune_outcomes()
        self.assertEqual(self._totals(), self._entries())
        self.assertEqual(self._totals()[1], 8 * 7)
        self.assertEqual(self.store.expire_identities(5), 5)
        self.assertEqual(self._totals(), self._entries())
        self.assertEqual(self._totals()[0], 11)
        self.assertEqual(self.store.expire_identities(), 11)
        self.assertEqual(self._totals(), (0, 0))
        self.assertTrue(self._fence()["counters_consistent"])
        self.assertTrue(self.store.ready())

    def test_concurrent_admissions_use_the_pool_and_stay_exact(self):
        self._install()
        # Four identities per shard; one shard alone could not hold them all.
        keys = ["%02x" % i + "%062x" % (i + 1) for i in range(64)]
        self.assertEqual(sorted({shard_of(key) for key in keys}), list(range(16)))
        settings = dict(self.settings, LIVE402_REPLAY_POOL_SIZE="6")
        store = PostgresStore(environ=settings)
        pids = set()
        try:
            def admit(key):
                self.assertTrue(store.reserve(key, SCOPE, time.time() + 120, authorization_expires=time.time() + 60))
                store.finish(key, "settled", None, False)
                return True
            with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
                self.assertEqual(list(pool.map(admit, keys)), [True] * 64)
            for slot in store.idle:
                pids.add(slot.conn.info.backend_pid)
            self.assertLessEqual(len(store.idle), 6)
            self.assertGreaterEqual(len(pids), 2)
        finally:
            store.close()
        self.assertEqual(store.idle, [])
        self.assertEqual(store.open_count, 0)
        self.assertEqual(self._totals(), (64, 0))
        self.assertEqual(self._entries(), (64, 0))
        self.assertTrue(self._fence()["counters_consistent"])

    def test_four_process_duplicate_has_one_winner_on_shards(self):
        self._install()
        ctx = multiprocessing.get_context("spawn")
        event = ctx.Event()
        queue = ctx.Queue()
        jobs = [ctx.Process(target=pg_contender, args=(self.settings, event, queue)) for _ in range(4)]
        for job in jobs:
            job.start()
        event.set()
        results = [queue.get(timeout=20) for _ in jobs]
        for job in jobs:
            job.join(10)
            self.assertEqual(job.exitcode, 0)
        self.assertEqual(results.count(True), 1)
        self.assertEqual(self._totals()[0], 1)

    def test_server_error_discards_only_the_failing_connection(self):
        self._install()
        with self.assertRaises(StoreError):
            self.store.reserve(KEY, SCOPE, -1)
        self.assertIsNone(self.store.conn)
        self.assertEqual(self.store.open_count, 0)
        self.assertTrue(self.store.reserve(KEY, SCOPE, time.time() + 120))
        self.assertIsNotNone(self.store.conn)
        self.assertEqual(self.store.open_count, 1)

    def test_pool_wait_fails_closed_instead_of_queueing_forever(self):
        from unittest.mock import patch
        self._install()
        store = PostgresStore(environ=dict(self.settings, LIVE402_REPLAY_POOL_SIZE="1"))
        try:
            with store._checkout():
                with patch("live402.replay_postgres.POOL_WAIT", 0.2):
                    started = time.monotonic()
                    with self.assertRaises(StoreError):
                        store.lookup(KEY)
                    self.assertLess(time.monotonic() - started, 5)
            self.assertIsNone(store.lookup(KEY))
        finally:
            store.close()

    def test_runtime_login_cannot_touch_shards_and_shard_drift_fences(self):
        self._install()
        for query in ["UPDATE signal_replay.authority_shard SET max_rows = 99999",
                      "DELETE FROM signal_replay.authority_shard",
                      "INSERT INTO signal_replay.authority_shard VALUES (16, 0, 0, 1, 1)"]:
            with self.subTest(query=query), self.assertRaises(self.psycopg.errors.InsufficientPrivilege):
                self.runtime.execute(query)
        self.assertTrue(self.store.ready())
        self.admin.execute("GRANT UPDATE(admitted) ON signal_replay.authority_shard TO managed_runtime")
        self.store.close()
        self.assertFalse(self.store.ready())
        with self.assertRaises(StoreError):
            self.store.reserve(KEY, SCOPE, time.time() + 120)
        self.admin.execute("REVOKE UPDATE(admitted) ON signal_replay.authority_shard FROM managed_runtime")
        self.assertTrue(self.store.ready())
        self.admin.execute("DELETE FROM signal_replay.authority_shard WHERE shard = 15")
        self.assertFalse(self.store.ready())
        with self.assertRaises(StoreError):
            self.store.reserve(KEY, SCOPE, time.time() + 120)
        self.assertEqual(self._entries()[0], 0)

    def test_reader_cannot_move_shard_counters_through_the_admit_helper(self):
        """Security review 2026-09-14, finding 2: the internal helper must not be a side door."""
        self._install()
        self.assertTrue(self.store.reserve(KEY, SCOPE, time.time() + 120))
        before = self._totals()
        with self.assertRaises(self.psycopg.errors.InsufficientPrivilege):
            self.runtime.execute("SELECT signal_replay.api_admit_shard(%s)", ("ab" * 32,))
        self.assertEqual(self._totals(), before)
        self.assertEqual(self.admin.execute(
            "SELECT prosecdef FROM pg_proc WHERE oid = 'signal_replay.api_admit_shard(text)'::regprocedure"
        ).fetchone()[0], False)
        # The standalone re-apply file is idempotent and leaves the guarded path working.
        self.admin.execute(ADMIT_SQL.read_text(encoding="utf-8"))
        with self.assertRaises(self.psycopg.errors.InsufficientPrivilege):
            self.runtime.execute("SELECT signal_replay.api_admit_shard(%s)", ("cd" * 32,))
        self.assertTrue(self.store.reserve("e" * 64, SCOPE, time.time() + 120))
        self.assertEqual(self._totals()[0], before[0] + 1)
        self.assertEqual(self._entries()[0], 2)
        self.assertTrue(self._fence()["counters_consistent"])

    def test_fence_still_serializes_with_admission_and_repins_a_restart(self):
        self._install()
        self.assertTrue(self.store.reserve(KEY, SCOPE, time.time() + 120))
        self.store.finish(KEY, "settled", None, False)
        self.admin.execute("UPDATE signal_replay.runtime_policy SET instance_start_us = instance_start_us - 1000000")
        self.admin.execute("UPDATE signal_replay.instance_evidence SET instance_start_us = instance_start_us - 1000000")
        self.store.close()
        self.assertFalse(self.store.ready())
        with self.assertRaises(StoreError):
            self.store.reserve("d" * 64, SCOPE, time.time() + 120)
        self.assertEqual(self._fence()["classification"], "restart")
        self.assertEqual(self.admin.execute("SELECT signal_replay.fence_repin('restart')").fetchone()[0], "restart_repin")
        self.assertTrue(self.store.ready())
        self.assertEqual(self._totals()[0], 1)


if __name__ == "__main__":
    unittest.main()
