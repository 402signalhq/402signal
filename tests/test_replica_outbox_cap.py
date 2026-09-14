"""The replica outboxes are bounded: a long outage stops the file growing and
restarts the backfill once the replica is back. SQLite only, no Postgres."""

from __future__ import annotations

import io
import os
import tempfile
import unittest
from contextlib import redirect_stderr
from unittest.mock import patch

os.environ.setdefault("LIVE402_FIXTURE", "1")

from live402 import catalog_replica, history, history_replica, shadow


class _Stub:
    applied = 0

    def apply(self, payload):
        self.applied += 1


class HistoryOutboxCapTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self._prev = os.environ.get("LIVE402_HISTORY_DB")
        os.environ["LIVE402_HISTORY_DB"] = os.path.join(self.tmp.name, "history.sqlite")
        history.reset()
        self.addCleanup(history.reset)

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("LIVE402_HISTORY_DB", None)
        else:
            os.environ["LIVE402_HISTORY_DB"] = self._prev

    def test_enqueue_stops_at_the_cap_and_drain_restarts_the_backfill(self):
        conn = history._connect()
        cur = conn.cursor()
        cur.executemany(
            "INSERT INTO replica_outbox (payload, created_at) VALUES (?, ?)",
            [("{}", 1)] * (history_replica.MAX_OUTBOX_ROWS - 1),
        )
        history_replica._meta_set(cur, "backfill_done_at", "123")
        history_replica._meta_set(cur, "backfill_cursor", "999")
        conn.commit()
        with patch.object(history_replica, "dual", return_value=True), \
             patch.object(history_replica, "capture", return_value={"probes": [{"id": 1}]}):
            self.assertTrue(history_replica.enqueue(cur, None))  # the last row that fits
            self.assertFalse(history_replica.enqueue(cur, None))  # over the cap: dropped, flagged
            conn.commit()
            self.assertEqual(history_replica.outbox_depth(), history_replica.MAX_OUTBOX_ROWS)
            self.assertIsNotNone(history_replica._meta_get(conn, history_replica.OVERFLOW_KEY))
            # Nothing is reset while rows remain; the replica comes back and drains them.
            stub = _Stub()
            with patch.object(history_replica, "replica", return_value=stub):
                shipped = history_replica.drain(limit=5)
                self.assertEqual((shipped, stub.applied), (5, 5))
                self.assertEqual(history_replica._meta_get(conn, "backfill_done_at"), "123")
                conn.execute("DELETE FROM replica_outbox")
                conn.commit()
                err = io.StringIO()
                with redirect_stderr(err):
                    self.assertEqual(history_replica.drain(), 0)
            self.assertIn("history_replica_outbox_overflow_recovered", err.getvalue())
            self.assertIsNone(history_replica._meta_get(conn, history_replica.OVERFLOW_KEY))
            self.assertIsNone(history_replica._meta_get(conn, "backfill_done_at"))
            self.assertEqual(history_replica._meta_get(conn, "backfill_cursor"), "0")
            # Without an overflow an empty drain changes nothing.
            history_replica._meta_set(conn, "backfill_done_at", "456")
            conn.commit()
            with patch.object(history_replica, "replica", return_value=_Stub()):
                self.assertEqual(history_replica.drain(), 0)
            self.assertEqual(history_replica._meta_get(conn, "backfill_done_at"), "456")

    def test_enqueue_never_raises(self):
        conn = history._connect()
        with patch.object(history_replica, "dual", return_value=True), \
             patch.object(history_replica, "capture", side_effect=RuntimeError("boom")):
            self.assertFalse(history_replica.enqueue(conn.cursor(), None))


class CatalogOutboxCapTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self._prev = os.environ.get("LIVE402_CATALOG_DB")
        os.environ["LIVE402_CATALOG_DB"] = os.path.join(self.tmp.name, "catalog.sqlite")
        shadow.reset()
        self.addCleanup(shadow.reset)

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("LIVE402_CATALOG_DB", None)
        else:
            os.environ["LIVE402_CATALOG_DB"] = self._prev

    def test_enqueue_stops_at_the_cap_and_drain_restarts_the_backfill(self):
        conn = shadow._connect()
        cur = conn.cursor()
        cur.executemany(
            "INSERT INTO replica_outbox (payload, created_at) VALUES (?, ?)",
            [("{}", 1)] * catalog_replica.MAX_OUTBOX_ROWS,
        )
        catalog_replica._meta_set(cur, "backfill_done_at", "123")
        catalog_replica._meta_set(cur, "backfill_events_cursor", "77")
        conn.commit()
        with patch.object(catalog_replica, "dual", return_value=True), \
             patch.object(catalog_replica, "capture", return_value={"resources": [{"id": 1}]}):
            self.assertFalse(catalog_replica.enqueue(cur, None))
            conn.commit()
            self.assertIsNotNone(catalog_replica._meta_get(conn, catalog_replica.OVERFLOW_KEY))
            conn.execute("DELETE FROM replica_outbox")
            conn.commit()
            err = io.StringIO()
            with patch.object(catalog_replica, "replica", return_value=_Stub()), redirect_stderr(err):
                self.assertEqual(catalog_replica.drain(), 0)
            self.assertIn("catalog_replica_outbox_overflow_recovered", err.getvalue())
            self.assertIsNone(catalog_replica._meta_get(conn, "backfill_done_at"))
            self.assertIsNone(catalog_replica._meta_get(conn, "backfill_events_cursor"))
            self.assertEqual(catalog_replica._meta_get(conn, "backfill_cursor"), "0")


if __name__ == "__main__":
    unittest.main()
