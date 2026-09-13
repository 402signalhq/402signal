"""Managed-Postgres router lease (no GRANT/REVOKE) against disposable loopback PostgreSQL."""

from __future__ import annotations

import os
import re
import unittest
from pathlib import Path

from live402 import leadership
from test_replay_storage import AUTHORITY

ROOT = Path(__file__).resolve().parents[1]
FUNCTIONS_SQL = ROOT / "ops" / "replay-postgres-functions.sql"
MANAGED_LEASE_SQL = ROOT / "ops" / "router-leadership-managed.sql"
PASSWORD = "isolated-fixture-only"


class ManagedLeaseSqlShape(unittest.TestCase):
    def test_installs_without_grant_or_revoke(self):
        code = "\n".join(line.split("--", 1)[0]
                         for line in MANAGED_LEASE_SQL.read_text(encoding="utf-8").splitlines())
        self.assertIsNone(re.search(r"\b(GRANT|REVOKE)\b", code, re.IGNORECASE))

    def test_keeps_the_signatures_the_router_calls(self):
        sql = MANAGED_LEASE_SQL.read_text(encoding="utf-8")
        self.assertIn("signal_router.lease_renew(p_slot text, p_holder text, p_ttl_ms integer)", sql)
        self.assertIn("RETURNS TABLE (lease_holder text, lease_epoch bigint)", sql)
        self.assertIn("signal_router.lease_release(p_slot text, p_holder text)", sql)
        self.assertIn("signal_router.lease_renew", leadership.PG_RENEW)
        self.assertIn("signal_router.lease_release", leadership.PG_RELEASE)


@unittest.skipUnless(os.environ.get("LIVE402_PG_TEST_DESTRUCTIVE") == "isolated-ci-only",
                     "requires disposable loopback PostgreSQL")
class ManagedLeasePostgres(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg
        from psycopg.conninfo import conninfo_to_dict, make_conninfo

        cfg = conninfo_to_dict(os.environ["LIVE402_PG_TEST_DSN"])
        if cfg.get("host") != "127.0.0.1" or cfg.get("dbname") != "402signal_ci":
            raise RuntimeError("refusing destructive tests outside loopback CI")
        cls.psycopg = psycopg
        cls.admin_dsn = os.environ["LIVE402_PG_TEST_DSN"]
        cls.admin = psycopg.connect(**cfg, autocommit=True)
        for role in ("managed_runtime", "managed_other"):
            if not cls.admin.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (role,)).fetchone():
                cls.admin.execute("CREATE ROLE %s LOGIN PASSWORD '%s'" % (role, PASSWORD))
                cls.admin.execute("GRANT pg_read_all_data TO %s" % role)
        cls.runtime_dsn = make_conninfo(**dict(cfg, user="managed_runtime", password=PASSWORD))
        cls.other_dsn = make_conninfo(**dict(cfg, user="managed_other", password=PASSWORD))
        cls.admin.execute("DROP SCHEMA IF EXISTS signal_router CASCADE")
        cls.admin.execute("DROP SCHEMA IF EXISTS signal_replay CASCADE")
        cls.admin.execute(FUNCTIONS_SQL.read_text(encoding="utf-8"))
        cls.admin.execute(
            "INSERT INTO signal_replay.runtime_policy VALUES(TRUE,%s,'managed_runtime',"
            "(extract(epoch FROM pg_postmaster_start_time())*1000000)::bigint,inet_server_addr())",
            (AUTHORITY,))
        cls.admin.execute(MANAGED_LEASE_SQL.read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls):
        cls.admin.close()

    def _lease(self, dsn, slot, holder, ttl_s=6.0):
        return leadership.SqlLease(
            lambda: self.psycopg.connect(dsn, autocommit=True),
            leadership.pg_renew,
            leadership.pg_release,
            slot=slot,
            holder=holder,
            ttl_s=ttl_s,
        )

    def test_runtime_login_second_holder_refused_until_release_then_epoch_advances(self):
        a, b = self._lease(self.runtime_dsn, "m-slot-a", "a"), self._lease(self.runtime_dsn, "m-slot-a", "b")
        self.assertIsNotNone(a.acquire())
        self.assertEqual(a.epoch, 1)
        self.assertIsNone(b.acquire())
        a.release()
        self.assertIsNotNone(b.acquire())
        self.assertEqual(b.epoch, 2)
        self.assertIsNone(a.acquire())
        b.release()

    def test_runtime_login_renewal_keeps_epoch_and_ttl_bounds_hold(self):
        a = self._lease(self.runtime_dsn, "m-slot-b", "a")
        self.assertIsNotNone(a.acquire())
        self.assertIsNotNone(a.acquire())
        self.assertEqual(a.epoch, 1)
        self.assertIsNone(self._lease(self.runtime_dsn, "m-slot-c", "a", ttl_s=0.5).acquire())

    def test_other_logins_cannot_acquire_steal_or_release(self):
        holder = self._lease(self.runtime_dsn, "m-slot-d", "runtime")
        self.assertIsNotNone(holder.acquire())
        for dsn in (self.other_dsn, self.admin_dsn):
            with self.psycopg.connect(dsn, autocommit=True) as conn:
                with self.assertRaises(self.psycopg.errors.RaiseException):
                    conn.execute("SELECT * FROM signal_router.lease_renew(%s,%s,%s)", ("m-slot-d", "intruder", 6000))
                with self.assertRaises(self.psycopg.errors.RaiseException):
                    conn.execute("SELECT signal_router.lease_release(%s,%s)", ("m-slot-d", "runtime"))
            self.assertIsNone(self._lease(dsn, "m-slot-d", "intruder").acquire())
        self.assertIsNotNone(holder.acquire())
        self.assertEqual(holder.epoch, 1)
        holder.release()

    def test_runtime_login_cannot_write_the_lease_table(self):
        with self.psycopg.connect(self.runtime_dsn, autocommit=True) as conn:
            with self.assertRaises(self.psycopg.errors.InsufficientPrivilege):
                conn.execute("UPDATE signal_router.router_leadership SET holder = 'x'")
            with self.assertRaises(self.psycopg.errors.InsufficientPrivilege):
                conn.execute("INSERT INTO signal_router.router_leadership(slot, holder, until) "
                             "VALUES ('m-slot-e', 'x', now())")

    def test_reinstall_is_idempotent(self):
        self.admin.execute(MANAGED_LEASE_SQL.read_text(encoding="utf-8"))
        a = self._lease(self.runtime_dsn, "m-slot-f", "a")
        self.assertIsNotNone(a.acquire())
        a.release()


if __name__ == "__main__":
    unittest.main()
