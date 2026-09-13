"""North star: signed receipts to distinct non-lab payers, counted privately per day."""

from __future__ import annotations

import hashlib
import os
import tempfile
import time
import unittest
from unittest.mock import patch

os.environ.setdefault("LIVE402_FIXTURE", "1")

from live402 import maintenance, route, session

HASH_A = hashlib.sha256(b"0xpayer-a").hexdigest()
HASH_B = hashlib.sha256(b"0xpayer-b").hexdigest()


class NorthStarTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._prev = os.environ.get("LIVE402_SESSION_DB")
        os.environ["LIVE402_SESSION_DB"] = os.path.join(self.tmp.name, "session.sqlite")

    def tearDown(self):
        session.reset()
        if self._prev is None:
            os.environ.pop("LIVE402_SESSION_DB", None)
        else:
            os.environ["LIVE402_SESSION_DB"] = self._prev
        self.tmp.cleanup()

    def test_record_dedupes_per_day_and_counts_only_hashes(self):
        now = time.time()
        self.assertTrue(session.record_payer(HASH_A, "organic", now=now))
        self.assertFalse(session.record_payer(HASH_A, "organic", now=now))
        self.assertTrue(session.record_payer(HASH_A, "organic", now=now + 86400))
        for bad in ("0xabc", "", None, "Z" * 64, HASH_A.upper()):
            self.assertFalse(session.record_payer(bad, "organic", now=now))

    def test_window_counts_organic_receipts_and_distinct_payers(self):
        now = time.time()
        today = time.strftime("%Y-%m-%d", time.gmtime(now))
        old = time.strftime("%Y-%m-%d", time.gmtime(now - 10 * 86400))
        session.add_counters(today, {"route.qualified.organic": 3, "route.qualified.lab": 2, "route.miss.organic": 9})
        session.add_counters(old, {"route.qualified.organic": 50})
        session.record_payer(HASH_A, "organic", now=now)
        session.record_payer(HASH_A, "organic", now=now - 86400)
        session.record_payer(HASH_B, "lab", now=now)
        snap = session.north_star(7, now=now)
        self.assertEqual(snap, {
            "days": 7, "receipts_organic": 3, "receipts_all": 5,
            "distinct_payers_organic": 1, "distinct_payers_all": 2,
        })
        self.assertEqual(session.north_star(30, now=now)["receipts_organic"], 53)

    def test_prune_drops_old_payer_days(self):
        now = time.time()
        session.record_payer(HASH_A, "organic", now=now)
        session.record_payer(HASH_B, "organic", now=now - 500 * 86400)
        removed = session.prune(now=int(now))
        self.assertEqual(removed["payer_days"], 1)
        self.assertEqual(session.north_star(7, now=now)["distinct_payers_all"], 1)

    def test_route_remembers_the_hashed_payer_under_the_traffic_label(self):
        with patch.object(session, "record_payer") as record, patch("live402.metrics.traffic_label", return_value="organic"):
            route._remember_payer("0xPayer-A")
            route._remember_payer(None)
        record.assert_called_once_with(hashlib.sha256(b"0xPayer-A").hexdigest(), "organic")

    def test_route_hook_never_raises(self):
        with patch.object(session, "record_payer", side_effect=RuntimeError("db down")):
            route._remember_payer("0xpayer")

    def test_maintenance_logs_the_pair_hourly(self):
        self.assertIn(("north_star", 3600.0), maintenance.JOBS)
        self.assertIs(maintenance._JOB_FUNCS["north_star"], maintenance._north_star)
        maintenance._north_star()


if __name__ == "__main__":
    unittest.main()
