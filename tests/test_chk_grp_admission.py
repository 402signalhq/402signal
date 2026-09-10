"""chk_grp admission evidence. Cloud-safe: no spend, no Fly secrets, no prod enable.

Unpaid POST /route HTTP 402 is the router payment challenge. It is not
proof that buyer_limits were admitted. Body errors (unsupported /
invalid_need) appear only after successful verification, skip settle,
and refuse before the seller probe.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("LIVE402_FIXTURE", "1")
os.environ.pop("LOCAL_FREE", None)

from live402 import batch_binding as bb, replay, route
from live402.server import Handler
from test_success_only_billing import RESOURCE, _headers, _payload, _settled, _verified

FIXTURES = Path(__file__).parent / "fixtures"


def buyer(req):
    return {key: req[key] for key in req if key != "merchant_profile"}


def exact_case():
    item = json.loads((FIXTURES / "batch-observation-wire.json").read_text())[0]
    return buyer(item["request"]), item["challenge"]


def mpp_case():
    item = json.loads((FIXTURES / "base-native-mpp-v5.json").read_text())
    return buyer(item["request"]), item["challenge"]


def refuse(body):
    code, result = route._bad_request(body)
    return code, result


class Unpaid402IsNotAdmitTests(unittest.TestCase):
    """HTTP 402 Payment-required is the router challenge, not caps admit."""

    def test_unpaid_route_402_is_router_challenge_not_caps_admit(self):
        for name, (req, _challenge) in (("exact", exact_case()), ("mpp", mpp_case())):
            with self.subTest(codec=name), patch.dict(
                os.environ, {"BATCH_OBSERVATION_PROFILES": ""}
            ):
                code, body, extra = route.handle_route(req, {}, RESOURCE)
                self.assertEqual(code, 402, body)
                self.assertIn("accepts", body)
                self.assertEqual(body.get("amount"), "$0.003")
                self.assertNotEqual(body.get("miss_reason"), "invalid_need")
                self.assertNotEqual(
                    body.get("error"), "unsupported batch observation request"
                )
                self.assertIn("PAYMENT-REQUIRED", extra or {})

    def test_http_unpaid_chk_grp_402_is_not_admit_evidence(self):
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            req, _challenge = mpp_case()
            with patch.dict(os.environ, {"BATCH_OBSERVATION_PROFILES": ""}):
                conn = HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=5)
                conn.request(
                    "POST",
                    "/route",
                    body=json.dumps(req).encode(),
                    headers={"Content-Type": "application/json"},
                )
                response = conn.getresponse()
                raw = response.read()
                conn.close()
            self.assertEqual(response.status, 402)
            body = json.loads(raw.decode())
            self.assertIn("accepts", body)
            self.assertNotEqual(body.get("miss_reason"), "invalid_need")
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join()


class EmptyAllowlistRefuseTests(unittest.TestCase):
    """Empty BATCH_OBSERVATION_PROFILES refuses valid mpp/exact caps before probe."""

    def test_empty_allowlist_parse_refuses_valid_mpp_and_exact_caps(self):
        with patch.dict(os.environ, {"BATCH_OBSERVATION_PROFILES": ""}):
            os.environ.pop("BATCH_OBSERVATION_PROFILES", None)
            for name, (req, _challenge) in (("exact", exact_case()), ("mpp", mpp_case())):
                with self.subTest(codec=name):
                    with self.assertRaises(Exception):
                        bb.parse_request(req, enabled=True)
                    code, result = refuse(req)
                    self.assertEqual(code, 400)
                    self.assertEqual(result["miss_reason"], "invalid_need")
                    self.assertEqual(
                        result["error"], "unsupported batch observation request"
                    )

    def test_empty_allowlist_run_probe_refuses_before_seller_network(self):
        with patch.dict(os.environ, {"BATCH_OBSERVATION_PROFILES": ""}):
            for name, (req, _challenge) in (("exact", exact_case()), ("mpp", mpp_case())):
                with self.subTest(codec=name), patch(
                    "live402.probe._one_request"
                ) as network, patch("live402.batch_probe.run") as batch_run:
                    code, result = route.run_probe(req)
                    self.assertEqual(code, 400, result)
                    self.assertEqual(result["miss_reason"], "invalid_need")
                    self.assertEqual(
                        result["error"], "unsupported batch observation request"
                    )
                    network.assert_not_called()
                    batch_run.assert_not_called()

    def test_empty_allowlist_verified_route_refuses_before_probe_without_settle(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        env = patch.dict(
            os.environ,
            {
                "LIVE402_FIXTURE": "1",
                "LOCAL_FREE": "0",
                "LIVE402_REPLAY_DB": tmp.name + "/replay.sqlite",
                "BATCH_OBSERVATION_PROFILES": "",
            },
        )
        env.start()
        self.addCleanup(env.stop)
        replay.reset()
        self.addCleanup(replay.reset)
        for name, (req, _challenge) in (("exact", exact_case()), ("mpp", mpp_case())):
            replay.reset()
            with self.subTest(codec=name), patch(
                "live402.facilitator.verify", return_value=_verified()
            ) as verify, patch(
                "live402.facilitator.settle", return_value=_settled()
            ) as settle, patch(
                "live402.route.run_probe"
            ) as probe_call, patch.object(
                replay, "authorize"
            ) as admit:
                out = route.handle_route(
                    req, _headers(_payload("chk-grp-empty-" + name)), RESOURCE
                )
                self.assertEqual(out[0], 400, out)
                self.assertEqual(out[1]["miss_reason"], "invalid_need")
                self.assertEqual(
                    out[1]["error"], "unsupported batch observation request"
                )
                verify.assert_called_once()
                settle.assert_not_called()
                probe_call.assert_not_called()
                admit.assert_not_called()


class AllowlistAdmitTests(unittest.TestCase):
    """In-process allowlist admits matching caps and fails closed otherwise."""

    def test_mpp_only_admits_mpp_caps_and_refuses_exact(self):
        mpp_req, mpp_challenge = mpp_case()
        exact_req, exact_challenge = exact_case()
        with patch.dict(os.environ, {"BATCH_OBSERVATION_PROFILES": "mpp"}):
            self.assertIsNone(route._bad_request(mpp_req))
            bb.parse_request(mpp_req, enabled=True)
            self.assertEqual(bb.resolve_profile(mpp_req, mpp_challenge), "base-mpp-charge-v1")
            with self.assertRaises(Exception):
                bb.parse_request(exact_req, enabled=True)
            code, result = refuse(exact_req)
            self.assertEqual(code, 400)
            self.assertEqual(result["miss_reason"], "invalid_need")
            with self.assertRaises(Exception):
                bb.resolve_profile(mpp_req, exact_challenge)
            with self.assertRaises(Exception):
                bb.resolve_profile(exact_req, mpp_challenge)

    def test_exact_only_admits_exact_caps_and_refuses_mpp(self):
        mpp_req, mpp_challenge = mpp_case()
        exact_req, exact_challenge = exact_case()
        with patch.dict(os.environ, {"BATCH_OBSERVATION_PROFILES": "exact"}):
            self.assertIsNone(route._bad_request(exact_req))
            bb.parse_request(exact_req, enabled=True)
            self.assertEqual(
                bb.resolve_profile(exact_req, exact_challenge), "base-x402-batch-v1"
            )
            with self.assertRaises(Exception):
                bb.parse_request(mpp_req, enabled=True)
            code, result = refuse(mpp_req)
            self.assertEqual(code, 400)
            self.assertEqual(result["miss_reason"], "invalid_need")
            with self.assertRaises(Exception):
                bb.resolve_profile(exact_req, mpp_challenge)
            with self.assertRaises(Exception):
                bb.resolve_profile(mpp_req, exact_challenge)

    def test_matching_allowlist_reaches_probe_after_verify_not_via_unpaid_402(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        env = patch.dict(
            os.environ,
            {
                "LIVE402_FIXTURE": "1",
                "LOCAL_FREE": "0",
                "LIVE402_REPLAY_DB": tmp.name + "/replay.sqlite",
                "BATCH_OBSERVATION_PROFILES": "mpp",
            },
        )
        env.start()
        self.addCleanup(env.stop)
        replay.reset()
        self.addCleanup(replay.reset)
        req, _challenge = mpp_case()
        miss = {
            "url": req["url"],
            "job": "chk_grp",
            "codec": "mpp",
            "live": False,
            "payable": False,
            "invocable": False,
            "selected_payment": None,
            "miss_reason": "no_402_envelope",
        }
        with patch(
            "live402.facilitator.verify", return_value=_verified()
        ) as verify, patch("live402.facilitator.settle") as settle, patch(
            "live402.route.run_probe", return_value=(200, miss)
        ) as probe_call:
            out = route.handle_route(
                req, _headers(_payload("chk-grp-mpp-admit")), RESOURCE
            )
            self.assertNotEqual(out[0], 402, "admit evidence is post-verify, not unpaid 402")
            self.assertNotEqual(out[1].get("miss_reason"), "invalid_need")
            verify.assert_called_once()
            probe_call.assert_called_once()
            settle.assert_not_called()
            self.assertFalse((out[1].get("billing") or {}).get("settled"))

    def test_wrong_allowlist_verified_route_refuses_before_probe(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        env = patch.dict(
            os.environ,
            {
                "LIVE402_FIXTURE": "1",
                "LOCAL_FREE": "0",
                "LIVE402_REPLAY_DB": tmp.name + "/replay.sqlite",
                "BATCH_OBSERVATION_PROFILES": "exact",
            },
        )
        env.start()
        self.addCleanup(env.stop)
        replay.reset()
        self.addCleanup(replay.reset)
        req, _challenge = mpp_case()
        with patch(
            "live402.facilitator.verify", return_value=_verified()
        ), patch("live402.facilitator.settle") as settle, patch(
            "live402.route.run_probe"
        ) as probe_call:
            out = route.handle_route(
                req, _headers(_payload("chk-grp-wrong-codec")), RESOURCE
            )
            self.assertEqual(out[0], 400, out)
            self.assertEqual(out[1]["miss_reason"], "invalid_need")
            settle.assert_not_called()
            probe_call.assert_not_called()


if __name__ == "__main__":
    unittest.main()
