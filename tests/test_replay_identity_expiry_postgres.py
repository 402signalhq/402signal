"""Replay identity expiry against disposable loopback PostgreSQL only."""

from __future__ import annotations

import os
import time
import unittest
from pathlib import Path

from live402.replay_postgres import PostgresStore
from test_replay_storage import AUTHORITY, KEY, SCOPE

ROOT = Path(__file__).resolve().parents[1]
FUNCTIONS_SQL = ROOT / "ops" / "replay-postgres-functions.sql"
EXPIRY_SQL = ROOT / "ops" / "replay-postgres-identity-expiry.sql"


@unittest.skipUnless(os.environ.get("LIVE402_PG_TEST_DESTRUCTIVE") == "isolated-ci-only",
                     "requires disposable loopback PostgreSQL")
class ReplayIdentityExpiryPostgres(unittest.TestCase):
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
            self.admin.execute("CREATE ROLE managed_runtime LOGIN PASSWORD 'isolated-fixture-only'")
            self.admin.execute("GRANT pg_read_all_data TO managed_runtime")
        self.runtime_dsn = make_conninfo(**dict(cfg, user="managed_runtime", password="isolated-fixture-only"))
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
        self.store = PostgresStore(environ=self.settings)
        self.runtime = psycopg.connect(self.runtime_dsn, autocommit=True)

    def tearDown(self):
        self.store.close()
        self.runtime.close()
        self.admin.close()

    def _install_expiry(self):
        self.admin.execute(EXPIRY_SQL.read_text(encoding="utf-8"))
        self.store.close()
        self.store = PostgresStore(environ=self.settings)

    def _counters(self):
        return self.admin.execute("SELECT admitted, outcome_bytes FROM signal_replay.authority").fetchone()

    def _entries(self):
        return self.admin.execute("SELECT count(*) FROM signal_replay.entries").fetchone()[0]

    def test_without_the_migration_reservation_is_unchanged_and_expiry_is_a_noop(self):
        self.assertTrue(self.store.reserve(KEY, SCOPE, time.time() + 120, authorization_expires=time.time() - 7200))
        self.store.finish(KEY, "settled", None, False)
        self.assertEqual(self.store.expire_identities(), 0)
        self.assertEqual(self._counters()[0], 1)
        self.assertTrue(self.store.ready())

    def test_expired_terminal_identities_are_dropped_and_counters_stay_consistent(self):
        self._install_expiry()
        self.assertTrue(self.store.ready())
        past = time.time() - 7200
        keys = {"settled": "a" * 64, "not_settled": "b" * 64, "rejected": "c" * 64}
        for state, key in keys.items():
            self.assertTrue(self.store.reserve(key, SCOPE, time.time() + 120, authorization_expires=past))
            self.store.finish(key, state, "cached", True)
        self.assertEqual(self._counters(), (3, 18))
        self.assertEqual(self.store.expire_identities(), 3)
        self.assertEqual(self._counters(), (0, 0))
        self.assertEqual(self._entries(), 0)
        self.assertTrue(self.store.ready())
        # A dropped identity may be admitted again; the chain refuses settlement after expiry.
        self.assertTrue(self.store.reserve(keys["settled"], SCOPE, time.time() + 120, authorization_expires=past))

    def test_pending_unknown_unexpired_margin_and_unknown_expiry_are_kept(self):
        self._install_expiry()
        now = time.time()
        self.assertTrue(self.store.reserve("d" * 64, SCOPE, now + 120, authorization_expires=now - 7200))
        self.assertTrue(self.store.reserve("e" * 64, SCOPE, now + 120, authorization_expires=now - 7200))
        self.store.abandon("e" * 64)
        self.assertTrue(self.store.reserve("f" * 64, SCOPE, now + 120, authorization_expires=now + 7200))
        self.store.finish("f" * 64, "settled", None, False)
        self.assertTrue(self.store.reserve("1" * 64, SCOPE, now + 120))
        self.store.finish("1" * 64, "settled", None, False)
        self.assertTrue(self.store.reserve("2" * 64, SCOPE, now + 120, authorization_expires=now - 1800))
        self.store.finish("2" * 64, "rejected", None, False)
        self.assertEqual(self.store.expire_identities(), 0)
        self.assertEqual(self._counters()[0], 5)
        self.assertEqual(self._entries(), 5)

    def test_runtime_login_still_cannot_delete_or_forge_expiry(self):
        self._install_expiry()
        self.assertTrue(self.store.reserve(KEY, SCOPE, time.time() + 120, authorization_expires=time.time() - 7200))
        with self.assertRaises(self.psycopg.errors.InsufficientPrivilege):
            self.runtime.execute("DELETE FROM signal_replay.entries")
        with self.assertRaises(self.psycopg.Error):
            self.runtime.execute("SELECT signal_replay.api_expire_identities(%s,%s)", ("d" * 32, 10))
        self.assertEqual(self._entries(), 1)
        self.assertTrue(self.store.ready())


if __name__ == "__main__":
    unittest.main()
