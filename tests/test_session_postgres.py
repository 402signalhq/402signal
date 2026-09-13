"""Shared session store on disposable loopback PostgreSQL: windows, credits, counters, alerts, the copy, the guard."""

from __future__ import annotations

import hashlib
import os
import re
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("LIVE402_FIXTURE", "1")

from live402 import session, session_store
from live402.session_store import StoreUnavailable
from test_replay_storage import AUTHORITY

ROOT = Path(__file__).resolve().parents[1]
FUNCTIONS_SQL = ROOT / "ops" / "replay-postgres-functions.sql"
SESSION_SQL = ROOT / "ops" / "session-postgres-managed.sql"
PASSWORD = "isolated-fixture-only"
WRITE_FUNCTIONS = (
    "api_window_open", "api_window_hop", "api_trial_issue", "api_trial_consume", "api_counter_add",
    "api_payer_record", "api_alert_sub_create", "api_alert_sub_cursor", "api_alert_sub_delivered",
    "api_alert_sub_failed", "api_alert_sub_delete", "api_alert_delivery_add", "api_alert_deliveries_prune",
    "api_prune", "api_import",
)


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sub_id(n: int) -> str:
    return "%016x" % n


class SessionSqlShape(unittest.TestCase):
    def test_installs_without_grant_or_revoke_and_never_touches_replay_rows(self):
        code = "\n".join(line.split("--", 1)[0] for line in SESSION_SQL.read_text(encoding="utf-8").splitlines())
        self.assertIsNone(re.search(r"\b(GRANT|REVOKE)\b", code, re.IGNORECASE))
        self.assertNotRegex(code, r"(?i)(UPDATE|DELETE FROM|INSERT INTO)\s+signal_replay\.")
        for name in WRITE_FUNCTIONS:
            self.assertIn("signal_session.%s(" % name, code)
        # Every write function starts with the guard.
        bodies = code.split("CREATE OR REPLACE FUNCTION signal_session.")[1:]
        for body in bodies:
            name = body.split("(", 1)[0]
            if name == "guard":
                continue
            self.assertIn("PERFORM signal_session.guard();", body, name)

    def test_backend_names(self):
        with patch.dict(os.environ, {"LIVE402_SESSION_BACKEND": ""}):
            self.assertEqual(session_store.backend_name(), "sqlite")
        with patch.dict(os.environ, {"LIVE402_SESSION_BACKEND": "Postgres"}):
            self.assertEqual(session_store.backend_name(), "postgres")
        with patch.dict(os.environ, {"LIVE402_SESSION_BACKEND": "bogus"}):
            with self.assertRaises(ValueError):
                session_store.backend_name()
            with self.assertRaises(StoreUnavailable):
                session.forget_store()
                session.store()
        session.forget_store()


@unittest.skipUnless(os.environ.get("LIVE402_PG_TEST_DESTRUCTIVE") == "isolated-ci-only",
                     "requires disposable loopback PostgreSQL")
class SessionStorePostgres(unittest.TestCase):
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
                # Utility statements take no bound parameters; both values are fixed identifiers here.
                cls.admin.execute("CREATE ROLE %s LOGIN PASSWORD '%s'" % (role, PASSWORD))
                cls.admin.execute("GRANT pg_read_all_data TO %s" % role)
        cls.runtime_dsn = make_conninfo(**dict(cfg, user="managed_runtime", password=PASSWORD))
        cls.other_dsn = make_conninfo(**dict(cfg, user="managed_other", password=PASSWORD))
        cls.settings = {
            "LIVE402_PG_TEST_SUPPORT": "1",
            "LIVE402_REPLAY_AUTHORITY_ID": AUTHORITY,
            "LIVE402_REPLAY_POSTGRES_DSN": cls.runtime_dsn,
            "LIVE402_REPLAY_POSTGRES_API": "functions-v1",
        }
        cls.admin.execute("DROP SCHEMA IF EXISTS signal_session CASCADE")
        cls.admin.execute("DROP SCHEMA IF EXISTS signal_replay CASCADE")
        cls.admin.execute(FUNCTIONS_SQL.read_text(encoding="utf-8"))
        cls.admin.execute(
            "INSERT INTO signal_replay.runtime_policy VALUES(TRUE,%s,'managed_runtime',"
            "(extract(epoch FROM pg_postmaster_start_time())*1000000)::bigint,inet_server_addr())",
            (AUTHORITY,))
        cls.admin.execute(SESSION_SQL.read_text(encoding="utf-8"))
        # Re-running the install is harmless.
        cls.admin.execute(SESSION_SQL.read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls):
        cls.admin.close()

    def setUp(self):
        for table in ("alert_deliveries", "alert_subscriptions", "windows", "trial_credits",
                      "metric_counters", "payer_days", "imports"):
            self.admin.execute("DELETE FROM signal_session.%s" % table)
        self.store = session_store.PostgresStore(environ=self.settings)

    def tearDown(self):
        self.store.close()
        session.forget_store()

    def _window(self, sid="a" * 64, now=1_000_000, ceiling=3, **over):
        row = {
            "id_hash": sid, "created_at": now, "expires_at": now + 600, "hop_ceiling": ceiling,
            "url": "https://seller.example/x", "rail": "eip155:8453", "scheme": "exact", "fingerprint": "fp",
            "mandate_hash": None, "offer_json": "{}", "traffic_class": "organic", "trial_hash": None, "sku": "session",
        }
        row.update(over)
        self.store.window_insert(row)
        return row

    def test_window_open_hop_until_spent_and_expiry(self):
        row = self._window()
        got = self.store.window_get(row["id_hash"])
        self.assertEqual(tuple(got)[:3], (row["expires_at"], 0, 3))
        self.assertEqual(tuple(got)[3:], ("https://seller.example/x", "eip155:8453", "exact", "fp", None, "{}", "organic"))
        self.assertEqual([self.store.window_hop(row["id_hash"], 1_000_100) for _ in range(4)], [1, 2, 3, None])
        self.assertIsNone(self.store.window_hop("b" * 64, 1_000_100))
        fresh = self._window(sid="c" * 64)
        self.assertIsNone(self.store.window_hop(fresh["id_hash"], fresh["expires_at"] + 1))
        self.assertEqual(self.store.window_hop(fresh["id_hash"], fresh["expires_at"]), 1)
        with self.assertRaises(StoreUnavailable):
            self._window(sid="not-hex")

    def test_credits_issue_consume_and_top_up(self):
        d = digest("token")
        self.store.trial_issue(d, 100, 1000, 2)
        self.assertEqual(tuple(self.store.trial_get(d)), (1000, 0, 2))
        self.assertEqual([self.store.trial_consume(d, 500) for _ in range(3)], [True, True, False])
        # A top-up refreshes the expiry, never lowers the ceiling, never resets what was used.
        self.store.trial_issue(d, 600, 2000, 1)
        self.assertEqual(tuple(self.store.trial_get(d)), (2000, 2, 2))
        self.store.trial_issue(d, 600, 2000, 5)
        self.assertEqual(tuple(self.store.trial_get(d)), (2000, 2, 5))
        self.assertTrue(self.store.trial_consume(d, 2000))
        self.assertFalse(self.store.trial_consume(d, 2001))
        self.assertIsNone(self.store.trial_get(digest("nope")))

    def test_counters_and_payer_days(self):
        self.store.counters_add("2026-09-13", [("route.qualified.organic", 3), ("route.qualified.lab", 2), ("zero", 0)])
        self.store.counters_add("2026-09-13", [("route.qualified.organic", 1)])
        self.store.counters_add("2026-09-01", [("route.qualified.organic", 50)])
        days = ["2026-09-13", "2026-09-12"]
        self.assertEqual(self.store.counters_sum(days, name="route.qualified.organic"), 4)
        self.assertEqual(self.store.counters_sum(days, prefix="route.qualified."), 6)
        self.assertEqual(self.store.counters_by_name(days), {"route.qualified.organic": 4, "route.qualified.lab": 2})
        self.assertTrue(self.store.payer_record("2026-09-13", digest("p1"), "organic"))
        self.assertFalse(self.store.payer_record("2026-09-13", digest("p1"), "organic"))
        self.assertTrue(self.store.payer_record("2026-09-12", digest("p1"), "organic"))
        self.assertTrue(self.store.payer_record("2026-09-13", digest("p2"), "lab"))
        self.assertEqual((self.store.payers_distinct(days, "organic"), self.store.payers_distinct(days)), (1, 2))

    def test_alert_subscriptions_lifecycle(self):
        st = self.store
        made = [st.alert_sub_create(sub_id(i), "owner-a", "https://hooks.example/x", '["h.example"]', '["price"]',
                                    "whsec_s", 1000 + i, "{}", 2) for i in range(3)]
        self.assertEqual(made, [True, True, False])
        self.assertIsNone(st.alert_sub_get(sub_id(0), "owner-b"))
        row = st.alert_sub_get(sub_id(0), "owner-a")
        self.assertEqual((row[0], row[1], row[6], row[7], row[8]), (sub_id(0), "owner-a", 1000, 1000, "{}"))
        self.assertEqual([r[0] for r in st.alert_sub_list("owner-a")], [sub_id(0), sub_id(1)])
        self.assertEqual(len(st.alert_sub_due(5000)), 2)
        st.alert_sub_cursor(sub_id(0), 4000, '{"u": true}')
        row = st.alert_sub_get(sub_id(0), "owner-a")
        self.assertEqual((row[7], row[8]), (4000, '{"u": true}'))
        for i in range(60):
            st.alert_delivery_add(sub_id(100 + i), sub_id(0), 5000 + i, "alerts", 500, 1, "HTTPError", 50)
        self.assertEqual(len(st.alert_deliveries(sub_id(0), 100)), 50)
        self.assertEqual(st.alert_deliveries(sub_id(0), 1)[0][0], sub_id(159))
        st.alert_sub_failed(sub_id(0), 20, 9000, 500, 6000, "delivery_failed")
        row = st.alert_sub_get(sub_id(0), "owner-a")
        self.assertEqual((row[10], row[11], row[12], row[13], row[14]), (500, 20, 9000, 6000, "delivery_failed"))
        self.assertEqual([r[0] for r in st.alert_sub_due(10_000)], [sub_id(1)])
        st.alert_sub_cursor(sub_id(0), 7000, "{}")
        self.assertEqual(st.alert_sub_get(sub_id(0), "owner-a")[7], 4000)
        st.alert_sub_delivered(sub_id(0), 9500, 200, 9499, '{"v": 1}')
        row = st.alert_sub_get(sub_id(0), "owner-a")
        self.assertEqual(tuple(row[7:]), (9499, '{"v": 1}', 9500, 200, 0, 0, None, None))
        st.alert_sub_delivered(sub_id(0), 9600, 204)
        self.assertEqual(tuple(st.alert_sub_get(sub_id(0), "owner-a")[7:11]), (9499, '{"v": 1}', 9600, 204))
        self.assertEqual(st.alert_deliveries_prune(5010), 0)
        self.assertEqual(st.alert_deliveries_prune(5020), 10)
        self.assertFalse(st.alert_sub_delete(sub_id(0), "owner-b"))
        self.assertTrue(st.alert_sub_delete(sub_id(0), "owner-a"))
        self.assertIsNone(st.alert_sub_get(sub_id(0), "owner-a"))
        self.assertEqual(st.alert_deliveries(sub_id(0), 5), [])
        self.assertTrue(st.alert_sub_create(sub_id(9), "owner-a", "https://hooks.example/x", "[]", "[]", "s", 1, "{}", 2))

    def test_prune_and_rollup(self):
        now = 50_000_000
        day = time.strftime("%Y-%m-%d", time.gmtime(now))
        self._window(sid="1" * 64, now=now - 40 * 86400)
        self._window(sid="2" * 64, now=now - 86400)
        self.assertEqual(self.store.window_hop("2" * 64, now - 86400 + 1), 1)
        self.store.trial_issue(digest("old"), now - 30 * 86400, now - 20 * 86400, 5)
        self.store.trial_issue(digest("new"), now, now + 86400, 5)
        self.store.counters_add("1970-01-05", [("x", 1)])
        self.store.counters_add(day, [("obs_cache.hit.organic", 2)])
        self.store.payer_record("1970-01-05", digest("p"), "organic")
        self.store.payer_record(day, digest("p"), "organic")
        cutoff = time.strftime("%Y-%m-%d", time.gmtime(now - 400 * 86400))
        self.assertEqual(self.store.prune(now, 35 * 86400, 7 * 86400, cutoff),
                         {"windows": 1, "trial_credits": 1, "metric_counters": 1, "payer_days": 1})
        roll = self.store.rollup(now - 7 * 86400, now, [day], "organic")
        self.assertEqual((roll["opens"], roll["hops"], roll["counters"], roll["distinct_payers"]),
                         (1, 1, {"obs_cache.hit.organic": 2}, 1))

    def test_other_logins_and_direct_writes_are_refused_and_drift_fences(self):
        other = session_store.PostgresStore(environ=dict(self.settings, LIVE402_REPLAY_POSTGRES_DSN=self.other_dsn))
        try:
            with self.assertRaises(StoreUnavailable):
                other.trial_issue(digest("x"), 1, 2, 3)
            with self.assertRaises(StoreUnavailable):
                other.window_hop("a" * 64, 1)
        finally:
            other.close()
        with self.psycopg.connect(self.runtime_dsn, autocommit=True) as conn:
            for query in (
                "INSERT INTO signal_session.payer_days (day, payer_hash, traffic) VALUES ('2026-01-01', '%s', 'x')" % digest("p"),
                "DELETE FROM signal_session.windows",
                "UPDATE signal_session.trial_credits SET opens_used = 0",
                "INSERT INTO signal_session.imports (source, rows_json) VALUES ('s', '{}')",
            ):
                with self.subTest(query=query), self.assertRaises(self.psycopg.errors.InsufficientPrivilege):
                    conn.execute(query)
        self.store.trial_issue(digest("ok"), 1, 2, 3)
        self.admin.execute("GRANT UPDATE(opens_used) ON signal_session.trial_credits TO managed_runtime")
        try:
            with self.assertRaises(StoreUnavailable):
                self.store.trial_issue(digest("drift"), 1, 2, 3)
        finally:
            self.admin.execute("REVOKE UPDATE(opens_used) ON signal_session.trial_credits FROM managed_runtime")
        self.store.trial_issue(digest("after"), 1, 2, 3)
        self.assertEqual(self.admin.execute("SELECT count(*) FROM signal_session.trial_credits").fetchone()[0], 2)
        self.assertEqual(self.admin.execute("SELECT count(*) FROM signal_replay.entries").fetchone()[0], 0)

    def _payload(self):
        return {
            "windows": [{
                "id_hash": "e" * 64, "created_at": 1, "expires_at": 601, "observed_at": 1, "hop_count": 2,
                "hop_ceiling": 20, "url": "https://s.example/x", "rail": None, "scheme": "exact", "fingerprint": "fp",
                "mandate_hash": None, "offer_json": "{}", "traffic_class": "organic", "trial_hash": None, "sku": "session",
            }],
            "trial_credits": [{"token_hash": digest("t"), "created_at": 1, "expires_at": 9999, "opens_used": 1, "open_ceiling": 5}],
            "metric_counters": [{"day": "2026-09-13", "name": "route.qualified.organic", "n": 7}],
            "payer_days": [{"day": "2026-09-13", "payer_hash": digest("p"), "traffic": "organic"}],
            "alert_subscriptions": [{
                "id": sub_id(1), "owner": "o", "url": "https://hooks.example/x", "hosts_json": "[]", "events_json": "[]",
                "secret": "s", "created_at": 1, "cursor_ts": 1, "state_json": "{}", "last_delivery_at": None,
                "last_status": None, "failures": 0, "next_attempt_at": 0, "disabled_at": None, "disabled_reason": None,
            }],
            "alert_deliveries": [{"id": sub_id(2), "subscription_id": sub_id(1), "ts": 2, "kind": "ping", "status": 200,
                                  "events": 0, "error": None}],
        }

    def test_import_runs_once_and_is_all_or_nothing(self):
        payload = self._payload()
        self.assertFalse(self.store.imported("sqlite:abc"))
        self.assertTrue(self.store.import_state("sqlite:abc", payload))
        self.assertTrue(self.store.imported("sqlite:abc"))
        self.assertFalse(self.store.import_state("sqlite:abc", payload))
        self.assertEqual(self.store.counters_sum(["2026-09-13"], name="route.qualified.organic"), 7)
        self.assertEqual(self.store.window_get("e" * 64)[1], 2)
        self.assertEqual(tuple(self.store.trial_get(digest("t"))), (9999, 1, 5))
        self.assertEqual(len(self.store.alert_deliveries(sub_id(1), 5)), 1)
        self.assertEqual(self.store.alert_sub_get(sub_id(1), "o")[1], "o")
        bad = dict(payload, windows=[dict(payload["windows"][0], id_hash="not-hex")])
        with self.assertRaises(StoreUnavailable):
            self.store.import_state("sqlite:def", bad)
        self.assertFalse(self.store.imported("sqlite:def"))
        self.assertEqual(self.store.counters_sum(["2026-09-13"], name="route.qualified.organic"), 7)

    def test_session_module_end_to_end_with_the_local_copy(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        env = dict(self.settings, LIVE402_SESSION_DB=os.path.join(tmp.name, "session.sqlite"))
        with patch.dict(os.environ, dict(env, LIVE402_SESSION_BACKEND="sqlite")):
            session.reset()
            token = session.issue_trial(ttl_s=3600, opens=3)
            session.add_counters("2026-09-13", {"route.qualified.organic": 5})
            self.assertEqual(session.trial_remaining({"X-402Signal-Trial": token}), 3)
            self.assertIsNone(session.import_local_state())
            session.forget_store()
        with patch.dict(os.environ, dict(env, LIVE402_SESSION_BACKEND="postgres")):
            session.forget_store()
            self.assertEqual(session.backend_name(), "postgres")
            done = session.import_local_state()
            self.assertEqual((done["imported"], done["trial_credits"], done["metric_counters"]), (True, 1, 1))
            self.assertEqual(session.import_local_state()["imported"], False)
            self.assertEqual(session.trial_remaining({"X-402Signal-Trial": token}), 3)
            self.assertEqual(session.store().counters_sum(["2026-09-13"], name="route.qualified.organic"), 5)
            result = {
                "url": "https://seller.example/x", "live": True, "payTo": "0x" + "3" * 40,
                "selected_payment": {"network": "eip155:8453", "payTo": "0x" + "3" * 40, "amount_atomic": 1000, "scheme": "exact"},
            }
            sid = session.open_window(result, {}, traffic_class="organic", trial_hash=None, sku="session")
            code, body, _ = session.handle_hop({"session": "hop", "session_id": sid}, {})
            self.assertEqual((code, body["session"]["hop_count"], body["session"]["hops_remaining"]), (200, 1, 19))
            self.assertEqual(self.admin.execute("SELECT hop_count FROM signal_session.windows").fetchone()[0], 1)
            self.assertTrue(session.record_payer(digest("payer"), "organic"))
            self.assertEqual(session.north_star(7)["distinct_payers_organic"], 1)
            self.assertEqual(session.prune(now=int(time.time()))["windows"], 0)
            stats = session.rollup_stats(int(time.time()) - 86400, int(time.time()) + 1)
            self.assertEqual((stats["opens"], stats["hops"], stats["distinct_payers"]), (1, 1, 1))
            session.forget_store()
        unreachable = "host=127.0.0.1 port=1 dbname=402signal_ci user=managed_runtime password=x sslmode=disable"
        with patch.dict(os.environ, dict(env, LIVE402_SESSION_BACKEND="postgres", LIVE402_REPLAY_POSTGRES_DSN=unreachable)):
            session.forget_store()
            code, body, headers = session.handle_hop({"session": "hop", "session_id": sid}, {})
            self.assertEqual((code, body["error"], headers["Retry-After"]), (503, "session_store_unavailable", "5"))
            self.assertEqual(session.trial_remaining({"X-402Signal-Trial": token}), 0)
            self.assertFalse(session.record_payer(digest("payer"), "organic"))
            with self.assertRaises(StoreUnavailable):
                session.add_counters("2026-09-13", {"x": 1})
            session.forget_store()
        session.reset()


if __name__ == "__main__":
    unittest.main()
