"""Shadow catalog replica on disposable loopback PostgreSQL: outbox, drain, sweeps, event cap, backfill, parity, the guard."""

from __future__ import annotations

import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("LIVE402_FIXTURE", "1")

from live402 import catalog, catalog_replica, payment, shadow
from live402.history_replica import ReplicaUnavailable
from test_replay_storage import AUTHORITY

ROOT = Path(__file__).resolve().parents[1]
FUNCTIONS_SQL = ROOT / "ops" / "replay-postgres-functions.sql"
CATALOG_SQL = ROOT / "ops" / "catalog-postgres-managed.sql"
PASSWORD = "isolated-fixture-only"
WRITE_FUNCTIONS = ("api_apply", "api_meta_set")


def _item(url, description="weather forecast", **extra):
    row = {
        "url": url,
        "description": description,
        "serviceName": extra.pop("serviceName", None) or "Weather API",
        "accepts": extra.pop(
            "accepts",
            [{"network": "eip155:8453", "payTo": "0xabc", "amount": "10000", "asset": payment.USDC_BASE}],
        ),
        "_input_schema_present": extra.pop("_input_schema_present", True),
        "_output_schema_present": extra.pop("_output_schema_present", False),
        "capability": extra.pop("capability", "travel.weather"),
        "tags": extra.pop("tags", ["weather", "forecast"]),
    }
    row.update(extra)
    return catalog.slim_item(row, "base")


class CatalogSqlShape(unittest.TestCase):
    def test_installs_without_grant_or_revoke_and_never_touches_replay_rows(self):
        code = "\n".join(line.split("--", 1)[0] for line in CATALOG_SQL.read_text(encoding="utf-8").splitlines())
        self.assertIsNone(re.search(r"\b(GRANT|REVOKE)\b", code, re.IGNORECASE))
        self.assertNotRegex(code, r"(?i)(UPDATE|DELETE FROM|INSERT INTO)\s+signal_replay\.")
        for name in WRITE_FUNCTIONS:
            self.assertIn("signal_catalog.%s(" % name, code)
        bodies = code.split("CREATE OR REPLACE FUNCTION signal_catalog.")[1:]
        for body in bodies:
            name = body.split("(", 1)[0]
            if name == "guard":
                continue
            self.assertIn("PERFORM signal_catalog.guard();", body, name)

    def test_backend_names_and_sqlite_default_writes_no_outbox(self):
        with patch.dict(os.environ, {"LIVE402_CATALOG_BACKEND": ""}):
            self.assertEqual(catalog_replica.backend_name(), "sqlite")
            self.assertFalse(catalog_replica.dual())
        with patch.dict(os.environ, {"LIVE402_CATALOG_BACKEND": "bogus"}):
            with self.assertRaises(ValueError):
                catalog_replica.backend_name()
            self.assertFalse(catalog_replica.dual())
        tmp = tempfile.mkdtemp()
        with patch.dict(os.environ, {"LIVE402_CATALOG_DB": tmp + "/c.sqlite", "LIVE402_CATALOG_BACKEND": ""}):
            shadow.reset()
            shadow.upsert_item(_item("https://wx.example/a"), source="cdp", ts=100)
            with shadow._lock:
                conn = shadow._connect()
                self.assertEqual(conn.execute("SELECT count(*) FROM replica_outbox").fetchone()[0], 0)
                self.assertEqual(conn.execute("SELECT count(*) FROM resources").fetchone()[0], 1)
            shadow.reset()


@unittest.skipUnless(os.environ.get("LIVE402_PG_TEST_DESTRUCTIVE") == "isolated-ci-only",
                     "requires disposable loopback PostgreSQL")
class CatalogReplicaPostgres(unittest.TestCase):
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
            "LIVE402_CATALOG_BACKEND": "dual",
        }
        cls.admin.execute("DROP SCHEMA IF EXISTS signal_catalog CASCADE")
        cls.admin.execute("DROP SCHEMA IF EXISTS signal_replay CASCADE")
        cls.admin.execute(FUNCTIONS_SQL.read_text(encoding="utf-8"))
        cls.admin.execute(
            "INSERT INTO signal_replay.runtime_policy VALUES(TRUE,%s,'managed_runtime',"
            "(extract(epoch FROM pg_postmaster_start_time())*1000000)::bigint,inet_server_addr())",
            (AUTHORITY,))
        cls.admin.execute(CATALOG_SQL.read_text(encoding="utf-8"))
        cls.admin.execute(CATALOG_SQL.read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls):
        cls.admin.close()

    def setUp(self):
        for table in ("accept_claims", "resource_sources", "claim_events", "resources", "source_state", "replica_meta"):
            self.admin.execute("DELETE FROM signal_catalog.%s" % table)
        self.tmp = tempfile.mkdtemp()
        self.env = patch.dict(os.environ, {**self.settings, "LIVE402_CATALOG_DB": self.tmp + "/catalog.sqlite"})
        self.env.start()
        shadow.reset()
        catalog_replica.forget_replica()

    def tearDown(self):
        shadow.reset()
        catalog_replica.forget_replica()
        self.env.stop()

    def _pg(self, sql, params=()):
        return self.admin.execute(sql, params).fetchall()

    def _local(self, sql, params=()):
        with shadow._lock:
            return [tuple(r) for r in shadow._connect().execute(sql, params).fetchall()]

    def _outbox(self):
        return [json.loads(r[0]) for r in self._local("SELECT payload FROM replica_outbox ORDER BY id")]

    def _same(self, table, cols, order="id"):
        local = self._local("SELECT %s FROM %s ORDER BY %s" % (cols, table, order))
        remote = self._pg("SELECT %s FROM signal_catalog.%s ORDER BY %s" % (cols.replace("payTo", "payto"), table, order))
        self.assertEqual(local, remote, table)

    def test_upserts_queue_in_the_same_transaction_and_ship_in_order(self):
        shadow.upsert_items([_item("https://wx.example/a"), _item("https://wx.example/b", serviceName="B")], source="cdp", ts=100)
        shadow.upsert_item(_item("https://wx.example/a", accepts=[{"network": "eip155:8453", "payTo": "0xabc", "amount": "20000", "asset": payment.USDC_BASE}]), source="cdp", ts=200)
        queued = self._outbox()
        self.assertEqual(len(queued), 2)
        self.assertEqual(sorted(r["id"] for r in queued[0]["resources"]), [1, 2])
        self.assertEqual(queued[0]["claims_for"], [1, 2])
        # A new listing logs resource_added and rail_added; both ship with the same change set.
        self.assertEqual([e["event"] for e in queued[0]["claim_events"]], ["resource_added", "rail_added"] * 2)
        self.assertEqual(queued[1]["claims_for"], [1])
        self.assertEqual(catalog_replica.drain(), 2)
        self.assertEqual(self._outbox(), [])
        self._same("resources", "id, canonical_url, service_name, capability, status, last_seen, row_hash")
        self._same("resource_sources", "id, resource_id, source, source_generation, source_last_seen")
        self._same("accept_claims", "id, resource_id, source, network, amount_atomic, payTo")
        self._same("claim_events", "id, resource_id, canonical_url, event, source, ts")
        # Claims are replaced per listing: the price change left one current claim row for listing 1.
        self.assertEqual(self._pg("SELECT amount_atomic FROM signal_catalog.accept_claims WHERE resource_id = 1"), [("20000",)])
        catalog_replica.replica().apply(queued[1])
        self.assertEqual(self._pg("SELECT count(*) FROM signal_catalog.resources"), [(2,)])

    def test_touches_sweeps_retirements_and_the_event_cap_ship(self):
        keep, drop = _item("https://wx.example/keep"), _item("https://wx.example/drop")
        gen1 = shadow.begin_sweep("cdp", ts=100)
        shadow.ingest_page("cdp", [keep, drop], offset=0, last=True, upstream_total=2, step=2, ts=100)
        shadow.touch_searched(["https://wx.example/keep", "https://missing.example/x"], ts=150)
        shadow.touch_routed(["https://wx.example/drop"], ts=160)
        shadow.mark_verified("https://wx.example/keep", ts=170, ok=True)
        shadow.begin_sweep("cdp", ts=200)
        shadow.ingest_page("cdp", [keep], offset=0, last=True, upstream_total=1, step=1, ts=200)
        self.assertEqual(shadow.resource_status("https://wx.example/drop"), "retired")
        self.assertGreaterEqual(catalog_replica.drain(), 6)
        self._same("resources", "id, canonical_url, status, retired_at, last_searched, last_routed, last_verified, last_probe_ok")
        self._same("source_state", "source, generation, cursor, last_complete_sweep_at", order="source")
        self._same("claim_events", "id, resource_id, event, ts")
        self.assertEqual(self._pg("SELECT status FROM signal_catalog.resources WHERE canonical_url = 'https://wx.example/drop'"), [("retired",)])
        self.assertEqual(self._pg("SELECT generation FROM signal_catalog.source_state WHERE source = 'cdp'"), [(gen1 + 1,)])
        # The event cap deletes on both sides.
        with patch.object(shadow, "EVENT_CAP", 2):
            shadow.upsert_item(_item("https://wx.example/c"), source="cdp", ts=300)
        self.assertIn("deleted_events", self._outbox()[-1])
        catalog_replica.drain()
        self._same("claim_events", "id, resource_id, event, ts")
        self.assertEqual(self._pg("SELECT count(*) FROM signal_catalog.claim_events"), [(2,)])

    def test_replica_outage_keeps_the_outbox_and_the_next_drain_catches_up(self):
        from psycopg.conninfo import conninfo_to_dict, make_conninfo

        shadow.upsert_item(_item("https://wx.example/a"), source="cdp", ts=100)
        cfg = conninfo_to_dict(self.runtime_dsn)
        cfg["port"] = "1"
        broken = dict(self.settings, LIVE402_REPLAY_POSTGRES_DSN=make_conninfo(**cfg))
        from live402.history_replica import PostgresReplica

        with patch.object(catalog_replica, "_replica", PostgresReplica(environ=broken, schema="signal_catalog")):
            with self.assertRaises(ReplicaUnavailable) as caught:
                catalog_replica.drain()
        # The log line names the error class and a trimmed message, never a connection string.
        self.assertIn("OperationalError", caught.exception.detail)
        self.assertNotIn("password", caught.exception.detail)
        self.assertEqual(len(self._outbox()), 1)
        catalog_replica.forget_replica()
        self.assertEqual(catalog_replica.drain(), 1)
        self.assertEqual(self._pg("SELECT count(*) FROM signal_catalog.resources"), [(1,)])

    def test_backfill_copies_an_existing_file_once_and_parity_holds(self):
        with patch.dict(os.environ, {"LIVE402_CATALOG_BACKEND": ""}):
            shadow.begin_sweep("cdp", ts=50)
            shadow.ingest_page("cdp", [_item("https://wx.example/%d" % i) for i in range(5)], offset=0, last=True, upstream_total=5, step=5, ts=100)
            shadow.mark_verified("https://wx.example/1", ts=120, ok=False)
        self.assertEqual(self._outbox(), [])
        steps = []
        while True:
            step = catalog_replica.backfill_step(chunk=2)
            if step is None:
                break
            steps.append(step)
            if step["done"]:
                break
        # Phase one ships the sweep state and the claim events (chunked); phase two the listings.
        self.assertEqual([(s["phase"], s["cursor"]) for s in steps], [("events", 0), ("resources", 2), ("resources", 4), ("resources", 5)])
        self.assertEqual(steps[0]["source_state"], 1)
        self.assertEqual(steps[0]["claim_events"], 10)  # resource_added and rail_added per listing
        self.assertEqual(steps[1].get("claim_events", 0), 0)
        self.assertIsNone(catalog_replica.backfill_step(chunk=2))
        self._same("resources", "id, canonical_url, status, last_verified, last_probe_ok")
        self._same("accept_claims", "id, resource_id, source, network, amount_atomic, payTo")
        result = catalog_replica.parity()
        self.assertTrue(result["ok"], result)
        shadow.upsert_item(_item("https://wx.example/new"), source="cdp", ts=300)
        self.assertFalse(catalog_replica.parity()["ok"])
        catalog_replica.drain()
        self.assertTrue(catalog_replica.parity()["ok"])
        self.assertEqual(json.loads(self._pg("SELECT value FROM signal_catalog.replica_meta WHERE key = 'parity'")[0][0])["ok"], True)

    def test_guard_refuses_every_other_login(self):
        other = self.psycopg.connect(self.other_dsn, autocommit=True)
        try:
            with self.assertRaises(self.psycopg.Error):
                other.execute("SELECT * FROM signal_catalog.api_apply(%s::jsonb)", ('{"resources": []}',))
            runtime = self.psycopg.connect(self.runtime_dsn, autocommit=True)
            try:
                with self.assertRaises(self.psycopg.Error):
                    runtime.execute("INSERT INTO signal_catalog.source_state (source) VALUES ('x')")
                self.assertEqual(runtime.execute("SELECT count(*) FROM signal_catalog.resources").fetchone()[0], 0)
            finally:
                runtime.close()
        finally:
            other.close()

    def test_maintenance_jobs_run_on_the_writer(self):
        from live402 import leadership, maintenance

        shadow.upsert_item(_item("https://wx.example/a"), source="cdp", ts=100)
        with patch.object(leadership, "holds", return_value=True):
            maintenance._last.clear()
            ran = maintenance.run_due(now=1.0)
        for job in ("catalog_replica_drain", "catalog_replica_backfill", "catalog_replica_parity"):
            self.assertIn(job, ran)
        self.assertEqual(self._pg("SELECT count(*) FROM signal_catalog.resources"), [(1,)])
        maintenance._last.clear()
