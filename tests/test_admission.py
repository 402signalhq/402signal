"""Synthetic policy values only. All tests run in the isolated cloud worker."""
import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from email.message import Message
from unittest.mock import patch

from live402 import admission, discover, mcp, payment, probe, reqctx, server

KEY = "synthetic-customer-key-for-cloud-tests-only"
DIGEST = hashlib.sha256(KEY.encode()).hexdigest()

def policy():
    return {"version": 1, "window_seconds": 60, "max_keys": 64,
            "ingress": {"global": 1000, "anonymous": 3},
            "unpaid": {"global": 20, "anonymous": 2},
            "target": {"global": 100, "origin": 50, "failures": 2},
            "customers": {DIGEST: {"ingress": 100, "unpaid": 10}}}

class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.now = 10.0
        self.e = admission.Engine(admission.Policy(policy()), lambda: self.now)
        self.headers = {"X-402Signal-Key": KEY}

    def test_customer_can_exceed_twelve_without_sharing_nat_quota(self):
        self.assertTrue(all(self.e.ingress(self.headers, "same-ip") for _ in range(30)))
        self.assertTrue(all(self.e.ingress({}, "same-ip") for _ in range(3)))
        self.assertFalse(self.e.ingress({}, "same-ip"))

    def test_unknown_keys_do_not_create_new_identities(self):
        for i in range(3):
            self.assertTrue(self.e.ingress({"X-402Signal-Key": "x" * 40 + str(i)}, "peer"))
        self.assertFalse(self.e.ingress({"X-402Signal-Key": "different" * 6}, "peer"))
        self.assertEqual(len(self.e.buckets), 2)

    def test_duplicate_key_headers_cannot_authenticate(self):
        headers = Message()
        headers.add_header("X-402Signal-Key", KEY)
        headers.add_header("X-402Signal-Key", KEY)
        self.assertIsNone(self.e.identity(headers, "peer")[1])

    def test_confirmed_payment_refunds_once(self):
        leases = [self.e.reserve({}, "peer") for _ in range(2)]
        self.assertIsNone(self.e.reserve({}, "peer"))
        leases[0].finish(earned=True)
        leases[0].finish(earned=True)
        self.assertIsNotNone(self.e.reserve({}, "peer"))
        self.assertIsNone(self.e.reserve({}, "peer"))

    def test_failure_keeps_debit_even_if_called_success_later(self):
        lease = self.e.reserve({}, "peer")
        lease.finish(earned=False)
        lease.finish(earned=True)
        self.assertIsNotNone(self.e.reserve({}, "peer"))
        self.assertIsNone(self.e.reserve({}, "peer"))

    def test_global_budget_survives_identity_rotation(self):
        self.assertTrue(all(self.e.reserve({}, str(i)) for i in range(20)))
        self.assertIsNone(self.e.reserve(self.headers, "trusted"))

    def test_concurrent_reservation_never_exceeds_budget(self):
        with ThreadPoolExecutor(max_workers=20) as pool:
            leases = list(pool.map(lambda _: self.e.reserve(self.headers, "peer"), range(100)))
        self.assertEqual(sum(x is not None for x in leases), 10)

    def test_target_budget_not_bypassed_by_queries_paths_or_case(self):
        for url in ("https://BAD.example/a?q=1", "https://bad.example/b?q=2"):
            lease = self.e.probe(url)
            self.assertIsNotNone(lease)
            self.e.probe_complete(lease, False)
        self.assertIsNone(self.e.probe("https://bad.example./c?q=3"))

    def test_healthy_target_does_not_credit_unpaid_customer(self):
        lease = self.e.reserve({}, "peer")
        target = self.e.probe("https://api.example/x")
        self.e.probe_complete(target, True)
        self.assertEqual(self.e.buckets["unpaid:global"].balance, 19)
        lease.finish(False)
        self.assertEqual(self.e.buckets["probe:global"].balance, 99)

    def test_full_map_never_evicts_unspent_debits(self):
        p = policy();p["max_keys"] = 16;p["unpaid"]["global"] = 100
        e = admission.Engine(admission.Policy(p), lambda: self.now)
        for i in range(15): self.assertIsNotNone(e.reserve({}, str(i)))
        self.assertIsNone(e.reserve({}, "new"))
        self.assertEqual(len(e.buckets), 16)
        self.assertEqual(e.buckets["unpaid:global"].balance, 85)

    def test_refill_recovers_without_success_or_manual_intervention(self):
        for _ in range(2): self.e.reserve({}, "peer")
        self.now += 30
        self.assertIsNotNone(self.e.reserve({}, "peer"))
        self.assertIsNone(self.e.reserve({}, "peer"))

    def test_invalid_policy_rejects_nan_bool_and_unknown_fields(self):
        for bad in (float("nan"), True, 0, -1):
            p = policy();p["unpaid"]["global"] = bad
            with self.assertRaises(ValueError): admission.Policy(p)
        p = policy();p["allow_everything"] = True
        with self.assertRaises(ValueError): admission.Policy(p)

    def test_private_policy_permissions_and_generic_errors(self):
        with tempfile.TemporaryDirectory() as d:
            file = Path(d) / "policy.json";file.write_text(json.dumps(policy()));file.chmod(0o644)
            with patch.dict(os.environ, {"LIVE402_ADMISSION_POLICY_FILE": str(file)}):
                with self.assertRaises(admission.Unavailable) as exc: admission.engine()
                self.assertNotIn(str(file), str(exc.exception))
                self.assertFalse(admission.ingress(self.headers, "peer"))
            good = Path(d) / "private.json";good.write_text(json.dumps(policy()));good.chmod(0o600)
            with patch.dict(os.environ, {"LIVE402_ADMISSION_POLICY_FILE": str(good)}):
                self.assertTrue(admission.ready())
                self.assertFalse(admission.ingress(self.headers, "peer"))
                admission.engine().started_at -= 60
                self.assertTrue(admission.ingress(self.headers, "peer"))

    def test_probe_denial_does_not_execute_network_or_direct_history(self):
        with patch.object(admission, "reserve_probe", side_effect=admission.Unavailable), patch.object(probe, "_probe_url_unbudgeted") as network:
            result = probe.probe_url("https://example.com")
            self.assertEqual(result["miss_reason"], "probe_capacity")
            network.assert_not_called()

    def test_invalid_policy_cannot_fall_back_to_legacy_http_capacity(self):
        handler = object.__new__(server.Handler)
        handler.headers = {}
        handler.client_address = ("127.0.0.1", 1000)
        with patch.dict(os.environ, {"LIVE402_ADMISSION_POLICY_FILE": "/no/such/private/policy"}), patch.object(server, "client_ip", return_value="peer"), patch.object(server._ROUTE_LIMITER, "allow") as legacy:
            self.assertFalse(handler._route_allowed())
            legacy.assert_not_called()

    def test_preview_and_validate_share_discovery_not_unpaid(self):
        handler = object.__new__(server.Handler);handler.headers=self.headers
        unpaid_before = self.e.buckets.get("unpaid:global")
        unpaid_balance = unpaid_before.balance if unpaid_before else None
        with patch.object(admission, "engine", return_value=self.e), patch.object(admission, "configured", return_value=True), patch.object(server, "client_ip", return_value="peer"):
            self.assertTrue(all(handler._preview_allowed() for _ in range(4)))
            self.assertTrue(all(handler._validate_allowed() for _ in range(4)))
            self.assertFalse(handler._preview_allowed())
            self.assertFalse(handler._validate_allowed())
            self.assertTrue(handler._route_allowed())
        if unpaid_balance is None:
            self.assertNotIn("unpaid:global", self.e.buckets)
        else:
            self.assertEqual(self.e.buckets["unpaid:global"].balance, unpaid_balance)
        self.assertNotIn("discovery:global", self.e.buckets)
        self.assertIn("discovery:global", self.e.discovery_buckets)
        self.assertLess(self.e.discovery_buckets["discovery:global"].balance, admission.DISCOVERY_GLOBAL)

    def test_discovery_exhaustion_does_not_consume_paid_route_admission(self):
        handler = object.__new__(server.Handler);handler.headers={}
        with patch.object(admission, "engine", return_value=self.e), patch.object(admission, "configured", return_value=True), patch.object(server, "client_ip", return_value="peer"):
            self.assertTrue(all(handler._preview_allowed() for _ in range(admission.DISCOVERY_ANONYMOUS)))
            self.assertFalse(handler._preview_allowed())
            self.assertFalse(handler._validate_allowed())
            self.assertTrue(all(handler._route_allowed() for _ in range(3)))
            self.assertIsNotNone(self.e.reserve({}, "peer"))
            self.assertIsNotNone(self.e.reserve({}, "peer"))

    def test_unpaid_exhaustion_does_not_block_discovery(self):
        handler = object.__new__(server.Handler);handler.headers={}
        self.assertTrue(all(self.e.reserve({}, "peer") for _ in range(2)))
        self.assertIsNone(self.e.reserve({}, "peer"))
        with patch.object(admission, "engine", return_value=self.e), patch.object(admission, "configured", return_value=True), patch.object(server, "client_ip", return_value="peer"):
            self.assertTrue(handler._preview_allowed())
            self.assertTrue(handler._validate_allowed())

    def test_get_route_challenge_shares_discovery_not_paid_ingress(self):
        handler = object.__new__(server.Handler)
        handler.headers = {}
        unpaid_before = self.e.buckets.get("unpaid:global")
        unpaid_balance = unpaid_before.balance if unpaid_before else None
        with patch.object(admission, "engine", return_value=self.e), patch.object(admission, "configured", return_value=True), patch.object(server, "client_ip", return_value="peer"):
            self.assertTrue(all(handler._preview_allowed() for _ in range(admission.DISCOVERY_ANONYMOUS)))
            self.assertFalse(handler._preview_allowed())
            self.assertNotIn("ingress:global", self.e.buckets)
            self.assertTrue(handler._route_allowed())
        if unpaid_balance is None:
            self.assertNotIn("unpaid:global", self.e.buckets)
        else:
            self.assertEqual(self.e.buckets["unpaid:global"].balance, unpaid_balance)
        self.assertIn("ingress:global", self.e.buckets)
        self.assertNotIn("discovery:global", self.e.buckets)
        self.assertIn("discovery:global", self.e.discovery_buckets)
        self.assertLess(self.e.discovery_buckets["discovery:global"].balance, admission.DISCOVERY_GLOBAL)

    def test_discovery_probe_does_not_exhaust_paid_target_budget(self):
        url = "https://seller.example/x402"
        for _ in range(2):
            lease = self.e.probe(url, discovery=True)
            self.assertIsNotNone(lease)
            self.e.probe_complete(lease, False)
        self.assertIsNone(self.e.probe(url, discovery=True))
        paid = self.e.probe(url)
        self.assertIsNotNone(paid)
        self.e.probe_complete(paid, False)
        paid2 = self.e.probe(url)
        self.assertIsNotNone(paid2)

    def test_public_docs_omit_live_rail_enrichment(self):
        with patch("live402.algo_tx.algorand_accept_extra") as enrich, patch("live402.algod.suggested_params") as params:
            spec = discover.openapi_spec()
            known = discover.well_known()
            enrich.assert_not_called()
            params.assert_not_called()
        accepts = spec["paths"]["/route"]["post"]["responses"]["402"]["content"]["application/json"]["example"]["accepts"]
        self.assertEqual(len(accepts), 3)
        self.assertEqual(len(known.get("accepts") or []), 3)

    def test_symlink_policy_is_refused_without_reading_target(self):
        with tempfile.TemporaryDirectory() as d:
            real = Path(d)/"real";real.write_text(json.dumps(policy()));real.chmod(0o600)
            link = Path(d)/"link";link.symlink_to(real)
            with patch.dict(os.environ, {"LIVE402_ADMISSION_POLICY_FILE": str(link)}):
                self.assertFalse(admission.ready())


    def test_restart_does_not_reset_spent_capacity(self):
        e = admission.Engine(admission.Policy(policy()), lambda: self.now, cold_start=True)
        self.assertIsNone(e.reserve({}, "peer"))
        self.now += 30
        self.assertIsNotNone(e.reserve({}, "peer"))
        self.assertIsNone(e.reserve({}, "peer"))
        restarted = admission.Engine(admission.Policy(policy()), lambda: self.now, cold_start=True)
        self.assertIsNone(restarted.reserve({}, "peer"))
        self.now += 30
        self.assertIsNotNone(restarted.reserve({}, "peer"))
        self.assertIsNone(restarted.reserve({}, "peer"))

    def test_cold_capacity_is_not_preallocated_by_identity_rotation(self):
        e = admission.Engine(admission.Policy(policy()), lambda: self.now, cold_start=True)
        self.now += 3
        self.assertIsNone(e.reserve({}, "peer"))
        # The customer's larger trial can use the single accrued global unit.
        self.now += 3
        self.assertIsNotNone(e.reserve(self.headers, "customer"))
        self.assertIsNone(e.reserve(self.headers, "different-peer"))
        self.assertLessEqual(e.buckets["unpaid:global"].balance, 1)

    def test_readiness_reports_invalid_policy_without_details(self):
        from live402 import ready
        with patch.object(ready, "_storage_ok", return_value=True), patch.object(ready, "_catalog_ok", return_value=True), patch.object(ready, "_history_ok", return_value=True), patch.object(ready, "_pq_log_ok", return_value=True), patch.object(ready, "_replay_ok", return_value=True), patch.dict(os.environ, {"LIVE402_ADMISSION_POLICY_FILE": "/missing/private/policy"}):
            out=ready.readiness()
            self.assertFalse(out["ok"])
            self.assertFalse(out["checks"]["admission"])
            self.assertNotIn("/missing", json.dumps(out))

    def test_real_http_preflight_and_customer_capacity(self):
        import http.client
        class QuietHandler(server.Handler):
            def log_message(self, *args): pass
        httpd=server.BoundedThreadingHTTPServer(("127.0.0.1",0), QuietHandler)
        thread=threading.Thread(target=httpd.serve_forever,daemon=True);thread.start()
        def request(method, headers):
            c=http.client.HTTPConnection("127.0.0.1",httpd.server_port,timeout=5)
            try:
                c.request(method,"/route",body="{}" if method=="POST" else None,headers=headers)
                r=c.getresponse();result=(r.status,dict(r.getheaders()));r.read();return result
            finally: c.close()
        try:
            with patch.object(admission,"engine",return_value=self.e), patch.object(admission,"configured",return_value=True), patch.object(server,"handle_route",return_value=(402,{"test":"payment-required"},{})):
                code,headers=request("OPTIONS", {"Origin":"https://buyer.example", "Access-Control-Request-Method":"POST", "Access-Control-Request-Headers":"content-type,x-402signal-key"})
                self.assertIn(code,(200,204))
                self.assertIn("x-402signal-key",headers["Access-Control-Allow-Headers"].lower())
                for _ in range(20):
                    self.assertEqual(request("POST",{"Content-Type":"application/json",**self.headers})[0],402)
                for _ in range(3):
                    self.assertEqual(request("POST",{"Content-Type":"application/json","X-402Signal-Key":"bad"*20})[0],402)
                self.assertEqual(request("POST",{"Content-Type":"application/json","X-402Signal-Key":"other"*12})[0],429)
        finally:
            httpd.shutdown();httpd.server_close();thread.join(timeout=5)

    def test_http_unpaid_challenge_preview_validate_stay_in_discovery(self):
        import http.client
        class QuietHandler(server.Handler):
            def log_message(self, *args): pass
        httpd = server.BoundedThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        def request(method, path, body=None, headers=None):
            c = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
            try:
                c.request(method, path, body=body, headers=headers or {})
                r = c.getresponse()
                raw = r.read()
                try:
                    payload = json.loads(raw.decode("utf-8"))
                except Exception:
                    payload = raw
                return r.status, payload
            finally:
                c.close()
        unpaid_before = self.e.buckets.get("unpaid:global")
        unpaid_balance = unpaid_before.balance if unpaid_before else None
        try:
            with patch.object(admission, "engine", return_value=self.e), patch.object(admission, "configured", return_value=True), patch.object(server, "client_ip", return_value="peer"):
                status, body = request("GET", "/route", headers={"Accept": "application/json"})
                self.assertEqual(status, 402)
                self.assertEqual(body.get("amount"), "$0.003")
                amounts = [str(a.get("amount")) for a in body.get("accepts") or []]
                self.assertEqual(amounts, ["3000", "3000", "3000"])
                status, body = request("GET", "/preview?need=weather")
                self.assertEqual(status, 200)
                self.assertTrue(body.get("not_probed"))
                status, _body = request("GET", "/validate?url=https://fixture.402signal.local/weather")
                self.assertEqual(status, 200)
                status, body = request(
                    "POST",
                    "/mcp",
                    body=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}),
                    headers={"Content-Type": "application/json"},
                )
                self.assertEqual(status, 200)
                self.assertEqual((body.get("result") or {}).get("serverInfo", {}).get("name"), "402Signal")
                status, body = request(
                    "POST",
                    "/mcp",
                    body=json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
                    headers={"Content-Type": "application/json"},
                )
                self.assertEqual(status, 202)
                status, body = request("GET", "/route", headers={"Accept": "application/json"})
                self.assertEqual(status, 429)
                self.assertEqual(body.get("error"), "rate limit")
                status, body = request(
                    "POST",
                    "/mcp",
                    body=json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
                    headers={"Content-Type": "application/json"},
                )
                self.assertEqual(status, 429)
                status, body = request("POST", "/route", body="{}", headers={"Content-Type": "application/json"})
                self.assertEqual(status, 402)
                self.assertEqual(body.get("amount"), "$0.003")
                status, html = request("GET", "/route", headers={"Accept": "text/html"})
                self.assertEqual(status, 200)
                self.assertIn("POST", str(html))
                status, body = request("GET", "/health")
                self.assertEqual(status, 200)
                self.assertEqual(body, {"ok": True})
                status, body = request("GET", "/ready")
                self.assertIn(status, (200, 503))
                self.assertIn("ok", body)
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)
        if unpaid_balance is None:
            self.assertNotIn("unpaid:global", self.e.buckets)
        else:
            self.assertEqual(self.e.buckets["unpaid:global"].balance, unpaid_balance)
        self.assertNotIn("discovery:global", self.e.buckets)
        self.assertLess(self.e.discovery_buckets["discovery:global"].balance, admission.DISCOVERY_GLOBAL)

    def test_denied_get_route_does_not_build_challenge(self):
        import http.client
        class QuietHandler(server.Handler):
            def log_message(self, *args): pass
        httpd = server.BoundedThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.object(admission, "engine", return_value=self.e), patch.object(admission, "configured", return_value=True), patch.object(server, "client_ip", return_value="peer"), patch.object(payment, "payment_required") as required:
                for _ in range(admission.DISCOVERY_ANONYMOUS):
                    self.e.discover({}, "peer").finish(False)
                c = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                c.request("GET", "/route", headers={"Accept": "application/json"})
                res = c.getresponse()
                self.assertEqual(res.status, 429)
                res.read()
                c.close()
                required.assert_not_called()
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)

    def test_denied_mcp_handshake_does_not_generate_tools(self):
        import http.client
        class QuietHandler(server.Handler):
            def log_message(self, *args): pass
        httpd = server.BoundedThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.object(admission, "engine", return_value=self.e), patch.object(admission, "configured", return_value=True), patch.object(server, "client_ip", return_value="peer"), patch.object(mcp, "handle_mcp") as handle:
                for _ in range(admission.DISCOVERY_ANONYMOUS):
                    self.e.discover({}, "peer").finish(False)
                c = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                c.request(
                    "POST",
                    "/mcp",
                    body=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
                    headers={"Content-Type": "application/json"},
                )
                res = c.getresponse()
                self.assertEqual(res.status, 429)
                res.read()
                c.close()
                handle.assert_not_called()
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)

    def test_client_ip_uses_socket_peer_not_forwarded_for(self):
        handler = object.__new__(server.Handler)
        handler.headers = {"X-Forwarded-For": "203.0.113.9", "Fly-Client-IP": "203.0.113.10"}
        handler.client_address = ("198.51.100.20", 443)
        with patch.dict(os.environ, {"FLY_APP_NAME": "", "FLY_ALLOC_ID": "", "FLY_MACHINE_ID": ""}, clear=False):
            os.environ.pop("FLY_APP_NAME", None)
            os.environ.pop("FLY_ALLOC_ID", None)
            os.environ.pop("FLY_MACHINE_ID", None)
            self.assertEqual(server.client_ip(handler), "198.51.100.20")

    def test_http_shared_ip_customer_survives_anonymous_saturation(self):
        import http.client
        class QuietHandler(server.Handler):
            def log_message(self, *args): pass
        httpd = server.BoundedThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        def request(method, path, body=None, headers=None):
            c = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
            try:
                c.request(method, path, body=body, headers=headers or {})
                r = c.getresponse()
                raw = r.read()
                try:
                    payload = json.loads(raw.decode("utf-8"))
                except Exception:
                    payload = raw
                return r.status, payload
            finally:
                c.close()
        unpaid_before = self.e.buckets.get("unpaid:global")
        unpaid_balance = unpaid_before.balance if unpaid_before else None
        try:
            with patch.object(admission, "engine", return_value=self.e), patch.object(admission, "configured", return_value=True), patch.dict(os.environ, {"FLY_APP_NAME": "", "FLY_ALLOC_ID": "", "FLY_MACHINE_ID": ""}, clear=False):
                os.environ.pop("FLY_APP_NAME", None)
                os.environ.pop("FLY_ALLOC_ID", None)
                os.environ.pop("FLY_MACHINE_ID", None)
                statuses = []
                for _ in range(admission.DISCOVERY_ANONYMOUS + 1):
                    status, body = request("GET", "/route", headers={"Accept": "application/json", "X-Forwarded-For": "203.0.113.80"})
                    statuses.append(status)
                    if status == 402:
                        self.assertEqual(body.get("amount"), "$0.003")
                self.assertEqual(statuses[:admission.DISCOVERY_ANONYMOUS], [402] * admission.DISCOVERY_ANONYMOUS)
                self.assertEqual(statuses[-1], 429)
                status, body = request(
                    "GET",
                    "/route",
                    headers={"Accept": "application/json", "X-Forwarded-For": "198.51.100.7", "Fly-Client-IP": "198.51.100.8"},
                )
                self.assertEqual(status, 429)
                status, body = request(
                    "POST",
                    "/mcp",
                    body=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}),
                    headers={"Content-Type": "application/json", "X-Forwarded-For": "198.51.100.9"},
                )
                self.assertEqual(status, 429)
                status, body = request(
                    "GET",
                    "/route",
                    headers={"Accept": "application/json", "X-402Signal-Key": KEY, "X-Forwarded-For": "203.0.113.80"},
                )
                self.assertEqual(status, 402)
                self.assertEqual(body.get("amount"), "$0.003")
                status, body = request(
                    "POST",
                    "/mcp",
                    body=json.dumps({"jsonrpc": "2.0", "id": 2, "method": "initialize", "params": {}}),
                    headers={"Content-Type": "application/json", "X-402Signal-Key": KEY},
                )
                self.assertEqual(status, 200)
                self.assertEqual((body.get("result") or {}).get("serverInfo", {}).get("name"), "402Signal")
                status, body = request("POST", "/route", body="{}", headers={"Content-Type": "application/json"})
                self.assertEqual(status, 402)
                self.assertEqual(body.get("amount"), "$0.003")
                status, body = request("GET", "/health")
                self.assertEqual(status, 200)
                self.assertEqual(body, {"ok": True})
                status, body = request("GET", "/ready")
                self.assertIn(status, (200, 503))
                self.assertIn("ok", body)
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)
        if unpaid_balance is None:
            self.assertNotIn("unpaid:global", self.e.buckets)
        else:
            self.assertEqual(self.e.buckets["unpaid:global"].balance, unpaid_balance)
        self.assertNotIn("discovery:global", self.e.buckets)
        self.assertLess(self.e.discovery_buckets["discovery:global"].balance, admission.DISCOVERY_GLOBAL)
        self.assertTrue(any(k.startswith("discovery:anonymous:") for k in self.e.discovery_buckets))
        self.assertTrue(any(k.startswith("discovery:customer:") for k in self.e.discovery_buckets))

    def test_fresh_anonymous_mcp_initialize_still_works(self):
        import http.client
        class QuietHandler(server.Handler):
            def log_message(self, *args): pass
        httpd = server.BoundedThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        def request(body, peer):
            c = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
            try:
                with patch.object(server, "client_ip", return_value=peer):
                    c.request("POST", "/mcp", body=json.dumps(body), headers={"Content-Type": "application/json"})
                    r = c.getresponse()
                    return r.status, json.loads(r.read().decode("utf-8"))
            finally:
                c.close()
        try:
            with patch.object(admission, "engine", return_value=self.e), patch.object(admission, "configured", return_value=True):
                for i in range(admission.DISCOVERY_ANONYMOUS):
                    self.assertIsNotNone(self.e.discover({}, "other-nat"))
                status, body = request({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}, "buyer-nat")
                self.assertEqual(status, 200)
                self.assertEqual((body.get("result") or {}).get("serverInfo", {}).get("name"), "402Signal")
                status, body = request({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, "buyer-nat")
                self.assertEqual(status, 200)
                names = [t.get("name") for t in ((body.get("result") or {}).get("tools") or [])]
                self.assertEqual(set(names), {"route", "preview", "validate"})
                status, body = request({"jsonrpc": "2.0", "id": 3, "method": "initialize", "params": {}}, "other-nat")
                self.assertEqual(status, 429)
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)

    def test_http_cold_mcp_lifecycle_leaves_free_tool_headroom(self):
        import http.client
        class QuietHandler(server.Handler):
            def log_message(self, *args): pass
        httpd = server.BoundedThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        def request(body):
            c = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
            try:
                c.request("POST", "/mcp", body=json.dumps(body), headers={"Content-Type": "application/json"})
                r = c.getresponse()
                raw = r.read()
                if not raw:
                    return r.status, None
                return r.status, json.loads(raw.decode("utf-8"))
            finally:
                c.close()
        unpaid_before = self.e.buckets.get("unpaid:global")
        unpaid_balance = unpaid_before.balance if unpaid_before else None
        ingress_before = self.e.buckets.get("ingress:global")
        try:
            with patch.object(admission, "engine", return_value=self.e), patch.object(admission, "configured", return_value=True), patch.object(server, "client_ip", return_value="anon-mcp"), patch.dict(os.environ, {"LIVE402_FIXTURE": "1"}):
                self.assertEqual(self.now, 10.0)
                status, body = request({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
                self.assertEqual(status, 200)
                self.assertEqual((body.get("result") or {}).get("serverInfo", {}).get("name"), "402Signal")
                status, body = request({"jsonrpc": "2.0", "method": "notifications/initialized"})
                self.assertEqual(status, 202)
                self.assertIsNone(body)
                status, body = request({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
                self.assertEqual(status, 200)
                names = [t.get("name") for t in ((body.get("result") or {}).get("tools") or [])]
                self.assertEqual(set(names), {"route", "preview", "validate"})
                status, body = request({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "preview", "arguments": {"need": "weather"}}})
                self.assertEqual(status, 200)
                preview = json.loads(body["result"]["content"][0]["text"])
                self.assertTrue(preview.get("not_probed"))
                status, body = request({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "validate", "arguments": {"url": "https://fixture.402signal.local/weather"}}})
                self.assertEqual(status, 200)
                checked = json.loads(body["result"]["content"][0]["text"])
                self.assertEqual(checked.get("url"), "https://fixture.402signal.local/weather")
                self.assertIn("live", checked)
                status, body = request({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "preview", "arguments": {"need": "weather"}}})
                self.assertEqual(status, 429)
                c = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                c.request("POST", "/route", body="{}", headers={"Content-Type": "application/json"})
                r = c.getresponse()
                paid = json.loads(r.read().decode("utf-8"))
                self.assertEqual(r.status, 402)
                self.assertEqual(paid.get("amount"), "$0.003")
                c.close()
                self.assertEqual(self.now, 10.0)
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)
        if unpaid_balance is None:
            self.assertNotIn("unpaid:global", self.e.buckets)
        else:
            self.assertEqual(self.e.buckets["unpaid:global"].balance, unpaid_balance)
        self.assertNotIn("discovery:global", self.e.buckets)
        self.assertIn("discovery:global", self.e.discovery_buckets)
        self.assertTrue(any(k.startswith("discovery:anonymous:") for k in self.e.discovery_buckets))
        if ingress_before is None:
            self.assertIn("ingress:global", self.e.buckets)
        self.assertLess(self.e.discovery_buckets["discovery:global"].balance, admission.DISCOVERY_GLOBAL)



class RouteAdmissionTests(unittest.TestCase):
    def setUp(self):
        from live402 import replay, history
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        file = root / "policy.json";file.write_text(json.dumps(policy()));file.chmod(0o600)
        self.env = patch.dict(os.environ, {"LIVE402_ADMISSION_POLICY_FILE": str(file), "LIVE402_REPLAY_DB": str(root / "replay.sqlite"), "LIVE402_HISTORY_DB": str(root / "history.sqlite"), "LIVE402_FIXTURE": "1", "CDP_ACCESS_TOKEN": "test-fixture-token"})
        self.env.start();replay.reset()
        self.peer = reqctx.peer_ip.set("unknown")
        self.e = admission.engine()
        self.e.started_at -= 60

    def tearDown(self):
        from live402 import replay, history
        replay.reset();history.reset();reqctx.peer_ip.reset(self.peer);self.env.stop();self.temp.cleanup()

    def test_denial_precedes_verify_probe_and_durable_admission(self):
        from live402 import replay, facilitator
        from live402.route import handle_route
        from test_pay_replay import _payload, _headers_for, _weather_body
        for _ in range(2): self.e.reserve({}, "unknown")
        with patch.object(facilitator, "verify") as verify, patch("live402.route.run_probe") as probe_call, patch.object(replay, "authorize") as admit:
            out = handle_route(_weather_body(), _headers_for(_payload("capacity-denied")), "https://402signal.com/route")
            self.assertEqual(out[0], 429)
            verify.assert_not_called();probe_call.assert_not_called();admit.assert_not_called()

    def test_confirmed_payment_restores_work_but_replay_does_not_mint_credit(self):
        from live402 import facilitator
        from live402.route import handle_route
        from test_pay_replay import _payload, _headers_for, _weather_body, _fake_facilitator
        headers = _headers_for(_payload("capacity-success"))
        with patch.object(facilitator, "post_json", side_effect=_fake_facilitator):
            out = handle_route(_weather_body(), headers, "https://402signal.com/route")
            self.assertTrue(out[1].get("billing", {}).get("settled"), out)
            self.assertGreaterEqual(self.e.buckets["unpaid:global"].balance, 19.99)
            self.e.reserve({}, "other")
            before = self.e.buckets["unpaid:global"].balance
            again = handle_route(_weather_body(), headers, "https://402signal.com/route")
            self.assertEqual(again[0], out[0])
            self.assertEqual(self.e.buckets["unpaid:global"].balance, before)

    def test_free_miss_keeps_work_debit_and_never_settles(self):
        from live402 import facilitator
        from live402.route import handle_route
        from test_pay_replay import _payload, _headers_for, _counting_facilitator
        verify_calls=[];settle_calls=[]
        with patch.object(facilitator, "post_json", side_effect=_counting_facilitator(verify_calls, settle_calls)):
            out = handle_route({"url": "https://fixture.402signal.local/weather", "max_price_usd": 0}, _headers_for(_payload("capacity-miss")), "https://402signal.com/route")
            self.assertFalse(out[1].get("billing", {}).get("settled"), out)
            self.assertEqual(len(verify_calls), 1);self.assertEqual(settle_calls, [])
            self.assertLess(self.e.buckets["unpaid:global"].balance, 19.1)
