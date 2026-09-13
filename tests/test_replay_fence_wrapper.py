"""scripts/replay_fence.sh argument validation and external high-water handling (stub flyctl)."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WRAPPER = ROOT / "scripts" / "replay_fence.sh"
STUB = """#!/usr/bin/env bash
cat > "$STUB_SQL_LOG"
cat "$STUB_OUTPUT"
exit "${STUB_EXIT:-0}"
"""


@unittest.skipUnless(os.name == "posix" and shutil.which("bash"), "requires bash")
class ReplayFenceWrapper(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.flyctl = self.tmp / "flyctl"
        self.flyctl.write_text(STUB, encoding="utf-8")
        self.flyctl.chmod(0o700)
        self.sql_log = self.tmp / "sql.log"
        self.output = self.tmp / "output.txt"
        self.output.write_text("", encoding="utf-8")
        self.state_dir = self.tmp / "state"
        self.state = self.state_dir / "abcd1234efgh.replay_production.high-water"

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def run_wrapper(self, *args, output="", cluster="abcd1234efgh", exit_code=0):
        self.output.write_text(output, encoding="utf-8")
        if self.sql_log.exists():
            self.sql_log.unlink()
        env = dict(os.environ, FLYCTL=str(self.flyctl), STUB_SQL_LOG=str(self.sql_log),
                   STUB_OUTPUT=str(self.output), STUB_EXIT=str(exit_code),
                   FENCE_CLUSTER=cluster, FENCE_DATABASE="replay_production",
                   FENCE_STATE_DIR=str(self.state_dir))
        return subprocess.run(["bash", str(WRAPPER), *args], env=env, capture_output=True, text=True, timeout=30)

    def sql(self):
        return self.sql_log.read_text(encoding="utf-8") if self.sql_log.exists() else None

    def test_pinned_status_records_and_only_advances_the_high_water(self):
        result = self.run_wrapper("status", output="classification | pinned\nrecord | HIGH_WATER 2 1F/AF000130\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.state.read_text(encoding="utf-8"), "2 1F/AF000130\n")
        self.run_wrapper("status", output="record | HIGH_WATER 2 1F/0000FFFF\n")
        self.assertEqual(self.state.read_text(encoding="utf-8"), "2 1F/AF000130\n")
        self.run_wrapper("status", output="record | HIGH_WATER 3 1E/00000010\n")
        self.assertEqual(self.state.read_text(encoding="utf-8"), "3 1E/00000010\n")

    def test_unpinned_status_exits_3_without_recording(self):
        result = self.run_wrapper("status", output="classification | restart\nrecord |\n")
        self.assertEqual(result.returncode, 3)
        self.assertFalse(self.state.exists())

    def test_repin_restart_passes_the_external_high_water(self):
        self.state_dir.mkdir()
        self.state.write_text("2 1F/AF000130\n", encoding="utf-8")
        result = self.run_wrapper("repin-restart", output=" result\n restart_repin\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("fence_repin('restart', NULL, NULL, '1F/AF000130'::pg_lsn, 2)", self.sql())
        self.assertIn("ON_ERROR_STOP on", self.sql())

    def test_without_a_high_water_file_nulls_are_passed(self):
        self.run_wrapper("repin-restart", output="restart_repin\n")
        self.assertIn("NULL::pg_lsn, NULL::bigint", self.sql())

    def test_attested_repin_validates_before_connecting(self):
        for args in (("repin-attested", "abc", "reconciled against chain settlements"),
                     ("repin-attested", "12", "short"),
                     ("repin-attested", "12", "reconciled'; DROP TABLE x; --")):
            result = self.run_wrapper(*args)
            self.assertEqual(result.returncode, 2, args)
            self.assertIsNone(self.sql(), args)
        result = self.run_wrapper("repin-attested", "725", "reconciled against chain settlements", output="attested_repin\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("fence_repin('attested', 725, 'reconciled against chain settlements',", self.sql())

    def test_corrupt_state_and_invalid_cluster_are_refused(self):
        self.state_dir.mkdir()
        self.state.write_text("garbage\n", encoding="utf-8")
        self.assertEqual(self.run_wrapper("status").returncode, 2)
        self.assertIsNone(self.sql())
        self.assertEqual(self.run_wrapper("status", cluster="Bad Cluster!").returncode, 2)

    def test_connection_strings_are_never_printed_and_failures_propagate(self):
        result = self.run_wrapper("repin-restart", output="postgresql://user:secret@host/db\nERROR: nope\n", exit_code=1)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("secret", result.stdout + result.stderr)
        self.assertIn("ERROR: nope", result.stdout)


if __name__ == "__main__":
    unittest.main()
