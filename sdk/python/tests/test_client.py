import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import signal402


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # quiet
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        self.server.seen.append({"headers": dict(self.headers), "body": body})
        if self.headers.get("PAYMENT-SIGNATURE"):
            status, payload = 200, {"live": True, "payable": True, "billing": {"settled": True}}
            if self.headers.get("Replay-Only") == "1":
                payload["replayed"] = True
        else:
            status, payload = 402, {"x402Version": 2, "accepts": [{"scheme": "exact", "network": "eip155:8453"}]}
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class ClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.server.seen = []
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.router = "http://127.0.0.1:%d/route" % cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_challenge_then_check_then_recover(self):
        request = {"url": "https://seller.example/x402", "require_route_binding": True}
        fee = signal402.challenge(request, router=self.router)
        self.assertEqual((fee.status, fee.outcome), (402, signal402.CHALLENGE))
        self.assertEqual(fee.body["accepts"][0]["network"], "eip155:8453")
        answer = signal402.check(request, "sig", router=self.router, replay_key="ab" * 32)
        self.assertEqual((answer.status, answer.outcome), (200, signal402.LIVE))
        self.assertIsNone(answer.receipt)
        again = signal402.recover(request, "sig", "ab" * 32, router=self.router)
        self.assertTrue(again.body["replayed"])
        sent = self.server.seen[-1]
        self.assertEqual(sent["body"], request)
        self.assertEqual(sent["headers"]["Replay-Key"], "ab" * 32)
        self.assertEqual(sent["headers"]["Replay-Only"], "1")

    def test_input_validation(self):
        with self.assertRaises(ValueError):
            signal402.check({}, "", router=self.router)
        with self.assertRaises(ValueError):
            signal402.check({}, "sig", router=self.router, replay_key="not-hex")
        with self.assertRaises(ValueError):
            signal402.challenge({}, router="http://example.com/route")


class ClassifyTests(unittest.TestCase):
    def test_contract_table(self):
        c = signal402.classify
        self.assertEqual(c(402, {"accepts": []}), signal402.CHALLENGE)
        self.assertEqual(c(200, {"live": True}), signal402.LIVE)
        self.assertEqual(c(200, {"live": False, "miss_reason": "no_candidates"}), signal402.MISS)
        self.assertEqual(c(503, {"binding_error": "route_binding_unavailable"}), signal402.BINDING_UNAVAILABLE)
        self.assertEqual(c(503, {"billing": {"settlement_state": "settled"}}), signal402.SETTLED_EVIDENCE_FAILED)
        self.assertEqual(c(503, {"billing": {"settlement_state": "unknown"}}), signal402.UNKNOWN_SETTLEMENT)
        self.assertEqual(c(503, {"billing": {"settlement_state": "not_attempted"}}), signal402.REFUSED)
        self.assertEqual(c(429, {"error": "busy"}), signal402.REFUSED)
        self.assertEqual(c(500, None), signal402.ERROR)
        self.assertEqual(c(200, {}), signal402.ERROR)


if __name__ == "__main__":
    unittest.main()
