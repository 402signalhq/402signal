"""Replay instance-fence recovery against disposable loopback PostgreSQL only."""

from __future__ import annotations

import os
import re
import time
import unittest
from pathlib import Path

from live402.replay_postgres import PostgresStore
from test_replay_storage import AUTHORITY, KEY, SCOPE

ROOT = Path(__file__).resolve().parents[1]
FUNCTIONS_SQL = ROOT / "ops" / "replay-postgres-functions.sql"
FENCE_SQL = ROOT / "ops" / "replay-postgres-fence.sql"
PASSWORD = "isolated-fixture-only"
NOTE = "reconciled pending identities against chain settlements"


class FenceSqlShape(unittest.TestCase):
    def test_installs_without_grant_or_revoke(self):
        code = "\n".join(line.split("--", 1)[0]
                         for line in FENCE_SQL.read_text(encoding="utf-8").splitlines())
        self.assertIsNone(re.search(r"\b(GRANT|REVOKE)\b", code, re.IGNORECASE))

    def test_never_touches_identities_or_authority_limits(self):
        code = FENCE_SQL.read_text(encoding="utf-8")
        self.assertNotRegex(code, r"(?i)(UPDATE|DELETE FROM|INSERT INTO)\s+signal_replay\.(entries|authority)\b")


@unittest.skipUnless(os.environ.get("LIVE402_PG_TEST_DESTRUCTIVE") == "isolated-ci-only",
                     "requires disposable loopback PostgreSQL")
class ReplayFencePostgres(unittest.TestCase):
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
        self.admin.execute(FENCE_SQL.read_text(encoding="utf-8"))
        self.store = PostgresStore(environ=self.settings)
        self.runtime = psycopg.connect(self.runtime_dsn, autocommit=True)

    def tearDown(self):
        self.store.close()
        self.runtime.close()
        self.admin.close()

    def _ready(self):
        try:
            return bool(self.store.ready())
        except Exception:
            return False

    def _status(self, *args):
        cur = self.admin.execute("SELECT * FROM signal_replay.fence_status(%s, %s)",
                                 args or (None, None))
        return dict(zip([column.name for column in cur.description], cur.fetchone()))

    def _repin(self, *args):
        placeholders = ",".join(["%s"] * len(args))
        return self.admin.execute("SELECT signal_replay.fence_repin(%s)" % placeholders, args).fetchone()[0]

    def _events(self):
        return [row[0] for row in self.admin.execute("SELECT kind FROM signal_replay.fence_events ORDER BY event_id")]

    def _simulate_instance_change(self, timeline_shift=0, addr=None):
        # Pretend the pin (and its evidence) was taken before the current postmaster start.
        self.admin.execute("UPDATE signal_replay.runtime_policy SET instance_start_us = instance_start_us - 1000000")
        self.admin.execute("UPDATE signal_replay.instance_evidence SET instance_start_us = instance_start_us - 1000000, "
                           "timeline_id = timeline_id + %s", (timeline_shift,))
        if addr:
            self.admin.execute("UPDATE signal_replay.runtime_policy SET instance_server_addr = %s", (addr,))
            self.admin.execute("UPDATE signal_replay.instance_evidence SET instance_server_addr = %s", (addr,))

    def test_install_adopts_evidence_and_keeps_runtime_ready(self):
        self.assertTrue(self._ready())
        status = self._status()
        self.assertEqual(status["classification"], "pinned")
        self.assertIsNotNone(status["pinned_timeline"])
        self.assertEqual(status["pinned_timeline"], status["current_timeline"])
        self.assertTrue(status["counters_consistent"])
        self.assertEqual(self._events(), ["adopted"])
        self.assertEqual(self._repin("restart"), "already_pinned")
        self.assertEqual(self._events(), ["adopted"])

    def test_plain_restart_is_repinned_and_admission_resumes(self):
        self.assertTrue(self.store.reserve(KEY, SCOPE, time.time() + 120))
        self.store.finish(KEY, "settled", None, False)
        self._simulate_instance_change()
        self.assertFalse(self._ready())
        self.assertEqual(self._status()["classification"], "restart")
        self.assertEqual(self._repin("restart"), "restart_repin")
        self.assertEqual(self._status()["classification"], "pinned")
        self.assertTrue(self._ready())
        self.assertEqual(self._events(), ["adopted", "restart_repin"])
        self.assertEqual(self.store.lookup(KEY)[0], "settled")

    def test_timeline_change_requires_reconciled_attestation(self):
        self._simulate_instance_change(timeline_shift=1)
        self.assertEqual(self._status()["classification"], "instance_changed")
        with self.assertRaises(self.psycopg.errors.RaiseException):
            self._repin("restart")
        with self.assertRaises(self.psycopg.errors.RaiseException):
            self._repin("attested", 5, NOTE)
        with self.assertRaises(self.psycopg.errors.RaiseException):
            self._repin("attested", 0, "too short")
        self.assertFalse(self._ready())
        self.assertEqual(self._repin("attested", 0, NOTE), "attested_repin")
        self.assertTrue(self._ready())
        note = self.admin.execute("SELECT note FROM signal_replay.fence_events WHERE kind='attested_repin'").fetchone()[0]
        self.assertEqual(note, NOTE)

    def test_address_change_and_missing_evidence_are_not_restarts(self):
        self._simulate_instance_change(addr="192.0.2.10")
        self.assertEqual(self._status()["classification"], "instance_changed")
        self.admin.execute("DELETE FROM signal_replay.instance_evidence")
        self.assertEqual(self._status()["classification"], "no_evidence")
        with self.assertRaises(self.psycopg.errors.RaiseException):
            self._repin("restart")
        self.assertEqual(self._repin("attested", 0, NOTE), "attested_repin")
        self.assertTrue(self._ready())

    def test_inconsistent_counters_block_any_repin(self):
        self._simulate_instance_change()
        self.admin.execute("UPDATE signal_replay.authority SET outcome_bytes = outcome_bytes + 1")
        self.assertFalse(self._status()["counters_consistent"])
        with self.assertRaises(self.psycopg.errors.RaiseException):
            self._repin("restart")
        with self.assertRaises(self.psycopg.errors.RaiseException):
            self._repin("attested", 0, NOTE)

    def test_external_high_water_applies_only_on_its_timeline(self):
        self._simulate_instance_change()
        timeline = self._status()["current_timeline"]
        self.assertEqual(self._status("FFFFFFFF/0", timeline)["classification"], "instance_changed")
        with self.assertRaises(self.psycopg.errors.RaiseException):
            self._repin("restart", None, None, "FFFFFFFF/0", timeline)
        self.assertEqual(self._repin("restart", None, None, "FFFFFFFF/0", timeline + 1), "restart_repin")

    def test_runtime_login_cannot_use_the_tooling_or_edit_the_pin(self):
        for statement in ("SELECT * FROM signal_replay.fence_status()",
                          "SELECT signal_replay.fence_repin('restart')",
                          "SELECT signal_replay.fence_repin('attested', 0, '%s')" % NOTE):
            with self.assertRaises(self.psycopg.errors.RaiseException):
                self.runtime.execute(statement)
        with self.assertRaises(self.psycopg.errors.InsufficientPrivilege):
            self.runtime.execute("UPDATE signal_replay.runtime_policy SET instance_start_us = 1")
        with self.assertRaises(self.psycopg.errors.InsufficientPrivilege):
            self.runtime.execute("DELETE FROM signal_replay.instance_evidence")
        self.assertTrue(self._ready())


if __name__ == "__main__":
    unittest.main()
