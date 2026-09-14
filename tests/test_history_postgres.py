"""Probe history replica on disposable loopback PostgreSQL: outbox, drain, deletes, backfill, parity, the guard."""

from __future__ import annotations

import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("LIVE402_FIXTURE", "1")

from live402 import history, history_replica
from live402.history_replica import ReplicaUnavailable
from test_replay_storage import AUTHORITY

ROOT = Path(__file__).resolve().parents[1]
FUNCTIONS_SQL = ROOT / "ops" / "replay-postgres-functions.sql"
HISTORY_SQL = ROOT / "ops" / "history-postgres-managed.sql"
PASSWORD = "isolated-fixture-only"
WRITE_FUNCTIONS = ("api_apply", "api_meta_set")
URL = "https://seller.example/x402"


def _snap(url=URL, ts=1_800_000_000, live=True, pay_to="0xabc", amount="1000", rail="base", **over):
    row = {
        "url": url, "ts": ts, "live": live, "payTo": pay_to, "amount": amount, "rail": rail,
        "status": 402 if live else 200, "latency_ms": 12, "_route_traffic_class": history.TRAFFIC_ORGANIC,
    }
    row.update(over)
    return row


class HistorySqlShape(unittest.TestCase):
    def test_installs_without_grant_or_revoke_and_never_touches_replay_rows(self):
        code = "\n".join(line.split("--", 1)[0] for line in HISTORY_SQL.read_text(encoding="utf-8").splitlines())
        self.assertIsNone(re.search(r"\b(GRANT|REVOKE)\b", code, re.IGNORECASE))
        self.assertNotRegex(code, r"(?i)(UPDATE|DELETE FROM|INSERT INTO)\s+signal_replay\.")
        for name in WRITE_FUNCTIONS:
            self.assertIn("signal_history.%s(" % name, code)
        bodies = code.split("CREATE OR REPLACE FUNCTION signal_history.")[1:]
        for body in bodies:
            name = body.split("(", 1)[0]
            if name == "guard":
                continue
            self.assertIn("PERFORM signal_history.guard();", body, name)

    def test_backend_names_and_sqlite_default_writes_no_outbox(self):
        with patch.dict(os.environ, {"LIVE402_HISTORY_BACKEND": ""}):
            self.assertEqual(history_replica.backend_name(), "sqlite")
            self.assertFalse(history_replica.dual())
        with patch.dict(os.environ, {"LIVE402_HISTORY_BACKEND": "Dual"}):
            self.assertEqual(history_replica.backend_name(), "dual")
        with patch.dict(os.environ, {"LIVE402_HISTORY_BACKEND": "bogus"}):
            with self.assertRaises(ValueError):
                history_replica.backend_name()
            self.assertFalse(history_replica.dual())
        tmp = tempfile.mkdtemp()
        with patch.dict(os.environ, {"LIVE402_HISTORY_DB": tmp + "/h.sqlite", "LIVE402_HISTORY_BACKEND": ""}):
            history.reset()
            history.record_probe(URL, _snap())
            with history._lock:
                conn = history._connect()
                self.assertEqual(conn.execute("SELECT count(*) FROM replica_outbox").fetchone()[0], 0)
                self.assertEqual(conn.execute("SELECT count(*) FROM probes").fetchone()[0], 1)
            history.reset()


@unittest.skipUnless(os.environ.get("LIVE402_PG_TEST_DESTRUCTIVE") == "isolated-ci-only",
                     "requires disposable loopback PostgreSQL")
class HistoryReplicaPostgres(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg
        from psycopg.conninfo import conninfo_to_dict, make_conninfo

        cfg = conninfo_to_dict(os.environ["LIVE402_PG_TEST_DSN"])
        if cfg.get("host") != "127.0.0.1" or cfg.get("dbname") != "402signal_ci":
            raise RuntimeError("refusing destructive tests outside loopback CI")
        cls.psycopg = psycopg
        cls.admin = psycopg.connect(**cfg, autocommit=True)
        for role in ("managed_runtime", "managed_other"):
            if not cls.admin.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (role,)).fetchone():
                cls.admin.execute("CREATE ROLE %s LOGIN PASSWORD '%s'" % (role, PASSWORD))
                cls.admin.execute("GRANT pg_read_all_data TO %s" % role)
        cls.runtime_dsn = make_conninfo(**dict(cfg, user="managed_runtime", password=PASSWORD))
        cls.other_dsn = make_conninfo(**dict(cfg, user="managed_other", password=PASSWORD))
        cls.settings = {
            "LIVE402_PG_TEST_SUPPORT": "1",
            "LIVE402_REPLAY_AUTHORITY_ID": AUTHORITY,
            "LIVE402_REPLAY_POSTGRES_DSN": cls.runtime_dsn,
            "LIVE402_REPLAY_POSTGRES_API": "functions-v1",
            "LIVE402_HISTORY_BACKEND": "dual",
        }
        cls.admin.execute("DROP SCHEMA IF EXISTS signal_history CASCADE")
        cls.admin.execute("DROP SCHEMA IF EXISTS signal_replay CASCADE")
        cls.admin.execute(FUNCTIONS_SQL.read_text(encoding="utf-8"))
        cls.admin.execute(
            "INSERT INTO signal_replay.runtime_policy VALUES(TRUE,%s,'managed_runtime',"
            "(extract(epoch FROM pg_postmaster_start_time())*1000000)::bigint,inet_server_addr())",
            (AUTHORITY,))
        cls.admin.execute(HISTORY_SQL.read_text(encoding="utf-8"))
        # Re-running the install is harmless.
        cls.admin.execute(HISTORY_SQL.read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls):
        cls.admin.close()

    def setUp(self):
        for table in ("observations", "probes", "url_state", "sealed_batches", "scoring_models", "replica_meta"):
            self.admin.execute("DELETE FROM signal_history.%s" % table)
        self.tmp = tempfile.mkdtemp()
        self.env = patch.dict(os.environ, {**self.settings, "LIVE402_HISTORY_DB": self.tmp + "/history.sqlite"})
        self.env.start()
        history.reset()
        history_replica.forget_replica()

    def tearDown(self):
        history.reset()
        history_replica.forget_replica()
        self.env.stop()

    def _pg(self, sql, params=()):
        return self.admin.execute(sql, params).fetchall()

    def _local(self, sql, params=()):
        with history._lock:
            return history._connect().execute(sql, params).fetchall()

    def _outbox(self):
        return [json.loads(r[0]) for r in self._local("SELECT payload FROM replica_outbox ORDER BY id")]

    def test_probe_writes_queue_in_the_same_transaction_and_ship_in_order(self):
        history.record_probe(URL, _snap(ts=100))
        history.record_probe(URL, _snap(ts=200, amount="2000"))
        queued = self._outbox()
        self.assertEqual([p["probes"][0]["id"] for p in queued], [1, 2])
        self.assertEqual(queued[0]["url_state"][0]["url"], URL)
        self.assertEqual(queued[1]["url_state"][0]["last_amount"], "2000")
        self.assertTrue(all(o["probe_id"] == 2 for o in queued[1]["observations"]))
        self.assertEqual(history_replica.drain(), 2)
        self.assertEqual(self._outbox(), [])
        self.assertEqual(self._pg("SELECT id, url, ts, amount, payto, trust_class, traffic_class FROM signal_history.probes ORDER BY id"),
                         [(1, URL, 100, "1000", "0xabc", "INDEPENDENT", "organic"), (2, URL, 200, "2000", "0xabc", "INDEPENDENT", "organic")])
        local_obs = self._local("SELECT id, probe_id, field, value FROM observations ORDER BY id")
        remote_obs = self._pg("SELECT id, probe_id, field, value FROM signal_history.observations ORDER BY id")
        self.assertEqual(local_obs, remote_obs)
        self.assertEqual(self._pg("SELECT last_amount, price_changed_at, last_checked FROM signal_history.url_state"),
                         [("2000", 200, 200)])
        # Re-shipping the same payload is harmless (idempotent upserts).
        history_replica.replica().apply(queued[1])
        self.assertEqual(self._pg("SELECT count(*) FROM signal_history.probes"), [(2,)])

    def test_caps_delete_on_both_sides(self):
        with patch.object(history, "PER_URL_CAP", 2):
            for ts in (10, 20, 30):
                history.record_probe(URL, _snap(ts=ts))
        self.assertEqual(self._outbox()[-1]["deleted_probes"], [1])
        history_replica.drain()
        self.assertEqual(self._pg("SELECT id FROM signal_history.probes ORDER BY id"), [(2,), (3,)])
        self.assertEqual(self._pg("SELECT count(*) FROM signal_history.observations WHERE probe_id = 1"), [(0,)])
        self.assertEqual(self._local("SELECT id FROM probes ORDER BY id"), [(2,), (3,)])

    def test_validate_clock_batch_settlement_claims_and_scoring_models_ship(self):
        history.touch_validate_clocks(URL, _snap(ts=50))
        self.assertEqual(list(self._outbox()[0]), ["url_state"])
        history.persist_route_batch("batch-1", [_snap(ts=60, batch_id="batch-1")])
        history.mark_batch_settled("batch-1", URL)
        history.record_claim(URL, {"payTo": "0xabc", "amount": "1000", "source": "catalog"}, ts=70)
        history.ensure_scoring_model({"model_id": "reputation-v2", "model_hash": "ab" * 32, "spec_json": "{}", "effective_ts": 1})
        history.seal_batch("batch-2")
        self.assertEqual(history_replica.drain(), 6)
        self.assertEqual(self._pg("SELECT trust_class, settled_route_observation FROM signal_history.probes"), [("ROUTE_SETTLED", 1)])
        self.assertEqual(self._pg("SELECT batch_id FROM signal_history.sealed_batches ORDER BY batch_id"), [("batch-1",), ("batch-2",)])
        self.assertEqual(self._pg("SELECT count(*) FROM signal_history.observations WHERE probe_id IS NULL AND source_type = 'catalog_claimed'"), [(3,)])
        self.assertEqual(self._pg("SELECT model_id FROM signal_history.scoring_models"), [("reputation-v2",)])
        self.assertEqual(self._pg("SELECT last_success_402, last_checked FROM signal_history.url_state"), [(60, 60)])

    def test_replica_outage_keeps_the_outbox_and_the_next_drain_catches_up(self):
        from psycopg.conninfo import conninfo_to_dict, make_conninfo

        history.record_probe(URL, _snap(ts=100))
        # Same settings, a port nothing listens on: a valid configuration whose connection fails.
        cfg = conninfo_to_dict(self.runtime_dsn)
        cfg["port"] = "1"
        broken = dict(self.settings, LIVE402_REPLAY_POSTGRES_DSN=make_conninfo(**cfg))
        with patch.object(history_replica, "_replica", history_replica.PostgresReplica(environ=broken)):
            with self.assertRaises(ReplicaUnavailable):
                history_replica.drain()
        self.assertEqual(len(self._outbox()), 1)
        history_replica.forget_replica()
        self.assertEqual(history_replica.drain(), 1)
        self.assertEqual(self._pg("SELECT count(*) FROM signal_history.probes"), [(1,)])

    def test_backfill_copies_an_existing_file_once_and_parity_holds(self):
        with patch.dict(os.environ, {"LIVE402_HISTORY_BACKEND": ""}):
            for ts in range(1, 6):
                history.record_probe(URL, _snap(ts=ts * 10))
            history.touch_validate_clocks("https://other.example/y", _snap(url="https://other.example/y", ts=5))
            history.seal_batch("old-batch")
            history.ensure_scoring_model({"model_id": "reputation-v1", "model_hash": "cd" * 32, "spec_json": "{}", "effective_ts": 1})
        self.assertEqual(self._outbox(), [])
        steps = []
        while True:
            step = history_replica.backfill_step(chunk=2)
            if step is None:
                break
            steps.append(step)
            if step["done"]:
                break
        self.assertEqual([s["cursor"] for s in steps], [2, 4, 5])
        self.assertEqual(steps[0]["url_state"], 2)
        self.assertEqual(steps[0]["sealed"], 1)
        self.assertEqual(steps[0]["scoring_models"], 1)
        self.assertIsNone(history_replica.backfill_step(chunk=2))
        self.assertEqual(self._pg("SELECT count(*) FROM signal_history.probes"), [(5,)])
        self.assertEqual(self._pg("SELECT value FROM signal_history.replica_meta WHERE key = 'backfill_done_at'") != [], True)
        result = history_replica.parity()
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["diffs"], {})
        # Live traffic after the backfill keeps parity through the outbox.
        history.record_probe(URL, _snap(ts=70))
        self.assertFalse(history_replica.parity()["ok"])
        history_replica.drain()
        self.assertTrue(history_replica.parity()["ok"])
        self.assertEqual(json.loads(self._pg("SELECT value FROM signal_history.replica_meta WHERE key = 'parity'")[0][0])["ok"], True)

    def test_guard_refuses_every_other_login(self):
        other = self.psycopg.connect(self.other_dsn, autocommit=True)
        try:
            with self.assertRaises(self.psycopg.Error):
                other.execute("SELECT * FROM signal_history.api_apply(%s::jsonb)", ('{"probes": []}',))
            with self.assertRaises(self.psycopg.Error):
                other.execute("INSERT INTO signal_history.sealed_batches VALUES ('x', 1)")
            # The runtime login reads but cannot write directly either.
            runtime = self.psycopg.connect(self.runtime_dsn, autocommit=True)
            try:
                with self.assertRaises(self.psycopg.Error):
                    runtime.execute("INSERT INTO signal_history.sealed_batches VALUES ('x', 1)")
                self.assertEqual(runtime.execute("SELECT count(*) FROM signal_history.probes").fetchone()[0], 0)
            finally:
                runtime.close()
        finally:
            other.close()

    def test_maintenance_jobs_run_on_the_writer(self):
        from live402 import leadership, maintenance

        history.record_probe(URL, _snap(ts=100))
        with patch.object(leadership, "holds", return_value=True):
            maintenance._last.clear()
            ran = maintenance.run_due(now=1.0)
        self.assertIn("history_replica_drain", ran)
        self.assertIn("history_replica_backfill", ran)
        self.assertIn("history_replica_parity", ran)
        self.assertEqual(self._pg("SELECT count(*) FROM signal_history.probes"), [(1,)])
        maintenance._last.clear()
