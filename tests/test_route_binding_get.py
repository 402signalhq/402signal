"""Exact GET binding with bounded endpoint metadata; no live payment/network."""
import copy, json, unittest
from pathlib import Path
from live402 import route_binding as rb

FIXTURE=json.loads((Path(__file__).parent/"fixtures/route-binding-get.json").read_text())
URL=FIXTURE["response"]["url"]

class GetResourceBindingTests(unittest.TestCase):
    def verify(self, **changes):
        args=dict(vkey=FIXTURE["trusted_vkey"],status=402,envelope=FIXTURE["challenge"],url=URL,method="GET",now=FIXTURE["now"])
        args.update(changes)
        return rb.verify_route(FIXTURE["response"],FIXTURE["request"],**args)

    def test_signed_query_get_and_ten_tags_roundtrip(self):
        self.assertEqual(self.verify(),FIXTURE["challenge"]["accepts"][0])
        ctx=rb.request_context(URL,"GET")
        for advertised in (URL,URL.split("?")[0]):
            self.assertTrue(rb._resource_matches_context({"url":advertised},ctx))

    def test_request_changes_fail_even_when_endpoint_metadata_same(self):
        for changes in (
            {"url":URL.replace("query=x402%20protocol&max_results=5","max_results=5&query=x402%20protocol")},
            {"url":URL.replace("%20","+")},{"url":URL.replace("max_results=5","max_results=6")},
            {"url":URL.replace("search.example","other.example")},{"url":URL.replace("/search?","/other?")},
            {"method":"POST"},{"body":b"{}"},
        ):
            with self.subTest(changes=changes), self.assertRaises(rb.BindingError): self.verify(**changes)

    def test_endpoint_fallback_never_normalizes_or_accepts_post(self):
        ctx=rb.request_context(URL,"GET")
        for advertised in ("https://other.example/search","https://search.example/other",
            "https://search.example:443/search","https://SEARCH.example/search",
            "https://search.example/search?query=x402%20protocol", "https://search.example/search?"):
            self.assertFalse(rb._resource_matches_context({"url":advertised},ctx))
        self.assertFalse(rb._resource_matches_context({"url":URL.split("?")[0]},rb.request_context(URL,"POST",b"{}")))
        self.assertFalse(rb._resource_matches_context({"url":URL.split("?")[0]},rb.request_context(URL,"POST",b"")))
        self.assertFalse(rb._resource_matches_context({"url":"https://search.example/search"},rb.request_context("https://search.example/search?","GET")))
        for advertised in (None,{},"http://search.example/search","https://u:p@search.example/search","https://search.example/search#x"):
            with self.assertRaises(rb.BindingError): rb._resource_matches_context({"url":advertised},ctx)

    def test_metadata_mutations_remain_in_whole_quote_hash(self):
        for change in ({"serviceName":"other"},{"tags":list(reversed(FIXTURE["challenge"]["resource"]["tags"]))},
            {"tags":["other"]},{"url":URL},{"url":URL.split("?")[0]+"?query=other"}):
            env=copy.deepcopy(FIXTURE["challenge"]);env["resource"].update(change)
            with self.subTest(change=change), self.assertRaises(rb.BindingError): self.verify(envelope=env)

    def test_metadata_bounds_and_types_are_explicit(self):
        for change in ({"serviceName":None},{"serviceName":{}},{"serviceName":""},{"serviceName":"x"*33},
            {"serviceName":"x\n"},{"serviceName":"café"},{"tags":"x"},{"tags":[None]},
            {"tags":["x"]*17},{"tags":["x"*33]},{"tags":[""]},{"tags":["x\n"]},
            {"tags":[{}]},{"iconUrl":"https://example.com/icon"}):
            env=copy.deepcopy(FIXTURE["challenge"]);env["resource"].update(change)
            with self.subTest(change=change), self.assertRaises(rb.BindingError): rb.validate_envelope(env)
        env=copy.deepcopy(FIXTURE["challenge"])
        env["resource"].update(serviceName="x"*32,tags=["x"*32]*16)
        rb.validate_envelope(env)

    def test_producer_rejects_conflicting_resource_before_issuance(self):
        from test_success_only_billing import _winner
        for resource in ("https://other.example/search",URL+"&more=1",URL.split("?")[0]+"?query=x"):
            result=_winner();result["url"]=URL;result["envelope"]["resource"]={"url":resource}
            result["binding_observation"]={"request":rb.request_context(URL,"GET"),"observed_at":1000,"quote_sha256":rb.digest(result["envelope"])}
            with self.assertRaises(rb.BindingError): rb.build(result,FIXTURE["request"],now=1001)

    def test_no_extension_float_or_conflicting_channel_expansion(self):
        for change in ({"extensions":{"payment-identifier":{}}},{"extra":1},{"error":1.5}):
            env={**FIXTURE["challenge"],**change}
            with self.assertRaises(rb.BindingError): rb.validate_envelope(env)
        import base64
        head=base64.b64encode(json.dumps(FIXTURE["challenge"]).encode()).decode()
        bad=copy.deepcopy(FIXTURE["challenge"]);bad["resource"]["tags"].reverse()
        with self.assertRaises(rb.BindingError): rb.observed_challenge(402,{"payment-required":head},json.dumps(bad).encode())
