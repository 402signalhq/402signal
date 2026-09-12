"""Router lease functions against a real isolated PostgreSQL (CI only)."""

from __future__ import annotations

import os
import unittest
from pathlib import Path

from live402 import leadership

DSN = os.environ.get("LIVE402_PG_TEST_DSN")
DESTRUCTIVE = os.environ.get("LIVE402_PG_TEST_DESTRUCTIVE") == "isolated-ci-only"


@unittest.skipUnless(DSN and DESTRUCTIVE, "isolated PostgreSQL not configured")
class PostgresLeaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg

        cls.psycopg = psycopg
        sql = (Path(__file__).resolve().parents[1] / "ops" / "router-leadership.sql").read_text(encoding="utf-8")
        with psycopg.connect(DSN, autocommit=True) as conn:
            conn.execute("DROP SCHEMA IF EXISTS signal_router CASCADE")
            conn.execute(sql)

    def _lease(self, slot, holder, ttl_s=6.0):
        return leadership.SqlLease(
            lambda: self.psycopg.connect(DSN, autocommit=True),
            leadership.pg_renew,
            leadership.pg_release,
            slot=slot,
            holder=holder,
            ttl_s=ttl_s,
        )

    def test_second_holder_refused_until_release_then_epoch_advances(self):
        a, b = self._lease("slot-a", "a"), self._lease("slot-a", "b")
        self.assertIsNotNone(a.acquire())
        self.assertEqual(a.epoch, 1)
        self.assertIsNone(b.acquire())
        a.release()
        self.assertIsNotNone(b.acquire())
        self.assertEqual(b.epoch, 2)
        self.assertIsNone(a.acquire())

    def test_holder_renewal_keeps_epoch(self):
        a = self._lease("slot-b", "a")
        self.assertIsNotNone(a.acquire())
        self.assertIsNotNone(a.acquire())
        self.assertEqual(a.epoch, 1)

    def test_ttl_outside_bounds_is_never_granted(self):
        short = self._lease("slot-c", "a", ttl_s=0.5)
        self.assertIsNone(short.acquire())


if __name__ == "__main__":
    unittest.main()
