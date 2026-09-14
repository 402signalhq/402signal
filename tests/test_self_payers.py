"""Operator wallets paying for real checks: observations organic, demand labelled self."""

from __future__ import annotations

import hashlib
import os
import tempfile
import time
import unittest
from unittest.mock import patch

os.environ.setdefault("LIVE402_FIXTURE", "1")

from live402 import metrics, reqctx, route, self_payers, session

EVM = "0xAbC0000000000000000000000000000000000001"
SOL = "C8qDYG8NTyvdY85gvGfs1WajwGhiLu6f1vi3JaG1r1iA"


class SelfPayerListTests(unittest.TestCase):
    def test_list_is_read_from_the_environment_and_normalised(self):
        with patch.dict(os.environ, {self_payers.ENV: " %s , %s ,, " % (EVM, SOL)}):
            self.assertEqual(self_payers.configured(), frozenset({EVM.lower(), SOL}))
            self.assertTrue(self_payers.is_self(EVM))
            self.assertTrue(self_payers.is_self(EVM.lower()))
            self.assertTrue(self_payers.is_self(SOL))
            self.assertFalse(self_payers.is_self(SOL.lower()))
            self.assertFalse(self_payers.is_self("0x0000000000000000000000000000000000000002"))
            self.assertFalse(self_payers.is_self(None))
            self.assertFalse(self_payers.is_self(""))
        with patch.dict(os.environ, {self_payers.ENV: ""}):
            self.assertEqual(self_payers.configured(), frozenset())
            self.assertFalse(self_payers.is_self(EVM))


class SelfPayerLabelTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self._prev = os.environ.get("LIVE402_SESSION_DB")
        os.environ["LIVE402_SESSION_DB"] = os.path.join(self.tmp.name, "session.sqlite")
        self.addCleanup(session.reset)

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("LIVE402_SESSION_DB", None)
        else:
            os.environ["LIVE402_SESSION_DB"] = self._prev

    def test_metrics_label_says_self_only_while_the_flag_is_set(self):
        token = reqctx.traffic_class.set("organic")
        try:
            self.assertEqual(metrics.traffic_label(), "organic")
            flag = reqctx.self_payer.set(True)
            try:
                self.assertEqual(metrics.traffic_label(), "self")
                # An explicit value is never overridden.
                self.assertEqual(metrics.traffic_label("organic"), "organic")
            finally:
                reqctx.self_payer.reset(flag)
            self.assertEqual(metrics.traffic_label(), "organic")
        finally:
            reqctx.traffic_class.reset(token)

    def test_payer_day_and_north_star_file_the_operator_under_self(self):
        now = time.time()
        token = reqctx.traffic_class.set("organic")
        flag = reqctx.self_payer.set(True)
        try:
            route._remember_payer(EVM)
        finally:
            reqctx.self_payer.reset(flag)
            reqctx.traffic_class.reset(token)
        day = time.strftime("%Y-%m-%d", time.gmtime(now))
        session.add_counters(day, {"route.settled.self": 2, "route.qualified.self": 2,
                                   "route.settled.organic": 1, "route.qualified.organic": 1})
        snap = session.north_star(7, now=now)
        self.assertEqual((snap["receipts_organic"], snap["settled_organic"], snap["distinct_payers_organic"]), (1, 1, 0))
        self.assertEqual((snap["receipts_self"], snap["settled_self"], snap["distinct_payers_self"]), (2, 2, 1))
        self.assertEqual(snap["distinct_payers_all"], 1)
        digest = hashlib.sha256(EVM.encode("utf-8")).hexdigest()
        self.assertFalse(session.record_payer(digest, "self", now=now))  # already recorded today

    def test_paid_execute_resets_the_flag_after_the_request(self):
        def inner(*_args, **_kwargs):
            reqctx.self_payer.set(True)
            self.assertEqual(metrics.traffic_label(), "self")
            return 200, {}, None

        with patch.object(route, "_paid_execute_inner", side_effect=inner):
            out = route._paid_execute({}, {}, {}, "https://402signal.com/route", None, 0.0, "fp")
        self.assertEqual(out[0], 200)
        self.assertFalse(reqctx.self_payer.get())
        self.assertNotEqual(metrics.traffic_label(), "self")


if __name__ == "__main__":
    unittest.main()
