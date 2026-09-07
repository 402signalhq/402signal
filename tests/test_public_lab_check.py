"""Public readiness diagnostics never gain payment or arbitrary-target authority."""
import json
import unittest
from unittest.mock import patch

from live402 import payment, route_binding as binding
from scripts import public_lab_check as check


class PublicLabCheckTests(unittest.TestCase):
    def snapshot(self):
        url = check.ORIGIN + "/base/payload/sha256"
        env = {"x402Version":2,"resource":{"url":url},"accepts":[{
            "scheme":"exact","network":payment.BASE_CAIP2,"asset":payment.USDC_BASE,
            "payTo":payment.DEFAULT_PAYTO,"amount":"1000","maxTimeoutSeconds":60}]}
        return {"status":402,"live":True,"envelope":env,"binding_observation":{
            "request":binding.request_context(url,"GET"),"observed_at":1,
            "quote_sha256":binding.digest(env)}}

    def run_snapshot(self, snapshot):
        with patch.object(check.probe,"_pin_https_target",return_value=(
                check.ORIGIN+"/base/payload/sha256",["pinned-fixture"])) as pin, \
             patch.object(check.probe,"_one_request",return_value=snapshot) as request:
            result = check.check("base")
        self.assertEqual(pin.call_count,1)
        self.assertEqual(request.call_count,1)
        self.assertEqual(request.call_args.args[1],"GET")
        self.assertNotIn("data",request.call_args.kwargs)
        self.assertEqual(request.call_args.kwargs["pinned_addrs"],["pinned-fixture"])
        return result

    def test_valid_challenge_is_a_read_only_compatibility_result(self):
        result = self.run_snapshot(self.snapshot())
        self.assertTrue(result["challenge_compatible"])
        self.assertEqual(set(result),{"rail","http_status","challenge_compatible","reason"})
        self.assertNotIn(payment.DEFAULT_PAYTO,json.dumps(result))

    def test_private_dns_target_does_not_make_request(self):
        with patch.object(check.probe,"_pin_https_target",return_value=None), \
             patch.object(check.probe,"_one_request") as request:
            self.assertEqual(check.check("base")["reason"],"ssrf")
        request.assert_not_called()

    def test_unsupported_envelope_stays_blocked(self):
        snap = self.snapshot()
        snap["envelope"]["unexpected"] = "not a reviewed extension"
        snap["binding_observation"]["quote_sha256"] = binding.digest(snap["envelope"])
        self.assertEqual(self.run_snapshot(snap)["reason"],"unsupported_challenge")

    def test_untrusted_error_content_is_never_reported(self):
        result = self.run_snapshot({"status":503,"binding_error_reason":"PRIVATE RESPONSE MATERIAL"})
        self.assertEqual(result["reason"],"unavailable")
        self.assertNotIn("PRIVATE",json.dumps(result))

    def test_missing_or_changed_observation_cannot_pass(self):
        for mutate in ("missing","changed"):
            snap = self.snapshot()
            if mutate == "missing":
                snap.pop("binding_observation")
            else:
                snap["binding_observation"]["quote_sha256"] = "0"*64
            self.assertFalse(self.run_snapshot(snap)["challenge_compatible"])

    def test_arbitrary_target_is_not_accepted(self):
        with self.assertRaises(ValueError):
            check.check("https://example.com")
