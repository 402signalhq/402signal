import importlib.util
import io
import json
from pathlib import Path
import unittest
from urllib.error import HTTPError, URLError

spec = importlib.util.spec_from_file_location("glama_stdio", Path(__file__).resolve().parents[1] / "scripts" / "glama_stdio.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class GlamaStdioTests(unittest.TestCase):
    def test_initialize_preserves_identity_and_discloses_payment_limit(self):
        remote = {"jsonrpc": "2.0", "id": 1, "result": {
            "protocolVersion": "2025-06-18", "serverInfo": {"name": "402Signal", "version": "0.5.0"},
            "capabilities": {"tools": {}}, "instructions": "Original instructions"}}
        def opener(request, timeout):
            self.assertEqual(request.full_url, adapter.ENDPOINT)
            self.assertEqual(timeout, 25)
            self.assertNotIn("Authorization", request.headers)
            self.assertNotIn("Payment-signature", request.headers)
            return io.BytesIO(json.dumps(remote).encode())
        result = adapter.forward({"jsonrpc": "2.0", "id": 1, "method": "initialize"}, opener)
        self.assertEqual(result["result"]["serverInfo"], remote["result"]["serverInfo"])
        self.assertIn("Original instructions", result["result"]["instructions"])
        self.assertIn("does not sign or submit payments", result["result"]["instructions"])

    def test_tool_definitions_and_results_are_unchanged(self):
        for method, payload in [("tools/list", {"tools": [{"name": "preview", "inputSchema": {"type": "object"}}]}),
                                ("tools/call", {"content": [{"type": "text", "text": "live result"}], "isError": False})]:
            remote = {"jsonrpc": "2.0", "id": "test", "result": payload}
            result = adapter.forward({"jsonrpc": "2.0", "id": "test", "method": method},
                                     lambda request, timeout: io.BytesIO(json.dumps(remote).encode()))
            self.assertEqual(result, remote)

    def test_payment_required_is_tool_error_and_next_request_still_works(self):
        count = 0
        def opener(request, timeout):
            nonlocal count
            count += 1
            if count == 1:
                raise HTTPError(adapter.ENDPOINT, 402, "Payment Required", {}, io.BytesIO(b'{"accepts":[{"amount":"3000"}]}'))
            return io.BytesIO(b'{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}')
        lines = b'{"jsonrpc":"2.0","id":1,"method":"tools/call"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n'
        out = io.StringIO()
        adapter.serve(io.BytesIO(lines), out, lambda message: adapter.forward(message, opener))
        first, second = map(json.loads, out.getvalue().splitlines())
        self.assertTrue(first["result"]["isError"])
        self.assertIn('"amount":"3000"', first["result"]["content"][0]["text"])
        self.assertNotIn("structuredContent", first["result"])
        self.assertEqual(second["result"], {"tools": []})

    def test_notification_has_no_response(self):
        self.assertIsNone(adapter.forward({"jsonrpc": "2.0", "method": "notifications/initialized"},
                                          lambda request, timeout: io.BytesIO(b"")))

    def test_network_failure_is_bounded_error(self):
        def opener(request, timeout):
            raise URLError("private system details")
        result = adapter.forward({"jsonrpc": "2.0", "id": 4, "method": "tools/list"}, opener)
        self.assertEqual(result["id"], 4)
        self.assertEqual(result["error"]["code"], -32000)
        self.assertNotIn("private", result["error"]["message"])

    def test_invalid_frames_and_mismatched_response_id(self):
        out = io.StringIO()
        adapter.serve(io.BytesIO(b'not-json\n[]\n'), out)
        self.assertEqual([json.loads(line)["error"]["code"] for line in out.getvalue().splitlines()], [-32700, -32600])
        result = adapter.forward({"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                                 lambda request, timeout: io.BytesIO(b'{"jsonrpc":"2.0","id":2,"result":{}}'))
        self.assertEqual(result["error"]["code"], -32000)


if __name__ == "__main__":
    unittest.main()
