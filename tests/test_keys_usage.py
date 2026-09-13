"""GET /keys/usage: caller-scoped credit and key status, never a listing."""

from __future__ import annotations

import http.client
import json
import os
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

os.environ.setdefault("LIVE402_FIXTURE", "1")

from live402 import admission, keys, server, session


class KeysUsageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._prev = os.environ.get("LIVE402_SESSION_DB")
        os.environ["LIVE402_SESSION_DB"] = os.path.join(self.tmp.name, "session.sqlite")
        self.httpd = server.BoundedThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        session.reset()
        if self._prev is None:
            os.environ.pop("LIVE402_SESSION_DB", None)
        else:
            os.environ["LIVE402_SESSION_DB"] = self._prev
        self.tmp.cleanup()

    def _get(self, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request("GET", "/keys/usage", headers=headers or {})
            resp = conn.getresponse()
            return resp.status, dict(resp.getheaders()), json.loads(resp.read())
        finally:
            conn.close()

    def test_nothing_presented(self):
        status, headers, body = self._get()
        self.assertEqual(status, 200)
        self.assertEqual(body["credits"], {"presented": False})
        self.assertEqual(body["key"], {"presented": False})
        self.assertIn("no-store", headers.get("Cache-Control", ""))
        self.assertIn("check credits", body["how_to_get_credits"])

    def test_issued_credit_reports_its_own_balance_only(self):
        token = session.issue_trial(ttl_s=3600, opens=5)
        status, _, body = self._get({"X-402Signal-Trial": token})
        self.assertEqual(status, 200)
        credit = body["credits"]
        self.assertEqual((credit["recognized"], credit["active"], credit["remaining"], credit["used"], credit["ceiling"]), (True, True, 5, 0, 5))
        self.assertTrue(credit["expires_at"].endswith("Z"))
        self.assertNotIn(token, json.dumps(body))
        other = session.issue_trial(ttl_s=3600, opens=9)
        self.assertEqual(self._get({"X-402Signal-Trial": token})[2]["credits"]["ceiling"], 5)
        self.assertEqual(self._get({"X-402Signal-Trial": other})[2]["credits"]["ceiling"], 9)

    def test_unknown_or_expired_credit_reads_as_not_recognized_or_inactive(self):
        status, _, body = self._get({"X-402Signal-Trial": "A" * 40})
        self.assertEqual((status, body["credits"]["presented"], body["credits"]["recognized"]), (200, True, False))
        token = session.issue_trial(ttl_s=60, opens=2)
        with patch.object(keys.time, "time", return_value=time.time() + 3600):
            body = self._get({"X-402Signal-Trial": token})[2]
        self.assertEqual((body["credits"]["active"], body["credits"]["remaining"]), (False, 0))
        self.assertEqual(self._get({"X-402Signal-Trial": "short"})[2]["credits"], {"presented": False})

    def test_admission_key_reports_caps_only_when_configured_and_recognized(self):
        body = self._get({"X-402Signal-Key": "k" * 40})[2]
        self.assertEqual((body["key"]["presented"], body["key"]["recognized"]), (True, False))
        import hashlib
        raw = "customer-key-" + "x" * 30
        policy = admission.Policy({
            "version": 1, "window_seconds": 60, "max_keys": 1024,
            "ingress": {"global": 100, "anonymous": 10},
            "unpaid": {"global": 50, "anonymous": 5},
            "target": {"global": 10, "origin": 5, "failures": 5},
            "customers": {hashlib.sha256(raw.encode()).hexdigest(): {"ingress": 7, "unpaid": 3}},
        })
        engine = admission.Engine(policy, cold_start=True)
        with patch.object(admission, "engine", return_value=engine), patch.object(admission, "configured", return_value=True):
            body = self._get({"X-402Signal-Key": raw})[2]
            stranger = self._get({"X-402Signal-Key": "y" * 40})[2]
        self.assertEqual(body["key"]["recognized"], True)
        self.assertEqual(body["key"]["capacity"], {"ingress": 7, "unpaid": 3})
        self.assertEqual(body["key"]["window_seconds"], 60)
        self.assertNotIn(raw, json.dumps(body))
        self.assertEqual(stranger["key"]["recognized"], False)


if __name__ == "__main__":
    unittest.main()
