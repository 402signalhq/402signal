"""Transparency-leaf outbox functions against disposable loopback PostgreSQL only."""

from __future__ import annotations

import hashlib
import os
import re
import time
import unittest
from pathlib import Path

from live402.replay_postgres import PostgresStore
from live402.replay_store import StoreError
from test_replay_storage import AUTHORITY, KEY, SCOPE

ROOT = Path(__file__).resolve().parents[1]
FUNCTIONS_SQL = ROOT / "ops" / "replay-postgres-functions.sql"
OUTBOX_SQL = ROOT / "ops" / "replay-postgres-leaf-outbox.sql"
PASSWORD = "isolated-fixture-only"


def leaf_hash(body: bytes) -> bytes:
    return hashlib.sha256(b"\x00" + body).digest()


class OutboxSqlShape(unittest.TestCase):
    def test_installs_without_grant_or_revoke_and_never_touches_identities(self):
        code = "\n".join(line.split("--", 1)[0] for line in OUTBOX_SQL.read_text(encoding="utf-8").splitlines())
        self.assertIsNone(re.search(r"\b(GRANT|REVOKE)\b", code, re.IGNORECASE))
        self.assertNotRegex(code, r"(?i)(UPDATE|DELETE FROM|INSERT INTO)\s+signal_replay\.(entries|authority|authority_shard)\b")
        self.assertNotIn("upgrade_writers_stopped", code)


@unittest.skipUnless(os.environ.get("LIVE402_PG_TEST_DESTRUCTIVE") == "isolated-ci-only",
                     "requires disposable loopback PostgreSQL")
class ReplayLeafOutboxPostgres(unittest.TestCase):
    def setUp(self):
        import psycopg
        from psycopg.conninfo import conninfo_to_dict, make_conninfo

        cfg = conninfo_to_dict(os.environ["LIVE402_PG_TEST_DSN"])
        if cfg.get("host") != "127.0.0.1" or cfg.get("dbname") != "402signal_ci":
            raise RuntimeError("refusing destructive tests outside loopback CI")
        self.psycopg = psycopg
        self.admin = psycopg.connect(**cfg, autocommit=True)
        self.admin.execute("DROP SCHEMA IF EXISTS signal_replay CASCADE")
        for role in ("managed_runtime", "managed_other"):
            if not self.admin.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (role,)).fetchone():
                self.admin.execute(psycopg.sql.SQL("CREATE ROLE {} LOGIN PASSWORD %s").format(psycopg.sql.Identifier(role)), (PASSWORD,))
                self.admin.execute(psycopg.sql.SQL("GRANT pg_read_all_data TO {}").format(psycopg.sql.Identifier(role)))
        self.runtime_dsn = make_conninfo(**dict(cfg, user="managed_runtime", password=PASSWORD))
        self.other_dsn = make_conninfo(**dict(cfg, user="managed_other", password=PASSWORD))
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

    def _install(self):
        self.admin.execute(OUTBOX_SQL.read_text(encoding="utf-8"))
        self.store.close()
        self.store = PostgresStore(environ=self.settings)

    def _rows(self):
        return self.admin.execute(
            "SELECT id, appended_idx FROM signal_replay.leaf_outbox ORDER BY id").fetchall()

    def test_unsupported_before_the_migration(self):
        self.assertFalse(self.store.outbox_supported())
        self.assertEqual(self.store.outbox_pending(), [])
        self.assertEqual(self.store.outbox_depth(), (0, 0.0))
        with self.assertRaises(StoreError):
            self.store.outbox_put(b"x", leaf_hash(b"x"), "router-a")
        self.assertTrue(self.store.ready())

    def test_queue_drain_order_duplicates_and_prune(self):
        self._install()
        self.assertTrue(self.store.outbox_supported())
        bodies = [b'{"type":"402signal.route_decision.v3","n":%d}' % i for i in range(3)]
        first = self.store.outbox_put(bodies[0], leaf_hash(bodies[0]), "router-a")
        self.assertEqual((first["duplicate"], first["appended_idx"]), (False, None))
        second = self.store.outbox_put(bodies[1], leaf_hash(bodies[1]), "router-b")
        third = self.store.outbox_put(bodies[2], leaf_hash(bodies[2]), "router-a")
        again = self.store.outbox_put(bodies[0], leaf_hash(bodies[0]), "router-c")
        self.assertEqual((again["id"], again["duplicate"], again["appended_idx"]), (first["id"], True, None))
        self.assertEqual(self.store.outbox_depth()[0], 3)
        pending = self.store.outbox_pending(2)
        self.assertEqual([row[0] for row in pending], [first["id"], second["id"]])
        self.assertEqual(pending[0][1:], (leaf_hash(bodies[0]), bodies[0]))
        self.assertTrue(self.store.outbox_ack(first["id"], 40))
        self.assertFalse(self.store.outbox_ack(first["id"], 41))
        acked = self.store.outbox_put(bodies[0], leaf_hash(bodies[0]), "router-c")
        self.assertEqual((acked["duplicate"], acked["appended_idx"]), (True, 40))
        self.assertEqual([row[0] for row in self.store.outbox_pending()], [second["id"], third["id"]])
        self.assertTrue(self.store.outbox_ack(second["id"], 41))
        self.assertTrue(self.store.outbox_ack(third["id"], 42))
        self.assertEqual(self.store.outbox_depth(), (0, 0.0))
        self.assertEqual(self.store.outbox_prune(1), 0)
        self.admin.execute("UPDATE signal_replay.leaf_outbox SET appended_at = appended_at - interval '20 days' WHERE id = %s", (first["id"],))
        self.assertEqual(self.store.outbox_prune(14), 1)
        self.assertEqual([row[0] for row in self._rows()], [second["id"], third["id"]])
        self.assertTrue(self.store.ready())
        self.assertEqual(self.admin.execute("SELECT count(*) FROM signal_replay.entries").fetchone()[0], 0)

    def test_hash_mismatch_bad_arguments_and_wrong_authority_are_refused(self):
        self._install()
        with self.assertRaises(StoreError):
            self.store.outbox_put(b"body", leaf_hash(b"other"), "router-a")
        with self.assertRaises(StoreError):
            self.store.outbox_put(b"", leaf_hash(b""), "router-a")
        with self.assertRaises(StoreError):
            self.store.outbox_put(b"body", b"short", "router-a")
        with self.assertRaises(self.psycopg.Error):
            self.runtime.execute("SELECT * FROM signal_replay.api_outbox_put(%s,%s,%s,%s)",
                                 ("d" * 32, leaf_hash(b"body"), b"body", "router-a"))
        with self.assertRaises(self.psycopg.Error):
            self.runtime.execute("SELECT signal_replay.api_outbox_ack(%s,%s,%s)", (AUTHORITY, 1, -1))
        with self.assertRaises(self.psycopg.Error):
            self.runtime.execute("SELECT * FROM signal_replay.api_outbox_pending(%s,%s)", (AUTHORITY, 0))
        self.assertEqual(self._rows(), [])

    def test_runtime_login_cannot_touch_the_table_and_drift_fences(self):
        self._install()
        self.assertEqual(self.store.outbox_put(b"body", leaf_hash(b"body"), "router-a")["duplicate"], False)
        for query in ["DELETE FROM signal_replay.leaf_outbox",
                      "UPDATE signal_replay.leaf_outbox SET appended_idx = 0, appended_at = now()",
                      "INSERT INTO signal_replay.leaf_outbox (leaf_hash, body, queued_by) VALUES ('\\x00', 'x', 'r')"]:
            with self.subTest(query=query), self.assertRaises(self.psycopg.errors.InsufficientPrivilege):
                self.runtime.execute(query)
        other = PostgresStore(environ=dict(self.settings, LIVE402_REPLAY_POSTGRES_DSN=self.other_dsn))
        try:
            with self.assertRaises(StoreError):
                other.outbox_put(b"other", leaf_hash(b"other"), "router-x")
        finally:
            other.close()
        self.admin.execute("GRANT UPDATE(appended_idx) ON signal_replay.leaf_outbox TO managed_runtime")
        with self.assertRaises(StoreError):
            self.store.outbox_put(b"more", leaf_hash(b"more"), "router-a")
        with self.assertRaises(StoreError):
            self.store.outbox_pending()
        self.admin.execute("REVOKE UPDATE(appended_idx) ON signal_replay.leaf_outbox FROM managed_runtime")
        self.assertEqual(len(self.store.outbox_pending()), 1)

    def test_fence_break_refuses_queued_leaves_like_admissions(self):
        self._install()
        self.admin.execute("UPDATE signal_replay.runtime_policy SET instance_start_us = instance_start_us - 1")
        self.store.close()
        with self.assertRaises(StoreError):
            self.store.outbox_put(b"body", leaf_hash(b"body"), "router-a")
        with self.assertRaises(StoreError):
            self.store.reserve(KEY, SCOPE, time.time() + 120)
        self.assertEqual(self._rows(), [])


if __name__ == "__main__":
    unittest.main()
