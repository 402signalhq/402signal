"""Writer lease: exclusivity, conservative validity and publisher gating."""

from __future__ import annotations

import http.client
import json
import multiprocessing
import os
import sqlite3
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from live402 import catalog, fixtures, leadership, maintenance, ready, server
from live402.pq import receipt, worker

SQLITE_TABLE = (
    "CREATE TABLE IF NOT EXISTS router_leadership ("
    "slot TEXT PRIMARY KEY, holder TEXT NOT NULL, until_ms INTEGER NOT NULL, epoch INTEGER NOT NULL)"
)
# SQLite mirror of signal_router.lease_renew in ops/router-leadership.sql.
SQLITE_RENEW = (
    "INSERT INTO router_leadership (slot, holder, until_ms, epoch) VALUES (?, ?, ?, 1) "
    "ON CONFLICT(slot) DO UPDATE SET holder = excluded.holder, until_ms = excluded.until_ms, "
    "epoch = CASE WHEN router_leadership.holder = excluded.holder "
    "THEN router_leadership.epoch ELSE router_leadership.epoch + 1 END "
    "WHERE router_leadership.holder = excluded.holder OR router_leadership.until_ms < ? "
    "RETURNING holder, epoch"
)


def sqlite_lease(path, holder, clock, ttl_s=15.0):
    def connect():
        conn = sqlite3.connect(path, timeout=20, isolation_level=None)
        conn.execute(SQLITE_TABLE)
        return conn

    def renew(conn, slot, who, ttl_ms):
        now_ms = int(clock() * 1000)
        conn.execute("BEGIN IMMEDIATE")
        try:
            rows = conn.execute(SQLITE_RENEW, (slot, who, now_ms + ttl_ms, now_ms)).fetchall()
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        conn.execute("COMMIT")
        return rows[0] if rows else None

    def release(conn, slot, who):
        conn.execute("UPDATE router_leadership SET until_ms = 0 WHERE slot = ? AND holder = ?", (slot, who))

    return leadership.SqlLease(connect, renew, release, holder=holder, ttl_s=ttl_s, monotonic=clock)


def _file_child(path, queue):
    lease = leadership.FileLease(path)
    queue.put(lease.acquire() is not None)
    lease.release()


def _sqlite_child(path, holder, go, queue):
    go.wait(20)
    lease = sqlite_lease(path, holder, lambda: 1000.0)
    queue.put((holder, lease.acquire() is not None))


class LeaseExclusivityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.ctx = multiprocessing.get_context("spawn")

    def tearDown(self):
        self.tmp.cleanup()

    def _run_file_child(self, path):
        queue = self.ctx.Queue()
        proc = self.ctx.Process(target=_file_child, args=(path, queue))
        proc.start()
        try:
            return queue.get(timeout=60)
        finally:
            proc.join(30)

    def test_file_lease_excludes_a_second_process(self):
        path = str(self.dir / "writer.lock")
        mine = leadership.FileLease(path)
        self.assertIsNotNone(mine.acquire())
        self.assertFalse(self._run_file_child(path))
        mine.release()
        self.assertTrue(self._run_file_child(path))

    def test_file_lease_excludes_a_second_holder_in_process(self):
        path = str(self.dir / "writer.lock")
        first, second = leadership.FileLease(path), leadership.FileLease(path)
        self.assertIsNotNone(first.acquire())
        self.assertIsNone(second.acquire())
        first.release()
        self.assertIsNotNone(second.acquire())
        second.release()

    def test_two_processes_racing_one_row_have_exactly_one_holder(self):
        path = str(self.dir / "lease.sqlite")
        queue, go = self.ctx.Queue(), self.ctx.Event()
        procs = [
            self.ctx.Process(target=_sqlite_child, args=(path, "holder-%d" % i, go, queue))
            for i in range(4)
        ]
        for proc in procs:
            proc.start()
        go.set()
        results = [queue.get(timeout=120) for _ in procs]
        for proc in procs:
            proc.join(30)
        self.assertEqual(sum(1 for _holder, won in results if won), 1)

    def test_takeover_waits_for_expiry_and_old_holder_stops_first(self):
        path = str(self.dir / "lease.sqlite")
        now = [0.0]
        clock = lambda: now[0]  # noqa: E731
        a, b = sqlite_lease(path, "a", clock), sqlite_lease(path, "b", clock)
        a_until = a.acquire()
        self.assertEqual(a_until, 15.0 - leadership.SAFETY_S)
        self.assertEqual(a.epoch, 1)
        for moment in (1.0, 10.0, 14.9):
            now[0] = moment
            self.assertIsNone(b.acquire())
        now[0] = 15.001
        b_until = b.acquire()
        self.assertIsNotNone(b_until)
        self.assertEqual(b.epoch, 2)
        # a's own validity ended before the database let b in.
        self.assertLess(a_until, now[0])
        self.assertGreater(b_until, now[0])
        now[0] = 16.0
        self.assertIsNone(a.acquire())

    def test_renewal_by_holder_extends_without_new_epoch(self):
        path = str(self.dir / "lease.sqlite")
        now = [0.0]
        clock = lambda: now[0]  # noqa: E731
        a, b = sqlite_lease(path, "a", clock), sqlite_lease(path, "b", clock)
        self.assertIsNotNone(a.acquire())
        now[0] = 10.0
        self.assertEqual(a.acquire(), 23.0)
        self.assertEqual(a.epoch, 1)
        now[0] = 20.0
        self.assertIsNone(b.acquire())


class ManagerTests(unittest.TestCase):
    def setUp(self):
        leadership.reset_for_tests()
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        leadership.reset_for_tests()
        self.tmp.cleanup()

    def test_none_backend_is_implicit_single_process_leadership(self):
        with patch.dict(os.environ, {"LIVE402_LEADERSHIP_BACKEND": "none"}):
            self.assertTrue(leadership.holds())

    def test_file_backend_holds_only_after_start_and_runs_callbacks_once(self):
        calls = []
        env = {
            "LIVE402_LEADERSHIP_BACKEND": "file",
            "LIVE402_LEADERSHIP_LOCK": str(Path(self.tmp.name) / "writer.lock"),
        }
        with patch.dict(os.environ, env):
            self.assertFalse(leadership.holds())
            self.assertTrue(leadership.start(on_acquire=(lambda: calls.append(1),)))
            self.assertTrue(leadership.holds())
            leadership._attempt()
            self.assertEqual(calls, [1])
            leadership.release()
            self.assertFalse(leadership.holds())

    def test_invalid_backend_fails_closed(self):
        with patch.dict(os.environ, {"LIVE402_LEADERSHIP_BACKEND": "bogus"}):
            self.assertFalse(leadership.holds())
            self.assertFalse(leadership.start())
            self.assertFalse(leadership.holds())

    def test_readiness_reports_the_lease_beside_ok_never_inside_checks(self):
        ready.reset_cache()
        with patch.dict(os.environ, {"LIVE402_LEADERSHIP_BACKEND": "bogus"}):
            payload = ready.readiness()
            self.assertIs(payload["writer"], False)
            self.assertNotIn("writer", payload["checks"])
            # A standby without the lease is still a healthy machine.
            self.assertEqual(payload["ok"], all(payload["checks"].values()))
        with patch.dict(os.environ, {"LIVE402_LEADERSHIP_BACKEND": "none"}):
            self.assertIs(ready.readiness()["writer"], True)
            self.assertIs(ready.cached_readiness()["writer"], True)


class PublisherGatingTests(unittest.TestCase):
    def tearDown(self):
        worker.stop_worker()
        thread = worker._tick_thread
        if thread is not None:
            thread.join(3)
        worker._tick_thread = None
        worker._tick_stop.clear()
        catalog.stop_refresher()
        refresher = catalog._refresh_thread
        if refresher is not None:
            refresher.join(3)
        catalog._refresh_thread = None

    def test_pq_start_worker_skipped_without_lease(self):
        with patch.object(fixtures, "fixture_mode", return_value=False), \
                patch.object(leadership, "holds", return_value=False):
            worker.start_worker()
        self.assertFalse(worker.worker_running())

    def test_pq_start_worker_runs_with_lease(self):
        release = threading.Event()
        with patch.object(fixtures, "fixture_mode", return_value=False), \
                patch.object(leadership, "holds", return_value=True), \
                patch.object(worker, "_tick_loop", side_effect=lambda: release.wait(5)):
            worker.start_worker()
            self.assertTrue(worker.worker_running())
        release.set()

    def test_pq_tick_loop_is_a_noop_without_lease(self):
        worker._tick_stop.clear()
        with patch.object(fixtures, "fixture_mode", return_value=False), \
                patch.object(leadership, "holds", return_value=False), \
                patch.object(worker, "_tick_sleep_s", return_value=0.01), \
                patch.object(worker, "tick") as tick:
            thread = threading.Thread(target=worker._tick_loop)
            thread.start()
            time.sleep(0.2)
            worker._tick_stop.set()
            thread.join(3)
        tick.assert_not_called()

    def test_catalog_crawler_skipped_without_lease(self):
        with patch.object(fixtures, "fixture_mode", return_value=False), \
                patch.object(catalog, "_refresh_disabled", return_value=False), \
                patch.object(leadership, "holds", return_value=False):
            catalog.start_refresher()
        thread = catalog._refresh_thread
        self.assertTrue(thread is None or not thread.is_alive())

    def test_pq_leaf_append_refused_without_lease(self):
        with patch.object(leadership, "holds", return_value=False), \
                patch.object(receipt.store, "append") as append:
            with self.assertRaises(receipt.ReceiptError):
                receipt.append_event({"type": "402signal.route_decision.v1"})
        append.assert_not_called()

    def test_writer_housekeeping_skipped_without_lease(self):
        with patch.object(leadership, "holds", return_value=False):
            self.assertEqual(maintenance.run_due(now=1e9), [])


class PaidGateTests(unittest.TestCase):
    def setUp(self):
        self.httpd = server.BoundedThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.limiter = patch.object(server._ROUTE_LIMITER, "allow", return_value=True)
        self.limiter.start()

    def tearDown(self):
        self.limiter.stop()
        self.httpd.shutdown()
        self.httpd.server_close()

    def _post(self, headers):
        body = json.dumps({"need": "weather"}).encode("utf-8")
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=20)
        try:
            conn.request("POST", "/route", body=body, headers={
                "Content-Type": "application/json", "Content-Length": str(len(body)), **headers,
            })
            resp = conn.getresponse()
            return resp.status, json.loads(resp.read() or b"{}")
        finally:
            conn.close()

    def test_paid_request_refused_before_verification_without_lease(self):
        with patch.object(leadership, "holds", return_value=False), \
                patch("live402.facilitator.verify") as verify:
            status, body = self._post({"PAYMENT-SIGNATURE": "e30="})
        self.assertEqual(status, 503)
        self.assertEqual(body["error"], "writer_unavailable")
        self.assertIs(body["new_payment_allowed"], False)
        self.assertIs(body["retry_same_request"], True)
        verify.assert_not_called()

    def test_paid_request_refused_when_not_ready(self):
        with patch.dict(os.environ, {"LIVE402_PAID_READY_GATE": "1"}), \
                patch.object(leadership, "holds", return_value=True), \
                patch.object(ready, "cached_readiness", return_value={"ok": False, "checks": {}}), \
                patch("live402.facilitator.verify") as verify:
            status, body = self._post({"PAYMENT-SIGNATURE": "e30="})
        self.assertEqual(status, 503)
        self.assertEqual(body["error"], "service_not_ready")
        verify.assert_not_called()

    def test_unpaid_challenge_still_served_without_lease(self):
        with patch.object(leadership, "holds", return_value=False):
            status, body = self._post({})
        self.assertEqual(status, 402)
        self.assertIn("accepts", body)


if __name__ == "__main__":
    unittest.main()
