"""Hosted session v0: hops do not probe or settle; trials stay off public clocks."""

from __future__ import annotations

import os
import tempfile
import time
import unittest
from unittest.mock import patch

os.environ.setdefault("LIVE402_FIXTURE", "1")
os.environ.pop("LOCAL_FREE", None)

from live402 import facilitator, history, probe, route, session


WEATHER = "https://fixture.402signal.local/weather"


class HostedSessionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self._prev_h = os.environ.get("LIVE402_HISTORY_DB")
        self._prev_s = os.environ.get("LIVE402_SESSION_DB")
        os.environ["LIVE402_HISTORY_DB"] = os.path.join(self.tmp.name, "hist.sqlite")
        os.environ["LIVE402_SESSION_DB"] = os.path.join(self.tmp.name, "sess.sqlite")
        os.environ.pop("LIVE402_ROUTE_TRAFFIC_CLASS", None)
        history.reset()
        session.reset()
        self.addCleanup(history.reset)
        self.addCleanup(session.reset)

    def tearDown(self):
        if self._prev_h is None:
            os.environ.pop("LIVE402_HISTORY_DB", None)
        else:
            os.environ["LIVE402_HISTORY_DB"] = self._prev_h
        if self._prev_s is None:
            os.environ.pop("LIVE402_SESSION_DB", None)
        else:
            os.environ["LIVE402_SESSION_DB"] = self._prev_s

    def _open(self, token, **body):
        headers = {"X-402Signal-Trial": token}
        payload = {"url": WEATHER, "session": "open"}
        payload.update(body)
        return route.handle_route(payload, headers, "https://402signal.com/route")

    def test_open_two_hops_zero_extra_probes(self):
        token = session.issue_trial()
        with patch.object(facilitator, "verify") as verify, patch.object(facilitator, "settle") as settle:
            code, body, _ = self._open(token)
            self.assertEqual(code, 200)
            self.assertTrue(body.get("live"))
            sid = body["session"]["id"]
            probes_after_open = history._connect().execute("SELECT COUNT(*) FROM probes").fetchone()[0]
            self.assertGreaterEqual(probes_after_open, 1)
            probe.reset_probe_inflight_peak()
            before_in = probe.process_probe_inflight()
            for _ in range(2):
                hop_code, hop, _ = route.handle_route(
                    {"session": "hop", "session_id": sid},
                    {"X-402Signal-Trial": token},
                    "https://402signal.com/route",
                )
                self.assertEqual(hop_code, 200)
                self.assertTrue(hop.get("live"))
                self.assertEqual(hop.get("url"), WEATHER)
                self.assertEqual(hop["billing"]["settlement_state"], "not_attempted")
                self.assertFalse(hop["billing"].get("settled"))
            probes_after_hops = history._connect().execute("SELECT COUNT(*) FROM probes").fetchone()[0]
            self.assertEqual(probes_after_hops, probes_after_open)
            self.assertEqual(probe.process_probe_inflight(), before_in)
            self.assertEqual(probe.process_probe_inflight_peak(), before_in)
            verify.assert_not_called()
            settle.assert_not_called()
            self.assertEqual(body["session"]["hops_remaining"], 20)
            self.assertEqual(hop["session"]["hop_count"], 2)

    def test_hop_still_live_after_cache_ttl_inside_session_ttl(self):
        token = session.issue_trial()
        with patch.object(facilitator, "verify") as verify, patch.object(facilitator, "settle") as settle:
            code, body, _ = self._open(token)
            self.assertEqual(code, 200)
            self.assertTrue(body.get("live"))
            sid = body["session"]["id"]
            probes_after_open = history._connect().execute("SELECT COUNT(*) FROM probes").fetchone()[0]
            hop_at = int(body["session"]["expires_at"]) - session.SESSION_TTL_S + 21
            self.assertLess(hop_at, int(body["session"]["expires_at"]))
            with patch("live402.session.time.time", return_value=hop_at):
                hop_code, hop, _ = route.handle_route(
                    {"session": "hop", "session_id": sid},
                    {},
                    "https://402signal.com/route",
                )
            self.assertEqual(hop_code, 200)
            self.assertTrue(hop.get("live"))
            self.assertEqual(hop.get("url"), WEATHER)
            self.assertEqual(hop["billing"]["settlement_state"], "not_attempted")
            probes_after_hop = history._connect().execute("SELECT COUNT(*) FROM probes").fetchone()[0]
            self.assertEqual(probes_after_hop, probes_after_open)
            verify.assert_not_called()
            settle.assert_not_called()

    def test_hop_window_spent_after_10_minutes(self):
        token = session.issue_trial()
        code, body, _ = self._open(token)
        self.assertEqual(code, 200)
        sid = body["session"]["id"]
        with patch.object(facilitator, "verify") as verify, patch.object(facilitator, "settle") as settle:
            with patch("live402.session.time.time", return_value=int(body["session"]["expires_at"]) + 1):
                hop_code, hop, _ = route.handle_route(
                    {"session": "hop", "session_id": sid},
                    {},
                    "https://402signal.com/route",
                )
            self.assertEqual(hop_code, 200)
            self.assertFalse(hop.get("live"))
            self.assertEqual(hop.get("miss_reason"), "window_spent")
            verify.assert_not_called()
            settle.assert_not_called()

    def test_cached_probe_still_20s(self):
        os.environ["LIVE402_ROUTE_TRAFFIC_CLASS"] = "organic"
        result = probe.probe_url(WEATHER)
        self.assertTrue(result.get("live"))
        self.assertIsNotNone(session.cached_probe(WEATHER))
        with patch("live402.session.time.time", return_value=time.time() + 21):
            self.assertIsNone(session.cached_probe(WEATHER))

    def test_trial_does_not_move_public_last_success(self):
        token = session.issue_trial()
        before = history.summary(WEATHER)
        self.assertIsNone(before.get("last_success_402"))
        code, body, _ = self._open(token)
        self.assertEqual(code, 200)
        self.assertTrue(body.get("live"))
        after = history.summary(WEATHER)
        self.assertEqual(after["n_7d"], 0)
        self.assertIsNone(after.get("last_success_402"))
        stored = history._connect().execute("SELECT traffic_class FROM probes").fetchone()[0]
        self.assertEqual(stored, "sponsored")

    def test_trial_never_invokes_facilitator_settle(self):
        token = session.issue_trial()
        with patch.object(facilitator, "verify") as verify, patch.object(facilitator, "settle") as settle:
            self._open(token)
            verify.assert_not_called()
            settle.assert_not_called()

    def test_no_public_trial_mint(self):
        from http.client import HTTPConnection
        from http.server import ThreadingHTTPServer
        import threading
        from live402.server import Handler

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        port = httpd.server_address[1]
        try:
            for method, path in (("GET", "/trial/mint"), ("POST", "/trial/mint")):
                conn = HTTPConnection("127.0.0.1", port, timeout=5)
                try:
                    conn.request(method, path, body=b"{}", headers={"Content-Type": "application/json"})
                    res = conn.getresponse()
                    self.assertEqual(res.status, 404)
                    res.read()
                finally:
                    conn.close()
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=2)

    def test_trial_hash_at_rest(self):
        token = session.issue_trial()
        stored = session._connect().execute("SELECT token_hash FROM trial_credits").fetchall()
        self.assertEqual(len(stored), 1)
        self.assertEqual(stored[0][0], session._hash_secret(token))
        self.assertNotEqual(stored[0][0], token)
        blobs = []
        path = os.environ["LIVE402_SESSION_DB"]
        for suffix in ("", "-wal", "-shm"):
            try:
                with open(path + suffix, "rb") as fh:
                    blobs.append(fh.read())
            except FileNotFoundError:
                pass
        self.assertNotIn(token.encode(), b"".join(blobs))

    def test_issue_trial_does_not_reset_quota(self):
        token = session.issue_trial()
        for _ in range(3):
            code, body, _ = self._open(token)
            self.assertEqual(code, 200, body)
        headers = {"X-402Signal-Trial": token}
        self.assertEqual(session.trial_remaining(headers), 2)
        session.issue_trial(raw=token)
        self.assertEqual(session.trial_remaining(headers), 2)

    def test_session_db_wal_shm_are_0600(self):
        session.issue_trial()
        path = session.db_path()
        self.assertTrue(os.path.exists(path))
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600, path)
        for pth in (path + "-wal", path + "-shm"):
            if os.path.exists(pth):
                self.assertEqual(os.stat(pth).st_mode & 0o777, 0o600, pth)

    def test_unknown_hop_is_fingerprint_miss_without_facilitator(self):
        sid = "ab" * 32
        with patch.object(facilitator, "verify") as verify, patch.object(facilitator, "settle") as settle:
            code, body, _ = route.handle_route(
                {"session": "hop", "session_id": sid},
                {},
                "https://402signal.com/route",
            )
            self.assertEqual(code, 200)
            self.assertFalse(body.get("live"))
            self.assertEqual(body.get("miss_reason"), "fingerprint_miss")
            verify.assert_not_called()
            settle.assert_not_called()

    def test_twenty_first_hop_is_window_spent(self):
        token = session.issue_trial()
        code, body, _ = self._open(token)
        self.assertEqual(code, 200)
        sid = body["session"]["id"]
        with patch.object(facilitator, "verify") as verify, patch.object(facilitator, "settle") as settle:
            last = None
            for i in range(20):
                hop_code, hop, _ = route.handle_route(
                    {"session": "hop", "session_id": sid},
                    {},
                    "https://402signal.com/route",
                )
                self.assertEqual(hop_code, 200, hop)
                self.assertTrue(hop.get("live"), hop)
                self.assertEqual(hop["session"]["hop_count"], i + 1)
                last = hop
            spent_code, spent, _ = route.handle_route(
                {"session": "hop", "session_id": sid},
                {},
                "https://402signal.com/route",
            )
            self.assertEqual(spent_code, 200)
            self.assertFalse(spent.get("live"))
            self.assertEqual(spent.get("miss_reason"), "window_spent")
            self.assertEqual(last["session"]["hops_remaining"], 0)
            verify.assert_not_called()
            settle.assert_not_called()

    def test_sixth_trial_open_is_real_402(self):
        token = session.issue_trial()
        for _ in range(5):
            code, body, _ = self._open(token)
            self.assertEqual(code, 200, body)
        code, body, extra = self._open(token)
        self.assertEqual(code, 402)
        self.assertEqual(body.get("billing", {}).get("amount_atomic"), "5000")
        self.assertIn("PAYMENT-REQUIRED", extra or {})

    def test_trial_rejects_thorough(self):
        token = session.issue_trial()
        code, body, _ = self._open(token, search_depth="thorough")
        self.assertEqual(code, 400)
        self.assertEqual(body.get("miss_reason"), "invalid_need")

    def test_unpaid_session_open_challenges_005(self):
        code, body, extra = route.handle_route(
            {"url": WEATHER, "session": "open"},
            {},
            "https://402signal.com/route",
        )
        self.assertEqual(code, 402)
        self.assertEqual(body.get("amount"), "$0.005")
        self.assertEqual(body.get("billing", {}).get("amount_atomic"), "5000")


if __name__ == "__main__":
    unittest.main()
