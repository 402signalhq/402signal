"""Search-only POST boundary and paid-route receipt tests; synthetic network only."""
import base64
import copy
import hashlib
import json
import os
import socket
import time
import unittest
import urllib.error
import urllib.request
from io import BytesIO
from unittest.mock import MagicMock, patch

from live402 import history, probe, probe_profile as profile, replay, route, route_binding as rb
from live402.pq import store
import test_route_binding as binding_tests
from test_success_only_billing import RESOURCE, _headers, _payload, _settled, _verified, _winner

RAW = '{ "query" : "private-search-canary", "mode":"one-shot" }'

def request(raw=RAW):
    return {"url": profile.URL, "require_route_binding": True, "require_invocable": True,
            "probe_request": {"profile": profile.PROFILE, "method": "POST", "body": raw}}

def challenge():
    env = copy.deepcopy(_winner()["envelope"])
    env["resource"] = {"url": profile.URL, "mimeType": "application/json"}
    return env

class ProfileValidationTests(unittest.TestCase):
    def test_exact_utf8_bytes_no_reencoding(self):
        for raw in (RAW, '{"mode":"one-shot","query":"caf\u00e9"}'):
            self.assertEqual(profile.parse(request(raw)).body, raw.encode())
        self.assertNotIn("private-search-canary", repr(profile.parse(request())))
        self.assertIsNone(profile.parse({"need": "search"}))

    def test_reject_unsupported_profiles_before_any_payment_work(self):
        bads = []
        for key, value in (("url", "https://localhost/api/search"), ("url", profile.URL + "?q=x"),
                ("url", "https://parallelmpp.dev:443/api/search"), ("url", "https://parallelmpp.dev./api/search"),
                ("url", "https://user@parallelmpp.dev/api/search"), ("url", profile.URL + "#x"),
                ("url", "https://127.0.0.1/api/search"), ("url", "https://parallelmpp.dev/api/extract"),
                ("need", "anything"), ("need", ""), ("require_route_binding", False)):
            value_body = request();value_body[key] = value;bads.append(value_body)
        for key, value in (("profile", "generic-json-v1"), ("method", "GET"), ("headers", {"Authorization": "secret"})):
            value_body = request();value_body["probe_request"][key] = value;bads.append(value_body)
        for body in bads:
            for headers in ({}, {"Payment-Signature": "arbitrary"}):
                with self.subTest(body=body), patch("live402.payment.extract_payment_payload") as extract, \
                        patch("live402.facilitator.verify") as verify, patch("live402.probe._one_request") as network:
                    code, result, _ = route.handle_route(body, headers, RESOURCE)
                    self.assertEqual(code, 400)
                    self.assertNotIn("secret", json.dumps(result))
                    extract.assert_not_called();verify.assert_not_called();network.assert_not_called()

    def test_http_envelope_rejects_duplicate_profile_and_destination(self):
        from live402.http_body import loads_json_object, BodyReadError
        for raw in (b'{"url":"https://other.example","url":"https://parallelmpp.dev/api/search","probe_request":{}}',
                    b'{"probe_request":{"method":"GET","method":"POST"}}',
                    b'{"probe_request":null,"probe_request":{}}'):
            with self.assertRaises(BodyReadError):
                loads_json_object(raw)
        self.assertEqual(loads_json_object(json.dumps(request()).encode()), request())

    def test_strict_small_search_schema(self):
        for raw in ('{}', '[]', '{"query":"a","query":"b","mode":"one-shot"}',
                '{"query":"a","mode":"one-shot","mode":"fast"}',
                '{"query":"a","mode":"one-shot","url":"https://internal"}',
                '{"query":"a","mode":"fast"}', '{"query":" ","mode":"one-shot"}',
                '{"query":null,"mode":"one-shot"}', '{"query":NaN,"mode":"one-shot"}',
                '{"query":"\\ud800","mode":"one-shot"}',
                json.dumps({"query": "a" * 301, "mode": "one-shot"}),
                ' ' * 4096 + RAW, RAW + '\ud800', None, b'{}', '{' * 3000):
            with self.subTest(raw=str(raw)[:80]), self.assertRaises(profile.ProfileError):
                profile.parse(request(raw))

    def test_ordinary_unpaid_discovery_contract_unchanged(self):
        with patch("live402.fixtures.local_free", return_value=False):
            self.assertEqual(route.handle_route({}, {}, RESOURCE)[0], 402)

class ProfileTransportTests(unittest.TestCase):
    def test_one_exact_post_no_get_or_headers_or_fanout(self):
        opener = MagicMock()
        opener.open.side_effect = urllib.error.HTTPError(profile.URL, 402, "Payment Required", {}, BytesIO(json.dumps(challenge()).encode()))
        with patch("live402.probe._pin_https_target", return_value=(profile.URL, [("pinned",)])), \
                patch("live402.probe._opener", return_value=opener), patch("live402.admission.reserve_probe", return_value=None) as budget, \
                patch("live402.probe._finalize_probe", side_effect=lambda result, **kw: result), \
                patch("live402.probe.route_need") as discovery:
            result = probe.probe_url(profile.URL, request_profile=profile.parse(request()), record=False)
        budget.assert_called_once_with(profile.URL);opener.open.assert_called_once();discovery.assert_not_called()
        sent = opener.open.call_args.args[0]
        self.assertEqual(sent.full_url, profile.URL);self.assertEqual(sent.get_method(), "POST")
        self.assertEqual(sent.data, RAW.encode());self.assertTrue(sent.no_probe_redirects)
        self.assertEqual(set(k.lower() for k in sent.headers), {"user-agent", "accept", "content-type"})
        self.assertEqual(result["binding_observation"]["request"], rb.request_context(profile.URL, "POST", RAW.encode()))
        self.assertTrue(result["invocable"]);self.assertEqual(result["target"]["method"], "POST")
        self.assertEqual(result["schema_source"], "probe_profile")
        self.assertNotIn("private-search-canary", json.dumps(result))

    def test_reject_redirect_before_destination_dns_or_send(self):
        req = urllib.request.Request(profile.URL, data=RAW.encode(), method="POST")
        req.no_probe_redirects = True
        for code in (301, 302, 303, 307, 308):
            with self.subTest(code=code), patch("live402.probe._pin_https_target") as dns, self.assertRaises(probe.ProbeBlocked):
                probe._SSRFRedirectHandler().redirect_request(req, None, code, "redirect", {}, "https://other.example/")
            dns.assert_not_called()

    def test_private_dns_and_admission_denial_never_send(self):
        with patch("live402.probe._checked_addrs", return_value=[]), patch("live402.probe._one_request") as wire, \
                patch("live402.admission.reserve_probe", return_value=None), \
                patch("live402.probe._finalize_probe", side_effect=lambda result, **kw: result):
            result = probe.probe_url(profile.URL, request_profile=profile.parse(request()), record=False)
        self.assertEqual(result["miss_reason"], "ssrf");wire.assert_not_called()
        with patch("live402.admission.reserve_probe", side_effect=RuntimeError), patch("live402.probe._pin_https_target") as dns:
            result = probe.probe_url(profile.URL, request_profile=profile.parse(request()), record=False)
        self.assertEqual(result["miss_reason"], "probe_capacity");dns.assert_not_called()

    def test_internal_profile_cannot_retarget(self):
        with patch("live402.admission.reserve_probe") as budget, self.assertRaises(profile.ProfileError):
            probe.probe_url("https://other.example/", request_profile=profile.parse(request()))
        budget.assert_not_called()

class ProfileReceiptTests(unittest.TestCase):
    setUp = binding_tests.BindingTests.setUp
    cleanup = binding_tests.BindingTests.cleanup

    def test_actual_post_full_paid_receipt_recovery_and_private_history(self):
        self.body = request()
        history_env = patch.dict(os.environ, {"LIVE402_HISTORY_DB": self.tmp.name + "/history.sqlite"})
        history_env.start();self.addCleanup(history_env.stop)
        history.reset();self.addCleanup(history.reset)
        opener = MagicMock()
        opener.open.side_effect = urllib.error.HTTPError(profile.URL, 402, "Payment Required", {}, BytesIO(json.dumps(challenge()).encode()))
        with patch("live402.route._lookup_claimed", return_value=None), \
                patch("live402.probe._pin_https_target", return_value=(profile.URL, [("pinned",)])), \
                patch("live402.probe._opener", return_value=opener), \
                patch("live402.facilitator.verify", return_value=_verified()) as verify, \
                patch("live402.facilitator.settle", return_value=_settled()) as settle, \
                patch("live402.probe.route_need") as discovery:
            out = route.handle_route(self.body, _headers(_payload()), RESOURCE)
            self.assertEqual(out[0], 200, out)
            self.assertTrue(out[1]["billing"]["settled"])
            verify.assert_called_once();settle.assert_called_once();opener.open.assert_called_once();discovery.assert_not_called()
            replay.reset_memory()
            again = route.handle_route(self.body, _headers(_payload()), RESOURCE)
            self.assertEqual(again, out)
            verify.assert_called_once();settle.assert_called_once();opener.open.assert_called_once()
        result = out[1]
        self.assertEqual(rb.verify_route(result, self.body, vkey=self.vkey, status=402, envelope=challenge(),
                url=profile.URL, method="POST", body=RAW.encode()), challenge()["accepts"][0])
        for changed in (RAW.encode() + b" ", RAW.replace("canary", "changed").encode()):
            with self.assertRaises(rb.BindingError):
                rb.verify_route(result, self.body, vkey=self.vkey, status=402, envelope=challenge(),
                        url=profile.URL, method="POST", body=changed)
        tr = result["pq_trust"]["transparency"]
        public = json.loads(store.leaf_at(tr["index"])["body"])
        self.assertEqual(set(public), {"type", "ts", "nonce", "commitment"})
        self.assertNotIn("private-search-canary", json.dumps(public))
        dump = "\n".join(history._connect().iterdump())
        self.assertNotIn("private-search-canary", dump)
        self.assertNotIn("probe_request", dump)
        self.assertIn("private-search-canary", tr["reveal"]["evidence"]["request_json"])

    def test_observed_bytes_must_match_requested_profile_before_settlement(self):
        from test_route_binding import bound_winner
        self.body = request()
        result = bound_winner(method="POST", request_body=b"{}")
        result["url"] = profile.URL
        result["binding_observation"]["request"]["url"] = profile.URL
        with self.assertRaises(rb.BindingError):
            rb.build(result, self.body)
