"""Week 4 hardening: abuse identity, readiness cache, payment windows, SKU accounting, metrics."""

from __future__ import annotations

import base64
import json
import os
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from live402 import admission, catalog, discover, mcp, metrics, payment, probe, ready, replay, route, server, session
from scripts import organic_rollup


class RateKeyTests(unittest.TestCase):
    def test_ipv6_clients_collapse_to_their_64(self):
        self.assertEqual(server.rate_key_ip("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64")
        self.assertEqual(server.rate_key_ip("2001:db8:1:2:ffff:ffff:ffff:ffff"), "2001:db8:1:2::/64")
        self.assertNotEqual(server.rate_key_ip("2001:db8:1:3::1"), "2001:db8:1:2::/64")

    def test_ipv4_and_mapped_addresses_are_unchanged(self):
        self.assertEqual(server.rate_key_ip("203.0.113.9"), "203.0.113.9")
        self.assertEqual(server.rate_key_ip("::ffff:203.0.113.9"), "203.0.113.9")
        self.assertEqual(server.rate_key_ip("not-an-ip"), "not-an-ip")


class ReadinessCacheTests(unittest.TestCase):
    def setUp(self):
        ready.reset_cache()

    def tearDown(self):
        ready.reset_cache()

    def test_readiness_computed_once_per_window(self):
        calls = []

        def fake():
            calls.append(1)
            return {"ok": True, "checks": {"replay_ledger": True}}

        with patch.dict(os.environ, {"LIVE402_READY_CACHE_S": "5"}), \
                patch.object(ready, "readiness", side_effect=fake):
            first = ready.cached_readiness()
            second = ready.cached_readiness()
        self.assertEqual(len(calls), 1)
        self.assertEqual(first, second)

    def test_zero_window_is_uncached(self):
        with patch.dict(os.environ, {"LIVE402_READY_CACHE_S": "0"}), \
                patch.object(ready, "readiness", return_value={"ok": True, "checks": {}}) as fake:
            ready.cached_readiness()
            ready.cached_readiness()
        self.assertEqual(fake.call_count, 2)


def _base_payload(valid_before):
    return {
        "payload": {
            "authorization": {
                "from": "0x" + "1" * 40,
                "to": payment.DEFAULT_PAYTO,
                "value": "3000",
                "validAfter": "0",
                "validBefore": str(valid_before),
                "nonce": "0x" + "ab" * 32,
            }
        }
    }


class AuthorizationWindowTests(unittest.TestCase):
    BASE = {"network": payment.BASE_CAIP2}

    def test_base_window_is_bounded(self):
        now = 1_000_000
        limit = payment.MAX_AUTHORIZATION_LIFETIME_SECONDS
        self.assertIsNone(payment.authorization_window_error(_base_payload(now + 60), self.BASE, now=now))
        self.assertIsNone(payment.authorization_window_error(_base_payload(now + limit), self.BASE, now=now))
        self.assertEqual(
            payment.authorization_window_error(_base_payload(now + limit + 1), self.BASE, now=now),
            payment.AUTH_WINDOW_ERROR,
        )

    def test_permit2_deadline_is_bounded(self):
        now = 1_000_000
        body = {"payload": {"permit2Authorization": {"deadline": str(now + 86400)}}}
        self.assertEqual(payment.authorization_window_error(body, self.BASE, now=now), payment.AUTH_WINDOW_ERROR)

    def test_other_rails_and_malformed_fields_are_left_to_existing_checks(self):
        now = 1_000_000
        solana = {"network": payment.SOLANA_MAINNET}
        self.assertIsNone(payment.authorization_window_error(_base_payload(now + 10**6), solana, now=now))
        self.assertIsNone(payment.authorization_window_error(_base_payload("junk"), self.BASE, now=now))
        self.assertIsNone(payment.authorization_window_error({}, self.BASE, now=now))

    def _long_window_headers(self, resource):
        now = int(time.time())
        paid = {
            "x402Version": 2,
            "resource": {"url": resource},
            "accepted": {
                "scheme": "exact",
                "network": payment.BASE_CAIP2,
                "asset": payment.USDC_BASE,
                "amount": payment.AMOUNT_ATOMIC,
                "payTo": payment.payto_address(),
                "maxTimeoutSeconds": 60,
            },
            **_base_payload(now + 86400),
        }
        return {"PAYMENT-SIGNATURE": base64.b64encode(json.dumps(paid).encode("utf-8")).decode("ascii")}

    def test_route_refuses_a_long_window_before_verification_when_enforced(self):
        resource = discover.ROUTE
        headers = self._long_window_headers(resource)
        with patch.dict(os.environ, {"LIVE402_MAX_AUTH_LIFETIME_S": "900"}), \
                patch("live402.facilitator.verify") as verify, patch("live402.facilitator.settle") as settle:
            code, body, _extra = route._handle_route({"need": "weather"}, headers, resource)
        self.assertEqual(code, 402)
        self.assertEqual(body["error"], payment.AUTH_WINDOW_ERROR)
        verify.assert_not_called()
        settle.assert_not_called()

    def test_route_only_counts_a_long_window_by_default(self):
        resource = discover.ROUTE
        headers = self._long_window_headers(resource)
        metrics.snapshot(reset=True)
        saved = os.environ.pop("LIVE402_MAX_AUTH_LIFETIME_S", None)
        try:
            with patch("live402.facilitator.verify") as verify:
                verify.return_value.ok = False
                code, body, _extra = route._handle_route({"need": "weather"}, headers, resource)
        finally:
            if saved is not None:
                os.environ["LIVE402_MAX_AUTH_LIFETIME_S"] = saved
        self.assertEqual(code, 402)
        self.assertNotEqual(body.get("error"), payment.AUTH_WINDOW_ERROR)
        self.assertEqual(metrics.snapshot(reset=True).get("payment.long_window.base"), 1)


def _billing(atomic, display, *, attempted, settled, state):
    return {
        "model": payment.ROUTING_BILLING_MODEL,
        "condition": payment.ROUTING_SETTLEMENT_CONDITION,
        "asset": "USDC",
        "amount_atomic": atomic,
        "display_amount": display,
        "rail": "base",
        "settlement_attempted": attempted,
        "settled": settled,
        "settlement_state": state,
    }


class SessionSkuAccountingTests(unittest.TestCase):
    def test_settled_session_open_is_classified(self):
        body = {"live": True, "billing": _billing(
            payment.SESSION_AMOUNT_ATOMIC, payment.SESSION_AMOUNT_USD,
            attempted=True, settled=True, state="settled")}
        self.assertEqual(replay._explicit_outcome_state((200, body, None)), replay.STATE_SETTLED)

    def test_unsettled_session_open_is_not_recorded_as_settled(self):
        body = {"live": False, "billing": _billing(
            payment.SESSION_AMOUNT_ATOMIC, payment.SESSION_AMOUNT_USD,
            attempted=False, settled=False, state="not_attempted")}
        self.assertEqual(replay._explicit_outcome_state((503, body, None)), replay.STATE_NOT_SETTLED)

    def test_unknown_amounts_remain_unclassified(self):
        body = {"live": True, "billing": _billing("4000", "$0.004", attempted=True, settled=True, state="settled")}
        self.assertIsNone(replay._explicit_outcome_state((200, body, None)))

    def test_mcp_output_schema_allows_both_published_skus(self):
        billing = mcp.OUTPUT_SCHEMA["properties"]["billing"]["properties"]
        self.assertEqual(set(billing["amount_atomic"]["enum"]), {payment.AMOUNT_ATOMIC, payment.SESSION_AMOUNT_ATOMIC})
        self.assertEqual(set(billing["display_amount"]["enum"]), {payment.AMOUNT_USD, payment.SESSION_AMOUNT_USD})


class TreasuryGuardTests(unittest.TestCase):
    def test_unreviewed_override_refused_on_fly(self):
        env = {"FLY_APP_NAME": "402signal", "PAYTO_ADDRESS": "0x" + "2" * 40, "LIVE402_TREASURY_OVERRIDE_ACK": ""}
        with patch.dict(os.environ, env):
            with self.assertRaises(SystemExit):
                server.assert_pinned_treasury()

    def test_pinned_value_reviewed_override_and_local_runs_are_allowed(self):
        with patch.dict(os.environ, {"FLY_APP_NAME": "402signal", "PAYTO_ADDRESS": payment.DEFAULT_PAYTO}):
            server.assert_pinned_treasury()
        with patch.dict(os.environ, {"FLY_APP_NAME": "402signal", "PAYTO_ADDRESS": "0x" + "2" * 40,
                                     "LIVE402_TREASURY_OVERRIDE_ACK": server.TREASURY_OVERRIDE_ACK}):
            server.assert_pinned_treasury()
        saved = {k: os.environ.pop(k) for k in ("FLY_APP_NAME", "FLY_ALLOC_ID", "FLY_MACHINE_ID") if k in os.environ}
        try:
            with patch.dict(os.environ, {"PAYTO_ADDRESS": "0x" + "2" * 40}):
                server.assert_pinned_treasury()
        finally:
            os.environ.update(saved)


class SessionStorageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"LIVE402_SESSION_DB": str(Path(self.tmp.name) / "session.sqlite")})
        self.env.start()
        session.reset()
        metrics.snapshot(reset=True)

    def tearDown(self):
        session.reset()
        self.env.stop()
        self.tmp.cleanup()
        metrics.snapshot(reset=True)

    @staticmethod
    def _window(conn, id_hash, created, hops, cls="organic", sku="session"):
        conn.execute(
            "INSERT INTO windows (id_hash, created_at, expires_at, observed_at, hop_count, hop_ceiling, "
            "fingerprint, offer_json, traffic_class, sku) VALUES (?, ?, ?, ?, ?, 20, 'fp', '{}', ?, ?)",
            (id_hash, created, created + 600, created, hops, cls, sku),
        )

    def test_prune_drops_only_stale_rows(self):
        now = 50_000_000
        conn = session._connect()
        self._window(conn, "old", now - 40 * 86400, 1)
        self._window(conn, "recent", now - 86400, 3)
        conn.execute("INSERT INTO obs_cache (dest, rail, scheme, ts, body_json) VALUES ('https://a.example', 'base', 'exact', ?, '{}')", (now - 7200,))
        conn.execute("INSERT INTO obs_cache (dest, rail, scheme, ts, body_json) VALUES ('https://b.example', 'base', 'exact', ?, '{}')", (now - 5,))
        conn.execute("INSERT INTO trial_credits (token_hash, created_at, expires_at) VALUES ('t', ?, ?)", (now - 30 * 86400, now - 20 * 86400))
        conn.commit()
        removed = session.prune(now=now)
        self.assertEqual(removed, {"windows": 1, "obs_cache": 1, "trial_credits": 1, "metric_counters": 0})
        self.assertEqual([r[0] for r in conn.execute("SELECT id_hash FROM windows")], ["recent"])

    def test_metrics_flush_persists_and_accumulates_counters(self):
        metrics.inc("session.open.organic", 2)
        metrics.inc("session.open.organic")
        metrics.inc("Not A Valid Name!")
        self.assertEqual(metrics.flush(), {"session.open.organic": 3})
        metrics.inc("session.open.organic")
        metrics.flush()
        day = time.strftime("%Y-%m-%d", time.gmtime())
        row = session._connect().execute(
            "SELECT n FROM metric_counters WHERE day = ? AND name = ?", (day, "session.open.organic")
        ).fetchone()
        self.assertEqual(row[0], 4)

    def test_open_and_hop_are_counted_by_traffic_class(self):
        result = {
            "url": "https://seller.example/x",
            "live": True,
            "payTo": "0x" + "3" * 40,
            "selected_payment": {"network": payment.BASE_CAIP2, "payTo": "0x" + "3" * 40,
                                 "amount_atomic": 1000, "scheme": "exact"},
        }
        session_id = session.open_window(result, {}, traffic_class="organic", trial_hash=None, sku="session")
        code, body, _ = session.handle_hop({"session": "hop", "session_id": session_id}, {})
        self.assertEqual(code, 200, body)
        counts = metrics.snapshot()
        self.assertEqual(counts.get("session.open.organic"), 1)
        self.assertEqual(counts.get("session.hop.organic"), 1)


class DiscoveryCacheTests(unittest.TestCase):
    def setUp(self):
        catalog.reset_discovery_cache()

    def tearDown(self):
        catalog.reset_discovery_cache()

    def test_identical_searches_share_one_upstream_call_and_copies(self):
        upstream = {"items": [{"resource": "https://a.example"}], "error": None}
        with patch.dict(os.environ, {"LIVE402_DISCOVERY_CACHE_S": "60"}), \
                patch.object(catalog, "query_rail", return_value=upstream) as query:
            first = catalog._cached_query_rail("base", "Weather")
            second = catalog._cached_query_rail("base", "weather ")
        self.assertEqual(query.call_count, 1)
        self.assertEqual(first, second)
        first["items"].append({"resource": "mutated"})
        with patch.dict(os.environ, {"LIVE402_DISCOVERY_CACHE_S": "60"}), \
                patch.object(catalog, "query_rail", return_value=upstream):
            third = catalog._cached_query_rail("base", "weather")
        self.assertEqual(len(third["items"]), 1)

    def test_zero_window_disables_the_cache(self):
        with patch.dict(os.environ, {"LIVE402_DISCOVERY_CACHE_S": "0"}), \
                patch.object(catalog, "query_rail", return_value={"items": [], "error": None}) as query:
            catalog._cached_query_rail("base", "weather")
            catalog._cached_query_rail("base", "weather")
        self.assertEqual(query.call_count, 2)


class OrganicRollupTests(unittest.TestCase):
    def test_rollup_is_organic_only_private_and_applies_the_price_rule(self):
        now = 60_000_000
        with tempfile.TemporaryDirectory() as tmp:
            session_db = Path(tmp) / "session.sqlite"
            history_db = Path(tmp) / "history.sqlite"
            with patch.dict(os.environ, {"LIVE402_SESSION_DB": str(session_db)}):
                session.reset()
                try:
                    conn = session._connect()
                    SessionStorageTests._window(conn, "a", now - 3600, 4)
                    SessionStorageTests._window(conn, "b", now - 7200, 2)
                    SessionStorageTests._window(conn, "c", now - 3600, 10, cls="sponsored", sku="trial")
                    SessionStorageTests._window(conn, "d", now - 10 * 86400, 9)
                    conn.commit()
                    day = time.strftime("%Y-%m-%d", time.gmtime(now - 3600))
                    session.add_counters(day, {
                        "obs_cache.hit.organic": 3, "obs_cache.miss.organic": 1, "obs_cache.hit.sponsored": 50,
                        "route.qualified.organic": 2, "route.miss.organic": 2, "http429.route.rate_limit": 5,
                    })
                    hist = sqlite3.connect(history_db)
                    hist.execute("CREATE TABLE probes (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT, ts INTEGER, "
                                 "payTo TEXT, amount TEXT, traffic_class TEXT)")
                    rows = [
                        ("https://a.example/x", now - 300, "0x" + "aa" * 20, "1000", "organic"),
                        ("https://a.example/x", now - 200, "0x" + "bb" * 20, "1000", "organic"),
                        ("https://a.example/x", now - 100, "0x" + "aa" * 20, "1000", "organic"),
                        ("https://b.example/y", now - 300, "0x" + "cc" * 20, "1000", "organic"),
                        ("https://b.example/y", now - 200, "0x" + "cc" * 20, "1000", "organic"),
                        ("https://c.example/z", now - 300, "0x" + "dd" * 20, "1000", "sponsored"),
                        ("https://c.example/z", now - 200, "0x" + "ee" * 20, "2000", "sponsored"),
                    ]
                    hist.executemany("INSERT INTO probes (url, ts, payTo, amount, traffic_class) VALUES (?, ?, ?, ?, ?)", rows)
                    hist.commit()
                    hist.close()
                    report = organic_rollup.build(str(session_db), str(history_db), days=7, now=now)
                finally:
                    session.reset()
        self.assertEqual(report["session_opens_organic"], 2)
        self.assertEqual(report["session_hops_organic"], 6)
        self.assertEqual(report["hops_per_open"], 3.0)
        self.assertEqual(report["cache_hit_rate"], 0.75)
        self.assertEqual(report["qualify_rate"], 0.5)
        self.assertEqual(report["rate_limited_429_mix"], {"route.rate_limit": 5})
        self.assertEqual(report["top_flip_urls"], [{"url": "https://a.example/x", "payTo_flips": 2, "price_flips": 0, "total": 2}])
        self.assertEqual(report["price"]["decision"], "keep")
        self.assertEqual(report["price"]["session_open"], "$0.005")
        serialized = json.dumps(report) + organic_rollup.render_markdown(report)
        self.assertNotIn("0x" + "aa" * 20, serialized)
        self.assertNotIn("sponsored", serialized)

    def test_price_rule_never_moves_the_price(self):
        for hops, cache in ((5.0, 0.9), (1.0, 0.9), (5.0, 0.1), (None, None)):
            rec = organic_rollup.price_recommendation(hops, cache)
            self.assertEqual(rec["session_open"], "$0.005")
            self.assertEqual(rec["decision"], "keep")


class OperatorTunableTests(unittest.TestCase):
    def test_admission_overrides_are_bounded(self):
        with patch.dict(os.environ, {"X_WEEK4_CAP": "500"}):
            self.assertEqual(admission._env_capacity("X_WEEK4_CAP", 24), 500)
        with patch.dict(os.environ, {"X_WEEK4_CAP": "-5"}):
            self.assertEqual(admission._env_capacity("X_WEEK4_CAP", 24), 1)
        with patch.dict(os.environ, {"X_WEEK4_CAP": "junk"}):
            self.assertEqual(admission._env_capacity("X_WEEK4_CAP", 24), 24)

    def test_probe_slots_are_bounded(self):
        with patch.dict(os.environ, {"X_WEEK4_PROBES": "1000"}):
            self.assertEqual(probe._bounded_env_int("X_WEEK4_PROBES", 10, 4, 64), 64)
        with patch.dict(os.environ, {"X_WEEK4_PROBES": "1"}):
            self.assertEqual(probe._bounded_env_int("X_WEEK4_PROBES", 10, 4, 64), 4)

    def test_anonymous_discovery_total_leaves_headroom(self):
        self.assertLess(admission.DISCOVERY_ANONYMOUS_TOTAL, admission.DISCOVERY_GLOBAL)


class GracefulDrainTests(unittest.TestCase):
    def test_drain_waits_for_in_flight_requests_then_releases_the_lease(self):
        class Sock:
            closed = False

            def close(self):
                self.closed = True

        class FakeServer:
            socket = Sock()

        states = iter([(2, 2), (1, 2), (0, 2)])
        fake = FakeServer()
        with patch.object(server, "request_thread_stats", side_effect=lambda: next(states, (0, 2))), \
                patch.object(server.leadership, "release") as release, \
                patch.object(server.metrics, "flush", return_value={}):
            server.drain_and_release(fake, timeout=5)
        release.assert_called_once()
        self.assertTrue(fake.socket.closed)


if __name__ == "__main__":
    unittest.main()
