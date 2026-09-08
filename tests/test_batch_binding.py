"""Synthetic full paid-routing batch observation; no network or merchant payments."""

import base64, copy, json, os, re, tempfile, time, unittest, urllib.error
from pathlib import Path
from io import BytesIO
from email.message import Message
from unittest.mock import patch, MagicMock
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from test_success_only_billing import RESOURCE, _headers, _payload, _verified, _settled
from live402 import (
    batch_binding as bb,
    route_binding as rb,
    batch_probe,
    probe,
    replay,
    route,
    http_body,
)
from live402.pq import receipt, store, events, route_v5

VECTORS = json.loads(
    (Path(__file__).parent / "fixtures/batch-observation-wire.json").read_text()
)


GENERIC = json.loads(
    (Path(__file__).parent / "fixtures/algorand-generic-v5.json").read_text()
)
VECTORS.append({"request": GENERIC["request"], "challenge": GENERIC["challenge"]})
NATIVE_BASE = json.loads((Path(__file__).parent / "fixtures/base-native-mpp-v5.json").read_text())
VECTORS.append({"request": NATIVE_BASE["request"], "challenge": NATIVE_BASE["challenge"]})


def vector(index, now=None):
    v = copy.deepcopy(VECTORS[index])
    now = int(time.time()) if now is None else now
    c = v["challenge"]
    if c["wwwAuthenticate"]:
        expiry = events.jcs.utc_seconds_z(now + 40)
        c["wwwAuthenticate"] = re.sub(
            r'expires="[^"]+"', 'expires="' + expiry + '"', c["wwwAuthenticate"]
        )
    v["observation"] = {
        "request": rb.request_context(v["request"]["url"], "GET"),
        "observed_at": now,
        "challenge": c,
    }
    v["now"] = now
    return v


class BatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        env = patch.dict(
            os.environ,
            {
                "LIVE402_FIXTURE": "1",
                "LOCAL_FREE": "0",
                "LIVE402_PQ_LOG": "1",
                "LIVE402_PQ_LOG_DB": self.tmp.name + "/pq.sqlite",
                "LIVE402_REPLAY_DB": self.tmp.name + "/replay.sqlite",
                "BATCH_OBSERVATION_PROFILES": ",".join(bb.PROFILES),
            },
        )
        env.start()
        self.addCleanup(env.stop)
        store.reset()
        replay.reset()
        self.vkey = receipt.configure_signer(Ed25519PrivateKey.generate())
        self.addCleanup(self.cleanup)

    def cleanup(self):
        receipt.configure_signer(None)
        store.reset()
        replay.reset()

    def result(self, v):
        binding = bb.build(v["request"], v["observation"])
        return {
            "url": v["request"]["url"],
            "merchant_profile": v["request"]["merchant_profile"],
            "live": True,
            "payable": True,
            "invocable": False,
            "status": 402,
            "selected_payment": None,
            "batch_terms": binding["terms"],
            "_batch_observation": v["observation"],
        }

    def issue(self, v):
        result = self.result(v)
        result["batch_binding"] = bb.build(v["request"], v["observation"])
        result.pop("_batch_observation")
        return receipt.attach_to_route(result, v["request"])

    def test_all_three_signed_roundtrips_commitment_only_leaf(self):
        for i in range(len(VECTORS)):
            v = vector(i)
            result = self.issue(v)
            tr = result["pq_trust"]["transparency"]
            self.assertEqual(tr["leaf_type"], route_v5.TYPE)
            receipt.verify_route_receipt(tr["receipt"], tr["reveal"], self.vkey)
            bb.verify_route(
                result,
                v["request"],
                vkey=self.vkey,
                challenge=v["challenge"],
                now=v["now"],
            )
            public = json.loads(store.leaf_at(tr["index"])["body"])
            self.assertEqual(set(public), {"type", "ts", "nonce", "commitment"})
            self.assertNotIn(v["request"]["url"], json.dumps(public))

    def test_profile_limits_and_raw_terms_tamper_rejected(self):
        for i in range(len(VECTORS)):
            v = vector(i)
            b = bb.build(v["request"], v["observation"])
            for key, value in [
                ("expires_at", b["expires_at"] + 1),
                ("observed_at", b["observed_at"] + 1),
                ("terms", {}),
                ("buyer_limits", {}),
                ("challenge_sha256", "00" * 32),
                ("request", {**b["request"], "method": "POST"}),
            ]:
                bad = copy.deepcopy(b)
                bad[key] = value
                with self.subTest(profile=i, key=key), self.assertRaises(ValueError):
                    bb.validate(bad, v["request"], now=v["now"])
            for key in v["request"]["buyer_limits"]:
                bad = copy.deepcopy(v["request"])
                bad["buyer_limits"][key] = "untrusted"
                with self.subTest(profile=i, limit=key), self.assertRaises(ValueError):
                    bb.build(bad, v["observation"])
            for url in [
                v["request"]["url"] + "?q=other",
                v["request"]["url"].replace("https://", "https://other."),
                v["request"]["url"] + "/other",
            ]:
                with self.assertRaises(ValueError):
                    bb.validate(b, {**v["request"], "url": url}, now=v["now"])

    def test_native_cap_is_not_call_price_and_expires_earlier(self):
        v = vector(1, 1800000000)
        b = bb.build(v["request"], v["observation"])
        self.assertEqual(b["expires_at"], v["now"] + 40)
        self.assertIsNone(b["terms"]["per_call_amount_atomic"])
        for now in [v["now"] - 1, v["now"] + 40]:
            with self.assertRaises(ValueError):
                bb.validate(b, v["request"], now=now)
        c = copy.deepcopy(v["challenge"])
        c["wwwAuthenticate"] += ', intent="charge"'
        with self.assertRaises(ValueError):
            bb.wire(c, b["request"], b["profile"])

    def test_wire_duplicate_differential_and_raw_bounds(self):
        v = vector(0)
        c = v["challenge"]
        ctx = v["observation"]["request"]
        for change in [
            {"bodyText": '{"x402Version":2,"x402Version":2}'},
            {"bodyText": c["bodyText"].replace("1000", "1001")},
            {"bodyText": "x" * 16385},
            {"paymentRequired": "A" * 16385},
            {"wwwAuthenticate": "Payment secret"},
            {"status": 200},
        ]:
            with self.assertRaises(ValueError):
                bb.wire({**c, **change}, ctx, v["request"]["merchant_profile"])
        for raw in [
            b'{"merchant_profile":null,"merchant_profile":"x"}',
            b'{"merchant_profile":null,"buyer_limits":{"a":1,"a":2}}',
            b'{"buyer_limits":{},"buyer_limits":null}',
        ]:
            with self.assertRaises(http_body.BodyReadError):
                http_body.loads_json_object(raw)

    def test_feature_default_off_and_incompatible_discovery_or_post(self):
        v = vector(0)
        with patch.dict(os.environ, {"BATCH_OBSERVATION_PROFILES": ""}):
            self.assertEqual(route._bad_request(v["request"])[0], 400)
        for change in [
            {"need": "search"},
            {"max_price_usd": 1},
            {"probe_request": {}},
            {"require_route_binding": False},
        ]:
            self.assertEqual(route._bad_request({**v["request"], **change})[0], 400)

    def test_full_verify_raw_probe_settle_pq_replay_all_three(self):
        for i in range(len(VECTORS)):
            replay.reset()
            v = vector(i)
            calls = []

            def network(url, method, **kw):
                self.assertEqual(url, v["request"]["url"])
                self.assertEqual(method, "GET")
                self.assertIs(kw["allow_redirects"], False)
                self.assertIs(kw["capture_batch"], True)
                calls.append("probe")
                return {"status": 402, "_batch_observation": v["observation"]}

            with patch(
                "live402.facilitator.verify", return_value=_verified()
            ) as verify, patch(
                "live402.facilitator.settle", return_value=_settled()
            ) as settle, patch(
                "live402.probe._pin_https_target",
                return_value=(v["request"]["url"], [("synthetic",)]),
            ), patch(
                "live402.probe._one_request", side_effect=network
            ), patch(
                "live402.admission.reserve_probe", return_value=None
            ), patch(
                "live402.history.mark_batch_settled"
            ), patch(
                "live402.history.record_probe"
            ) as history:
                out = route.handle_route(v["request"], _headers(_payload()), RESOURCE)
                self.assertEqual(out[0], 200, out)
                self.assertTrue(out[1]["billing"]["settled"])
                self.assertEqual(
                    (verify.call_count, settle.call_count, len(calls)), (1, 1, 1)
                )
                self.assertNotIn("_batch_observation", out[1])
                history.assert_not_called()
                replay.reset_memory()
                again = route.handle_route(v["request"], _headers(_payload()), RESOURCE)
                self.assertEqual(again, out)
                self.assertEqual(
                    (verify.call_count, settle.call_count, len(calls)), (1, 1, 1)
                )

    def test_unbillable_stale_or_substituted_raw_never_settles(self):
        for kind in ["stale", "recipient", "raw_missing", "terms"]:
            replay.reset()
            v = vector(0)
            result = self.result(v)
            if kind == "stale":
                result["_batch_observation"]["observed_at"] -= 61
            if kind == "recipient":
                v["request"]["buyer_limits"]["recipient"] = "0x" + "11" * 20
            if kind == "raw_missing":
                result.pop("_batch_observation")
            if kind == "terms":
                result["batch_terms"] = {}
            with patch("live402.route.run_probe", return_value=(200, result)), patch(
                "live402.facilitator.verify", return_value=_verified()
            ), patch("live402.facilitator.settle") as settle, patch(
                "live402.pq.receipt.attach_to_route"
            ) as attach:
                out = route.handle_route(v["request"], _headers(_payload()), RESOURCE)
                self.assertFalse(out[1]["billing"]["settled"])
                settle.assert_not_called()
                attach.assert_not_called()
                self.assertNotIn("_batch_observation", out[1])

    def test_invalid_limits_reject_before_network_and_unpaid_miss_no_leaf(self):
        v = vector(0)
        for limits in [
            {},
            {**v["request"]["buyer_limits"], "max_capital_atomic": "-1"},
            {**v["request"]["buyer_limits"], "unknown": "x"},
        ]:
            with patch("live402.probe._one_request") as network:
                self.assertEqual(
                    route.run_probe({**v["request"], "buyer_limits": limits})[0], 400
                )
                network.assert_not_called()
        with patch("live402.facilitator.verify", return_value=_verified()), patch(
            "live402.facilitator.settle"
        ) as settle, patch(
            "live402.probe._pin_https_target",
            return_value=(v["request"]["url"], [("synthetic",)]),
        ), patch(
            "live402.probe._one_request",
            return_value={"status": 200, "miss_reason": "reachable_200"},
        ), patch(
            "live402.admission.reserve_probe", return_value=None
        ), patch(
            "live402.pq.receipt.attach_to_route"
        ) as attach:
            out = route.handle_route(v["request"], _headers(_payload()), RESOURCE)
            self.assertEqual(out[0], 200)
            self.assertFalse(out[1]["billing"]["settled"])
            settle.assert_not_called()
            attach.assert_not_called()

    def test_batch_slots_deny_before_dns_and_release_after_network_failure(self):
        v = vector(0)
        lease = MagicMock()
        with patch("live402.admission.reserve_probe", return_value=lease), patch(
            "live402.probe.acquire_probe_slot", return_value=False
        ), patch("live402.probe.release_probe_slot") as release, patch(
            "live402.probe._pin_https_target"
        ) as dns:
            code, result = batch_probe.run(v["request"], time.monotonic() + 1)
            self.assertEqual(code, 503)
            self.assertEqual(result["miss_reason"], "probe_budget_exhausted")
            dns.assert_not_called()
            release.assert_not_called()
            lease.engine.probe_complete.assert_called_once_with(lease, False)
        lease.reset_mock()
        with patch("live402.admission.reserve_probe", return_value=lease), patch(
            "live402.probe.acquire_probe_slot", return_value=True
        ), patch("live402.probe.release_probe_slot") as release, patch(
            "live402.probe._pin_https_target",
            return_value=(v["request"]["url"], [("synthetic",)]),
        ), patch(
            "live402.probe._one_request",
            side_effect=RuntimeError("synthetic transport failure"),
        ):
            with self.assertRaises(RuntimeError):
                batch_probe.run(v["request"], time.monotonic() + 1)
            release.assert_called_once_with("merchant.example")
            lease.engine.probe_complete.assert_called_once_with(lease, False)

    def test_profile_metadata_unicode_limits_use_utf8_bytes(self):
        from live402.batch_profiles import base, algorand_generic

        for index, validate in [(0, base.validate), (3, algorand_generic.validate)]:
            v = vector(index)
            envelope = json.loads(v["challenge"]["bodyText"])
            envelope["resource"]["description"] = "é" * 2048
            validate(
                envelope, v["observation"]["request"], v["request"]["buyer_limits"]
            )
            envelope["resource"]["description"] += "é"
            with self.assertRaises(ValueError):
                validate(
                    envelope, v["observation"]["request"], v["request"]["buyer_limits"]
                )

    def test_generic_algorand_dynamic_price_job_pins_and_overflow(self):
        from live402.batch_profiles import algorand_generic

        v = vector(3)
        envelope = json.loads(v["challenge"]["bodyText"])
        context = v["observation"]["request"]
        limits = v["request"]["buyer_limits"]
        terms = algorand_generic.validate(envelope, context, limits)
        self.assertEqual(terms["itemAmount"], "1500")
        self.assertEqual(terms["totalAmount"], "3000")
        for changed in [
            {**limits, "max_item_amount_atomic": "1499"},
            {**limits, "max_total_amount_atomic": "2999"},
            {**limits, "max_sponsor_fee_micro_algo": "14999"},
            {**limits, "job_hashes": list(reversed(limits["job_hashes"]))},
            {key: value for key, value in limits.items() if key != "job_hashes"},
        ]:
            with self.assertRaises(ValueError):
                algorand_generic.validate(envelope, context, changed)
        for field, value in [
            ("itemAmount", "1000"),
            ("totalAmount", "1500"),
            ("paymentIndices", [2, 1]),
            ("sponsorIndex", 1),
            ("requestHash", "00" * 32),
        ]:
            bad = copy.deepcopy(envelope)
            bad["extensions"]["402signal-atomic-batch"][field] = value
            with self.assertRaises(ValueError):
                algorand_generic.validate(bad, context, limits)
        bad = copy.deepcopy(envelope)
        bad["accepts"][0]["amount"] = str(2**64 - 1)
        with self.assertRaises(ValueError):
            algorand_generic.validate(bad, context, limits)

    def test_actual_url_profile_preserves_port_query_and_encoding(self):
        vectors = json.loads(
            (Path(__file__).parent / "fixtures/batch-url-parity-v5.json").read_text()
        )
        for v in vectors:
            self.assertEqual(
                bb.verify_route(
                    v["response"],
                    v["request"],
                    vkey=v["trusted_vkey"],
                    challenge=v["challenge"],
                    now=v["now"],
                )["request"]["url"],
                v["request"]["url"],
            )
        for url in [
            "https://merchant.example:444/batch",
            "https://merchant.example:65536/batch",
            "https://merchant.example:bad/batch",
            "https://user@merchant.example/batch",
            "https://merchant.example/batch#fragment",
        ]:
            with self.assertRaises(ValueError):
                bb.parse_request({**vector(0)["request"], "url": url})

    def test_raw_http_capture_duplicate_redirect_and_limit_rejected(self):
        v = vector(0)
        url = v["request"]["url"]
        c = v["challenge"]
        for variant in ["good", "duplicate", "redirect", "large", "invalid_utf8"]:
            headers = Message()
            headers["Payment-Required"] = c["paymentRequired"]
            if variant == "duplicate":
                headers["Payment-Required"] = c["paymentRequired"]
            body = (
                c["bodyText"].encode()
                if variant not in ["large", "invalid_utf8"]
                else b"x" * 16385 if variant == "large" else b"\xff"
            )
            err = urllib.error.HTTPError(
                url + "/redirect" if variant == "redirect" else url,
                402,
                "Payment Required",
                headers,
                BytesIO(body),
            )
            opener = MagicMock()
            opener.open.side_effect = err
            with patch("live402.probe._opener", return_value=opener):
                snap = probe._one_request(
                    url,
                    "GET",
                    pinned_addrs=[("synthetic",)],
                    allow_redirects=False,
                    capture_batch=True,
                )
            self.assertEqual(
                snap.get("_batch_observation") is not None, variant == "good", variant
            )


if __name__ == "__main__":
    unittest.main()
