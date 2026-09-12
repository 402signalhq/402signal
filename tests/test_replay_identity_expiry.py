"""Replay identity expiry wiring and clean shutdown. No database server."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("LIVE402_FIXTURE", "1")

from live402 import leadership, maintenance, payment, replay, server, session

BASE = {"network": payment.BASE_CAIP2}


class AuthorizationExpiryTests(unittest.TestCase):
    def test_base_eip3009_and_permit2_expiry(self):
        self.assertEqual(
            payment.authorization_expiry({"payload": {"authorization": {"validBefore": "1789000000"}}}, BASE),
            1789000000.0,
        )
        self.assertEqual(
            payment.authorization_expiry({"payload": {"permit2Authorization": {"deadline": 1789000100}}}, BASE),
            1789000100.0,
        )

    def test_ambiguous_malformed_oversized_and_other_rails_never_expire(self):
        both = {"payload": {"authorization": {"validBefore": "1"}, "permit2Authorization": {"deadline": "2"}}}
        self.assertIsNone(payment.authorization_expiry(both, BASE))
        self.assertIsNone(payment.authorization_expiry({"payload": {"authorization": {"validBefore": "soon"}}}, BASE))
        self.assertIsNone(payment.authorization_expiry({"payload": {"authorization": {"validBefore": str(2**60)}}}, BASE))
        self.assertIsNone(payment.authorization_expiry(
            {"payload": {"authorization": {"validBefore": "1789000000"}}}, {"network": payment.SOLANA_MAINNET}))
        self.assertIsNone(payment.authorization_expiry(None, BASE))


class FakeStore:
    def __init__(self):
        self.reserved = []

    def lookup(self, key):
        return None

    def reserve(self, key, scope, expires, authorization_expires=None):
        self.reserved.append(authorization_expires)
        return True

    def finish(self, key, state, outcome, keep):
        return None

    def abandon(self, key):
        return None

    def ready(self):
        return True

    def close(self):
        return None


class ReplayWiringTests(unittest.TestCase):
    def test_authorization_expiry_reaches_the_durable_reservation(self):
        fake, fp = FakeStore(), "9" * 64
        with patch.object(replay, "_selected_store_locked", return_value=fake):
            kind, _entry = replay.begin(fp, scope=None, reserve=False, authorization_expires_at=1789000000.0)
            self.assertEqual(kind, "run")
            self.assertTrue(replay.authorize(fp))
            replay.finish(fp, (503, {"live": False}, None), cache=False)
        self.assertEqual(fake.reserved, [1789000000.0])

    def test_unknown_expiry_keeps_the_original_reservation_call(self):
        class ThreeArgumentStore(FakeStore):
            def reserve(self, key, scope, expires):
                self.reserved.append("v1")
                return True

        fake, fp = ThreeArgumentStore(), "8" * 64
        with patch.object(replay, "_selected_store_locked", return_value=fake):
            replay.begin(fp, scope=None, reserve=False)
            self.assertTrue(replay.authorize(fp))
            replay.finish(fp, (503, {"live": False}, None), cache=False)
        self.assertEqual(fake.reserved, ["v1"])

    def test_expiry_is_a_noop_without_store_support(self):
        with patch.object(replay, "_selected_store_locked", return_value=FakeStore()):
            self.assertEqual(replay.expire_identities(), 0)

        class ExpiringStore(FakeStore):
            def expire_identities(self, batch):
                return 4

        with patch.object(replay, "_selected_store_locked", return_value=ExpiringStore()):
            self.assertEqual(replay.expire_identities(), 4)


class MaintenanceExpiryTests(unittest.TestCase):
    def tearDown(self):
        maintenance._last.clear()

    def test_writer_runs_replay_expiry(self):
        maintenance._last.clear()
        quiet = {"session_prune": lambda: None, "metrics_flush": lambda: None, "replay_capacity": lambda: None}
        with patch.object(leadership, "holds", return_value=True), \
                patch.dict(maintenance._JOB_FUNCS, quiet), \
                patch.object(replay, "expire_identities", return_value=2) as expire:
            ran = maintenance.run_due(now=1e9)
        self.assertIn("replay_expire", ran)
        expire.assert_called_once_with(1000)

    def test_standby_never_expires(self):
        maintenance._last.clear()
        with patch.object(leadership, "holds", return_value=False), \
                patch.object(replay, "expire_identities") as expire:
            self.assertEqual(maintenance.run_due(now=1e9), [])
        expire.assert_not_called()


class CleanShutdownTests(unittest.TestCase):
    def test_sqlite_handles_close_and_reopen_lazily(self):
        with tempfile.TemporaryDirectory() as tmp, \
                patch.dict(os.environ, {"LIVE402_SESSION_DB": str(Path(tmp) / "session.sqlite")}):
            session.reset()
            try:
                session._connect()
                self.assertIsNotNone(session._conn)
                server._close_sqlite_connections()
                self.assertIsNone(session._conn)
                session._connect()
                self.assertIsNotNone(session._conn)
            finally:
                session.reset()


if __name__ == "__main__":
    unittest.main()
