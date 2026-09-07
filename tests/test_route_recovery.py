"""Synthetic HTTP recovery: retrieval never opens another economic execution."""
import copy
import http.client
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest
from contextlib import ExitStack
from unittest.mock import patch
from types import SimpleNamespace

from live402 import admission, discover, facilitator, history, mcp, payment, replay, route, server
from tests.test_pay_replay import _payload, _headers_for, _weather_body, _counting_facilitator


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.tmp = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.db = str(Path(self.tmp) / "replay.sqlite")
        self.stack.enter_context(patch.dict(os.environ, {
            "LIVE402_FIXTURE": "1", "LOCAL_FREE": "0", "LIVE402_REPLAY_DB": self.db,
            "LIVE402_REPLAY_BACKEND": "sqlite", "LIVE402_REPLAY_POSTGRES_DSN": "",
            "LIVE402_REPLAY_AUTHORITY_ID": "", "LIVE402_ADMISSION_POLICY_FILE": "",
            "LIVE402_HISTORY_DB": str(Path(self.tmp) / "history.sqlite"),
            "CDP_ACCESS_TOKEN": "synthetic-test-token",
        }))
        replay.reset()
        self.addCleanup(replay.reset_memory)
        policy = admission.Policy({
            "version": 1, "window_seconds": 60, "max_keys": 128,
            "ingress": {"global": 1, "anonymous": 1},
            "unpaid": {"global": 1, "anonymous": 1},
            "target": {"global": 1, "origin": 1, "failures": 1}, "customers": {},
        })
        self.recovery_engine = admission.Engine(policy)
        self.stack.enter_context(patch.object(admission, "_fallback_recovery", self.recovery_engine))
        self.verify_calls, self.settle_calls = [], []
        self.post = self.stack.enter_context(patch.object(facilitator, "post_json", side_effect=
            _counting_facilitator(self.verify_calls, self.settle_calls)))
        self.pq = self.stack.enter_context(patch.object(route, "_attach_pq_trust", side_effect=lambda code, result, body: result))
        self.algo = self.stack.enter_context(patch("live402.algo_tx.algorand_accept_extra", return_value={}))
        self.suggested = self.stack.enter_context(patch("live402.algod.suggested_params", return_value={}))
        class Quiet(server.Handler):
            def log_message(self, *args):
                pass
        self.httpd = server.BoundedThreadingHTTPServer(("127.0.0.1", 0), Quiet)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.payload = _payload("recovery-test")
        self.body = _weather_body()
        self.headers = dict(_headers_for(self.payload))

    def stop_server(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)

    def request(self, headers=None, body=None, path="/route", raw=None):
        data = json.dumps(self.body if body is None else body).encode() if raw is None else raw
        conn = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port, timeout=5)
        try:
            conn.putrequest("POST", path)
            conn.putheader("Content-Type", "application/json")
            conn.putheader("Content-Length", str(len(data)))
            pairs = (headers if isinstance(headers, list) else (headers or self.headers).items())
            for key, value in pairs:
                conn.putheader(key, value)
            conn.endheaders(data)
            response = conn.getresponse()
            return response.status, json.loads(response.read()), dict(response.getheaders())
        finally:
            conn.close()

    def recovery_headers(self, payload=None):
        return {**dict(_headers_for(payload or self.payload)), "Replay-Only": "1"}

    def seed(self):
        # Use real HTTP parsing, real route execution, fixture probes and mocked payment.
        with patch.object(server.Handler, "_route_allowed", return_value=True):
            result = self.request()
        self.assertEqual(result[0], 200, result)
        self.assertTrue(result[1]["billing"]["settled"], result)
        self.assertEqual((len(self.verify_calls), len(self.settle_calls)), (1, 1))
        return result

    def snapshot(self):
        rows = []
        if Path(self.db).exists():
            with sqlite3.connect(self.db) as conn:
                rows = conn.execute("SELECT * FROM settle_ledger ORDER BY fp_hash").fetchall()
        return rows, dict(replay._inflight), copy.deepcopy(replay._completed)

    def no_effects(self):
        stack = ExitStack()
        for target in ("live402.route.run_probe", "live402.route._attach_pq_trust",
                       "live402.facilitator.post_json", "live402.replay.begin",
                       "live402.replay.authorize", "live402.replay.finish",
                       "live402.admission.reserve", "live402.algo_tx.algorand_accept_extra",
                       "live402.algod.suggested_params"):
            stack.enter_context(patch(target, side_effect=AssertionError("recovery attempted execution: " + target)))
        return stack

    def test_http_recovery_bypasses_exhausted_normal_ingress_exactly_once(self):
        with patch.object(admission, "configured", return_value=True), patch.object(admission, "engine", return_value=self.recovery_engine):
            first = self.request()
            self.assertEqual(first[0], 200, first)
            self.assertTrue(first[1]["billing"]["settled"])
            before = self.snapshot()
            # One real ingress token was consumed by the successful initial route.
            blocked = self.request()
            self.assertEqual(blocked[0], 429)
            self.assertEqual(blocked[2]["Retry-After"], "60")
            self.assertEqual(blocked[2]["Cache-Control"], "no-store")
            self.assertFalse(blocked[1]["new_payment_allowed"])
            with self.no_effects(), patch.object(server.Handler, "_route_allowed", side_effect=AssertionError("normal ingress reached")):
                recovered = self.request(self.recovery_headers())
        self.assertEqual(recovered[:2], first[:2])
        self.assertEqual(recovered[2].get("PAYMENT-RESPONSE"), first[2].get("PAYMENT-RESPONSE"))
        self.assertIn("Replay-Only", recovered[2]["Access-Control-Allow-Headers"])
        self.assertEqual(self.snapshot(), before)
        self.assertEqual((len(self.verify_calls), len(self.settle_calls)), (1, 1))

    def test_wrong_missing_duplicate_keys_and_payment_headers_are_indistinguishable(self):
        self.seed()
        good = self.recovery_headers()
        cases = [
            {**good, "Replay-Key": "b2" * 32},
            {k: v for k, v in good.items() if k != "Replay-Key"},
            list(good.items()) + [("Replay-Key", good["Replay-Key"])],
            list(good.items()) + [("Replay-Only", "1")],
            list(good.items()) + [("PAYMENT-SIGNATURE", good["PAYMENT-SIGNATURE"])],
            list(good.items()) + [("X-PAYMENT", good["PAYMENT-SIGNATURE"])],
            {**good, "Replay-Only": "0"},
            {**good, "Replay-Only": "1, 1"},
        ]
        before = self.snapshot()
        # Limiter tests are separate; each malformed case reaches the retrieval gate.
        with patch.object(admission, "recovery", return_value=True), self.no_effects():
            results = [self.request(h)[:2] for h in cases]
        self.assertTrue(all(result == route.recovery_unavailable()[:2] for result in results), results)
        self.assertEqual(self.snapshot(), before)

    def test_changed_request_resource_or_authorization_never_opens_fresh_work(self):
        self.seed()
        before = self.snapshot()
        with self.no_effects():
            results = [
                self.request(self.recovery_headers(_payload("new-authorization"))),
                self.request(self.recovery_headers(), {**self.body, "need": "other"}),
                self.request(self.recovery_headers(_payload("recovery-test", "https://other.example/route"))),
            ]
        self.assertTrue(all(result[:2] == route.recovery_unavailable()[:2] for result in results))
        self.assertEqual(self.snapshot(), before)

    def test_signature_wrapper_change_preserves_same_authorization_with_private_key(self):
        first = self.seed()
        variant = copy.deepcopy(self.payload)
        variant["payload"]["signature"] = "0x" + "ef" * 65
        variant["resource"]["description"] = "unsigned wrapper"
        with self.no_effects():
            result = self.request(self.recovery_headers(variant))
        self.assertEqual(result[:2], first[:2])

    def test_restart_reads_persisted_outcome_without_writes_or_ttl_extension(self):
        first = self.seed()
        replay.reset_memory()
        before = self.snapshot()
        with patch.object(replay, "_connect", side_effect=AssertionError("must not initialize SQLite")), self.no_effects():
            result = self.request(self.recovery_headers())
        self.assertEqual(result[:2], first[:2])
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(replay._completed, {})

    def test_expired_outcome_fails_in_memory_and_after_restart(self):
        self.seed()
        before = self.snapshot()
        wall, mono = time.time(), replay.clock.monotonic()
        with patch.object(replay, "time", SimpleNamespace(time=lambda: wall + 121)), patch.object(replay, "clock", SimpleNamespace(monotonic=lambda: mono + 121)), self.no_effects():
            self.assertEqual(self.request(self.recovery_headers())[:2], route.recovery_unavailable()[:2])
        self.assertEqual(self.snapshot(), before)
        replay.reset_memory()
        with patch.object(replay, "time", SimpleNamespace(time=lambda: wall + 121)), self.no_effects():
            self.assertEqual(self.request(self.recovery_headers())[:2], route.recovery_unavailable()[:2])

    def test_inflight_miss_does_not_wait_or_create_state(self):
        accept = payment.match_accept(self.payload, payment.payment_required(discover.ROUTE, dynamic=False))
        fp = replay.canonical_fingerprint(self.payload, accept)
        scope = replay.request_scope(self.body, discover.ROUTE, self.headers)
        self.assertEqual(replay.begin(fp, scope=scope, reserve=False)[0], "run")
        before = self.snapshot()
        with patch.object(replay, "wait_result", side_effect=AssertionError("must not wait")), self.no_effects():
            result = self.request(self.recovery_headers())
        self.assertEqual(result[:2], route.recovery_unavailable()[:2])
        self.assertEqual(self.snapshot(), before)

    def test_cold_miss_does_not_create_database_or_inflight_even_local_free(self):
        with patch.dict(os.environ, {"LOCAL_FREE": "1"}), self.no_effects():
            result = self.request(self.recovery_headers())
            direct = route.handle_route(self.body, self.recovery_headers(), discover.ROUTE)
        self.assertEqual(result[:2], route.recovery_unavailable()[:2])
        self.assertEqual(direct[0], 503)
        self.assertEqual(direct[1]["error"], "recovery_unavailable")
        self.assertFalse(Path(self.db).exists())
        self.assertEqual((replay._inflight, replay._completed), ({}, {}))

    def test_cached_unknown_is_historical_uncertainty_not_payment_retry(self):
        accept = payment.match_accept(self.payload, payment.payment_required(discover.ROUTE, dynamic=False))
        fp = replay.canonical_fingerprint(self.payload, accept)
        scope = replay.request_scope(self.body, discover.ROUTE, self.headers)
        replay.begin(fp, scope=scope)
        unknown = route._unknown_outcome("base", attempted=True)
        replay.finish(fp, unknown, cache=True)
        for restart in (False, True):
            if restart:
                replay.reset_memory()
            before = self.snapshot()
            with self.no_effects():
                result = self.request(self.recovery_headers())
            self.assertEqual(result[:2], unknown[:2])
            self.assertEqual(self.snapshot(), before)

    def test_fenced_sqlite_source_denies_even_memory_hit(self):
        self.seed()
        with sqlite3.connect(self.db) as conn:
            conn.execute("INSERT INTO replay_meta(key,value) VALUES ('external_authority_id', ?)", ("ab" * 16,))
        before = self.snapshot()
        with self.no_effects():
            result = self.request(self.recovery_headers())
        self.assertEqual(result[:2], route.recovery_unavailable()[:2])
        self.assertEqual(self.snapshot(), before)

    def test_memory_cannot_override_durable_expiry_or_missing_row(self):
        self.seed()
        self.assertTrue(replay._completed)
        with sqlite3.connect(self.db) as conn:
            conn.execute("UPDATE settle_ledger SET expires_at = 1")
        before = self.snapshot()
        with self.no_effects():
            self.assertEqual(self.request(self.recovery_headers())[:2], route.recovery_unavailable()[:2])
        self.assertEqual(self.snapshot(), before)
        with sqlite3.connect(self.db) as conn:
            conn.execute("DELETE FROM settle_ledger")
        before = self.snapshot()
        with self.no_effects():
            self.assertEqual(self.request(self.recovery_headers())[:2], route.recovery_unavailable()[:2])
        self.assertEqual(self.snapshot(), before)

    def test_recovery_rate_limit_is_separate_and_bounded(self):
        first = self.seed()
        before = self.snapshot()
        with patch.object(server.Handler, "_route_allowed", side_effect=AssertionError("normal ingress reached")), self.no_effects():
            results = [self.request(self.recovery_headers()) for _ in range(7)]
        self.assertTrue(all(result[:2] == first[:2] for result in results[:6]))
        self.assertEqual(results[-1][0], 429)
        self.assertFalse(results[-1][1]["new_payment_allowed"])
        self.assertEqual(results[-1][2]["Retry-After"], "60")
        self.assertLessEqual(len(self.recovery_engine.recovery_buckets), self.recovery_engine.policy.max_keys)
        self.assertEqual(self.snapshot(), before)

    def test_mcp_and_other_endpoints_reject_recovery_before_execution(self):
        with self.no_effects(), patch.object(mcp, "_preview_result", side_effect=AssertionError("preview executed")):
            for path in ("/mcp", "/mcp.json", "/validate"):
                self.assertEqual(self.request(self.recovery_headers(), path=path)[0], 400)
            direct = mcp.handle_mcp({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "preview"}}, self.recovery_headers(), "https://402signal.com/mcp")
            self.assertEqual(direct[0], 400)

    def test_selected_postgres_lookup_has_no_sqlite_fallback_or_mutation(self):
        first = self.seed()
        accept = payment.match_accept(self.payload, payment.payment_required(discover.ROUTE, dynamic=False))
        fp = replay.canonical_fingerprint(self.payload, accept)
        scope = replay.request_scope(self.body, discover.ROUTE, self.headers)
        with sqlite3.connect(self.db) as conn:
            row = conn.execute("SELECT state,outcome_json,fingerprint_version,scope_hash,expires_at FROM settle_ledger").fetchone()
        replay.reset_memory()
        from unittest.mock import Mock
        from live402.replay_store import StoreError
        store = Mock()
        store.lookup.return_value = row
        with patch.object(replay, "backend_name", return_value="postgres"), patch.object(replay, "_selected_store_locked", return_value=store), patch.object(sqlite3, "connect", side_effect=AssertionError("SQLite fallback")), self.no_effects():
            result = replay.lookup_completed(fp, scope)
            self.assertEqual(result[:2], first[:2])
            store.lookup.assert_called_once_with(replay.durable_hash(fp))
            self.assertEqual([call[0] for call in store.mock_calls], ["lookup"])
            store.lookup.side_effect = StoreError("unavailable")
            self.assertIsNone(replay.lookup_completed(fp, scope))
        self.assertEqual((replay._inflight, replay._completed), ({}, {}))

    def test_recovery_body_bound_applies_before_lookup(self):
        with patch.object(server, "MAX_BODY", 64), self.no_effects(), patch.object(replay, "lookup_completed", side_effect=AssertionError("oversize lookup")):
            result = self.request(self.recovery_headers(), raw=b" " * 65)
        self.assertEqual(result[0], 413)
        self.assertFalse(Path(self.db).exists())


if __name__ == "__main__":
    unittest.main()
