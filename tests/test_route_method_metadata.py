"""POST /route is the one paid operation; GET /route is a discovery alias; every
owner-controlled discovery surface names the same rails and price.

Origin scanners read the OpenAPI contract and had listed GET /route as a second
$0.003 service beside POST /route, so the priced declaration now lives on POST
only and GET carries an explicit discovery role. Nothing here is a paid request:
the local fixture server answers unpaid challenges."""

from __future__ import annotations

import json
import os
import re
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer

os.environ.setdefault("LIVE402_FIXTURE", "1")
os.environ.pop("LOCAL_FREE", None)

from live402.server import Handler

RAILS = {
    "eip155:8453",
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
}
MCP_CHECK = {"jsonrpc": "2.0", "id": "probe", "method": "tools/call", "params": {"name": "check", "arguments": {"need": "web search"}}}


class RouteMethodMetadataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def _request(self, method, path, body=None, headers=None):
        conn = HTTPConnection("127.0.0.1", self.port, timeout=10)
        data = json.dumps(body).encode() if body is not None else None
        head = {"Accept": "application/json"}
        if data is not None:
            head["Content-Type"] = "application/json"
        head.update(headers or {})
        conn.request(method, path, body=data, headers=head)
        res = conn.getresponse()
        raw = res.read().decode("utf-8", "replace")
        conn.close()
        return res.status, raw

    def _json(self, path):
        status, raw = self._request("GET", path)
        self.assertEqual(status, 200, path)
        return json.loads(raw)

    def test_openapi_declares_one_paid_operation_and_a_discovery_alias(self):
        spec = self._json("/openapi.json")
        tags = {t["name"] for t in spec["tags"]}
        self.assertIn("Discovery", tags)
        get_op, post_op = spec["paths"]["/route"]["get"], spec["paths"]["/route"]["post"]
        self.assertEqual(get_op["tags"], ["Discovery"])
        self.assertEqual(get_op["x-402signal-role"], "discovery-alias")
        self.assertNotIn("x-payment-info", get_op)
        self.assertIn("POST /route", get_op["summary"])
        self.assertIn("never GET", get_op["description"])
        self.assertIn("402", get_op["responses"])
        self.assertEqual(post_op["tags"], ["Paid"])
        self.assertEqual(post_op["x-402signal-role"], "paid-authorization")
        self.assertEqual(set(post_op["x-payment-info"]["networks"]), RAILS)
        self.assertEqual(post_op["x-payment-info"]["amountAtomic"], "3000")
        # The only priced operations are the two POST entry points (HTTP and MCP); no GET carries a price.
        priced = {
            (path, method) for path, ops in spec["paths"].items()
            for method, op in ops.items() if isinstance(op, dict) and "x-payment-info" in op
        }
        self.assertEqual(priced, {("/route", "post"), ("/mcp", "post")})
        self.assertEqual(spec["paths"]["/mcp"]["post"]["x-payment-info"]["price"], post_op["x-payment-info"]["price"])

    def test_well_known_names_post_only_with_all_rails(self):
        for path in ("/.well-known/x402", "/.well-known/x402.json"):
            doc = self._json(path)
            resources = doc["resources"]
            self.assertTrue(all(r.startswith("POST ") for r in resources if isinstance(r, str)), path)
            entries = [r for r in resources if isinstance(r, dict)]
            self.assertTrue(entries, path)
            for entry in entries:
                self.assertEqual(entry["method"], "POST", path)
                self.assertTrue(entry["url"].endswith("/route"), path)
                self.assertEqual(set(entry["networks"]), RAILS, path)
                self.assertEqual(entry["price_atomic"], "3000", path)
            self.assertEqual({a["network"] for a in doc["accepts"]}, RAILS, path)
            self.assertEqual({a["amount"] for a in doc["accepts"]}, {"3000"}, path)

    def test_rails_and_every_unpaid_challenge_agree_on_networks_and_price(self):
        rails = self._json("/rails")
        self.assertEqual({r["caip2"] for r in rails["rails"]}, RAILS)
        self.assertEqual({r["amountAtomic"] for r in rails["rails"]}, {"3000"})
        status, raw = self._request("GET", "/route?need=web+search")
        self.assertEqual(status, 402)
        get_challenge = json.loads(raw)
        status, raw = self._request("POST", "/route", {"need": "web search"})
        self.assertEqual(status, 402)
        post_challenge = json.loads(raw)
        status, raw = self._request("POST", "/mcp", MCP_CHECK, {"MCP-Protocol-Version": "2025-06-18"})
        self.assertEqual(status, 402)
        mcp_challenge = json.loads(raw)
        for name, challenge, resource in (("GET", get_challenge, "route"), ("POST", post_challenge, "route"), ("MCP", mcp_challenge, "mcp")):
            self.assertEqual({a["network"] for a in challenge["accepts"]}, RAILS, name)
            self.assertEqual({a["amount"] for a in challenge["accepts"]}, {"3000"}, name)
            self.assertEqual(challenge["resource"]["url"].rsplit("/", 1)[1], resource, name)
        # The GET alias hands out the same challenge as POST, and that challenge itself says the input method is POST.
        for name, challenge in (("GET", get_challenge), ("POST", post_challenge)):
            self.assertEqual(challenge["extensions"]["bazaar"]["info"]["input"]["method"], "POST", name)
        self.assertEqual(get_challenge["accepts"], post_challenge["accepts"])

    def test_mcp_distinguishes_malformed_handshake_and_unpaid_tool_call(self):
        for body in (None, {}, {"jsonrpc": "2.0", "id": 1}):
            status, raw = self._request("POST", "/mcp", body if body is not None else None, {"Content-Type": "application/json"})
            self.assertEqual(status, 400, body)
            self.assertEqual(json.loads(raw)["error"]["code"], -32600, body)
        status, _ = self._request("POST", "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}})
        self.assertEqual(status, 200)
        status, raw = self._request("POST", "/mcp", {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        self.assertEqual(status, 200)
        self.assertIn("check", [t["name"] for t in json.loads(raw)["result"]["tools"]])

    def test_guidance_never_pairs_get_with_authorization(self):
        status, llms = self._request("GET", "/llms.txt")
        self.assertEqual(status, 200)
        self.assertIn("should POST /route, not GET", llms)
        self.assertIn("Use POST for authorization", llms)
        for line in llms.splitlines():
            if "GET /route" in line:
                self.assertNotRegex(line, r"PAYMENT-SIGNATURE|paid retry|authorize with GET", line)
        manifest = self._json("/mcp.json")
        check = next(t for t in manifest["tools"] if t["name"] == "check")
        self.assertNotIn("GET /route", check["description"])
        self.assertNotRegex(json.dumps(manifest), re.compile(r"GET https://402signal\.com/route"))


if __name__ == "__main__":
    unittest.main()
