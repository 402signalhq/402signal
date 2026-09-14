"""Operational follow-ups from the 2026-09-14 security review: the checkpoint
pointer never moves backwards, replica outages log quietly, alert scans are measured."""

from __future__ import annotations

import io
import os
import tempfile
import unittest
from contextlib import redirect_stderr
from unittest.mock import patch

os.environ.setdefault("LIVE402_FIXTURE", "1")

from live402 import alerts, maintenance, metrics
from live402.pq import store


class CheckpointPointerTests(unittest.TestCase):
    def test_latest_pointer_is_monotonic_when_saves_interleave(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = os.path.join(tmp.name, "pq.sqlite")
        with patch.object(store, "db_path", return_value=path), \
             patch.object(store, "ready_to_checkpoint", return_value=True):
            store._conn, store._conn_path = None, None
            try:
                store.save_checkpoint(10, "origin\n10\nAAAA\n")
                self.assertEqual(store.latest_checkpoint(), "origin\n10\nAAAA\n")
                # A smaller size finishing later (an interleaved save) must not win.
                store.save_checkpoint(9, "origin\n9\nBBBB\n")
                self.assertEqual(store.latest_checkpoint(), "origin\n10\nAAAA\n")
                self.assertEqual(store.checkpoint_at(9), "origin\n9\nBBBB\n")
                store.save_checkpoint(11, "origin\n11\nCCCC\n")
                self.assertEqual(store.latest_checkpoint(), "origin\n11\nCCCC\n")
                # Re-signing the largest size replaces its note and the pointer follows.
                store.save_checkpoint(11, "origin\n11\nDDDD\n")
                self.assertEqual(store.latest_checkpoint(), "origin\n11\nDDDD\n")
            finally:
                if store._conn is not None:
                    store._conn.close()
                store._conn, store._conn_path = None, None


class QuietUnavailableLogTests(unittest.TestCase):
    def setUp(self):
        maintenance._unavailable_logged.clear()

    def test_outage_logs_once_then_every_interval_then_recovers_once(self):
        err = io.StringIO()
        with redirect_stderr(err), patch.object(maintenance.time, "monotonic", side_effect=[0.0, 1.0, 599.0, 601.0]):
            maintenance._log_unavailable("history_replica", 3, "down")
            maintenance._log_unavailable("history_replica", 4, "down")
            maintenance._log_unavailable("history_replica", 5, "down")
            maintenance._log_unavailable("history_replica", 6, "down")
        lines = err.getvalue().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertIn("pending=3", lines[0])
        self.assertIn("pending=6", lines[1])
        err = io.StringIO()
        with redirect_stderr(err):
            maintenance._log_recovered("history_replica")
            maintenance._log_recovered("history_replica")
        self.assertEqual(err.getvalue().splitlines(), ["history_replica_recovered"])


class AlertsScanMetricTests(unittest.TestCase):
    def test_scan_duration_and_deliveries_are_counted(self):
        metrics.snapshot(reset=True)
        with patch.object(alerts, "scan", return_value=3), redirect_stderr(io.StringIO()):
            maintenance._alerts_scan()
        counts = metrics.snapshot()
        self.assertEqual(counts.get("alerts.scans"), 1)
        self.assertEqual(counts.get("alerts.deliveries"), 3)
        self.assertGreaterEqual(counts.get("alerts.scan_ms", 0), 0)
        self.assertNotIn("alerts.scan_slow", counts)
        metrics.snapshot(reset=True)
        with patch.object(alerts, "scan", return_value=0), patch.object(maintenance, "ALERTS_SCAN_SLOW_MS", 0), \
             redirect_stderr(io.StringIO()):
            maintenance._alerts_scan()
        counts = metrics.snapshot()
        self.assertEqual(counts.get("alerts.scan_slow"), 1)
        self.assertNotIn("alerts.deliveries", counts)


if __name__ == "__main__":
    unittest.main()
