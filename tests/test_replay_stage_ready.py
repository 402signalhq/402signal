import io
import json
import unittest
from unittest.mock import patch

from live402.replay_store import StoreError
from scripts.replay_stage_ready import main, stage_ready


class ReplayStageReady(unittest.TestCase):
    def settings(self, **changes):
        values = {
            "LIVE402_REPLAY_AUTHORITY_ID": "ab" * 16,
            "LIVE402_REPLAY_POSTGRES_DSN": "postgresql://router:NEVER_LOG@db.example/replay?sslmode=verify-full",
            "LIVE402_ROUTER_WRITERS": "1",
        }
        values.update(changes)
        return values

    def test_live_sqlite_writer_must_not_hold_the_dsn(self):
        with self.assertRaises(StoreError) as error:
            stage_ready(self.settings(FLY_APP_NAME="402signal"))
        self.assertNotIn("NEVER_LOG", str(error.exception))
        self.assertNotIn("db.example", str(error.exception))

    def test_live_postgres_writer_may_check_ready(self):
        with patch("live402.replay_postgres.PostgresStore") as store:
            store.return_value.ready.return_value = True
            self.assertTrue(stage_ready(self.settings(
                FLY_APP_NAME="402signal", LIVE402_REPLAY_BACKEND="postgres")))
            store.assert_called_once()

    def test_stdout_is_only_ok_boolean(self):
        with patch("scripts.replay_stage_ready.stage_ready", return_value=True), \
             patch("sys.stdout", new_callable=io.StringIO) as out:
            self.assertEqual(main(), 0)
            body = json.loads(out.getvalue())
            self.assertEqual(body, {"ok": True})
            self.assertNotIn("NEVER_LOG", out.getvalue())

    def test_failure_is_ok_false_not_a_dsn(self):
        with patch("scripts.replay_stage_ready.stage_ready", side_effect=StoreError("replay authority unavailable")), \
             patch("sys.stdout", new_callable=io.StringIO) as out:
            self.assertEqual(main(), 1)
            self.assertEqual(json.loads(out.getvalue()), {"ok": False})
            self.assertNotIn("unavailable", out.getvalue())

    def test_unexpected_exception_is_ok_false_not_a_traceback(self):
        with patch("scripts.replay_stage_ready.stage_ready", side_effect=RuntimeError("NEVER_LOG db.example")), \
             patch("sys.stdout", new_callable=io.StringIO) as out, \
             patch("sys.stderr", new_callable=io.StringIO) as err:
            self.assertEqual(main(), 1)
            self.assertEqual(json.loads(out.getvalue()), {"ok": False})
            self.assertNotIn("NEVER_LOG", out.getvalue() + err.getvalue())
            self.assertNotIn("Traceback", err.getvalue())


class CutoverRunbook(unittest.TestCase):
    def setUp(self):
        from pathlib import Path
        self.text = (Path(__file__).resolve().parents[1] / "docs/runbooks/postgres-replay-cutover.md").read_text()

    def test_replay_only_on_this_writer(self):
        self.assertIn("replay **only**", self.text.lower())
        self.assertIn("LIVE402_REPLAY_BACKEND=postgres", self.text)
        self.assertIn("402signal-replay-v2", self.text)
        self.assertIn("sslmode=verify-full", self.text)
        self.assertIn("iad", self.text)
        self.assertIn("6PN", self.text)
        self.assertIn("docs/route-recovery.md", self.text)
        self.assertIn("second nonce", self.text.lower())
        self.assertIn("source already fenced", self.text)
        self.assertIn("Do not run a cutover", self.text)
        self.assertIn("image variant", self.text)
        self.assertNotIn("TestNet", self.text)
        self.assertNotIn("min_machines_running = 2", self.text)
        self.assertNotIn("LIVE402_ROUTER_WRITERS=2", self.text)
        self.assertIn("Do **not** create a second cluster", self.text)
