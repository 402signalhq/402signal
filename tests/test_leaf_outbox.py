"""Transparency-leaf outbox: gate, receipt shape, drain order. Fixture mode, no database."""

from __future__ import annotations

import hashlib
import http.client
import json
import os
import threading
import unittest
from unittest.mock import patch

os.environ.setdefault("LIVE402_FIXTURE", "1")

from live402 import leadership, maintenance, ready, replay, replay_store, route, server
from live402.pq import outbox, receipt, store
from live402.replay_store import StoreError


def leaf_hash(body: bytes) -> bytes:
    return hashlib.sha256(b"\x00" + body).digest()


class NeedsWriterTests(unittest.TestCase):
    def test_plain_paid_check_does_not_need_the_writer(self):
        self.assertFalse(outbox.needs_writer({"need": "weather"}))
        self.assertFalse(outbox.needs_writer({"url": "https://seller.example/api", "max_price_usd": 0.01}))
        self.assertFalse(outbox.needs_writer({"need": "weather", "require_transparency": False}))

    def test_signed_evidence_and_per_machine_state_need_the_writer(self):
        self.assertTrue(outbox.needs_writer({"need": "weather", "require_route_binding": True}))
        self.assertTrue(outbox.needs_writer({"need": "weather", "require_transparency": True}))
        self.assertTrue(outbox.needs_writer({"need": "weather", "require_transparency": "yes"}))
        self.assertTrue(outbox.needs_writer({"url": "https://seller.example/api", "session": "open"}))
        self.assertTrue(outbox.needs_writer({"url": "https://seller.example/api", "session": "hop", "session_id": "x"}))
        self.assertTrue(outbox.needs_writer({"url": "https://seller.example/api", "session": "bogus"}))
        self.assertTrue(outbox.needs_writer({"url": "https://seller.example/api", "buyer_limits": {"network": "eip155:8453", "asset": "USDC", "recipient": "0x0", "max_call_amount_atomic": "1"}, "require_route_binding": True}))
        self.assertTrue(outbox.needs_writer(None))
        self.assertTrue(outbox.needs_writer("need"))

    def test_off_by_default_and_needs_a_shared_authority(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop(outbox.ENV, None)
            self.assertFalse(outbox.enabled())
            self.assertFalse(outbox.available())
        with patch.dict(os.environ, {outbox.ENV: "1"}), patch.object(replay_store, "backend_name", return_value="sqlite"):
            self.assertFalse(outbox.enabled())
        with patch.dict(os.environ, {outbox.ENV: "1"}), patch.object(replay_store, "backend_name", return_value="postgres"):
            self.assertTrue(outbox.enabled())
            with patch.object(replay, "outbox_supported", return_value=False):
                self.assertFalse(outbox.available())
            with patch.object(replay, "outbox_supported", return_value=True):
                self.assertTrue(outbox.available())


class QueueAndReceiptTests(unittest.TestCase):
    def _result(self):
        return {
            "live": True, "payable": True, "url": "https://seller.example/api",
            "selected_payment": {"rail": "base", "network": "eip155:8453", "asset": "USDC",
                                 "amount_atomic": 1000, "payTo": "0x" + "1" * 40},
            "payment_authorization": {},
        }

    def test_queue_sends_public_leaf_bytes_and_hash(self):
        captured = {}

        def put(body, digest, queued_by):
            captured.update(body=body, digest=digest, queued_by=queued_by)
            return {"id": 7, "duplicate": False, "appended_idx": None}

        from live402.pq import events

        evidence = events.private_evidence_v3_from_route(self._result(), {"need": "weather"})
        event, _reveal = events.route_decision_event_v3(evidence=evidence)
        with patch.object(replay, "outbox_put", side_effect=put):
            out = outbox.queue(event)
        self.assertEqual(out["id"], 7)
        self.assertEqual(captured["digest"], leaf_hash(captured["body"]))
        self.assertEqual(out["leaf_hash"], captured["digest"])
        self.assertIn(b"402signal.route_decision.v3", captured["body"])
        self.assertNotIn(b"salt", captured["body"])
        self.assertTrue(captured["queued_by"])

    def test_without_the_lease_a_plain_check_gets_a_queued_receipt_that_is_not_ok(self):
        queued = {}

        def fake_queue(event):
            queued["event"] = event
            return {"id": 9, "leaf_hash": b"\x11" * 32, "duplicate": False, "appended_idx": None}

        with patch.object(leadership, "holds", return_value=False), \
                patch.object(outbox, "available", return_value=True), \
                patch.object(outbox, "queue", side_effect=fake_queue), \
                patch.object(store, "append") as append:
            result = receipt.attach_to_route(self._result(), {"need": "weather"})
        append.assert_not_called()
        tr = result["pq_trust"]["transparency"]
        self.assertEqual((tr["status"], tr["state"], tr["outbox_id"]), ("queued", "outbox_queued", 9))
        self.assertEqual(tr["receipt"], {"leaf_hash": "11" * 32})
        self.assertIn("reveal", tr)
        self.assertNotIn("checkpoint", tr["receipt"])
        self.assertEqual(queued["event"]["type"], "402signal.route_decision.v3")
        self.assertFalse(route._transparency_ok(result))
        self.assertFalse(result["payment_authorization"]["pq_native"])

    def test_without_the_lease_binding_requests_never_queue(self):
        with patch.object(leadership, "holds", return_value=False), \
                patch.object(outbox, "available", return_value=True), \
                patch.object(outbox, "queue") as queue, \
                patch.object(store, "append") as append:
            result = receipt.attach_to_route(self._result(), {"need": "weather", "require_route_binding": True})
        queue.assert_not_called()
        append.assert_not_called()
        self.assertEqual(result["pq_trust"]["transparency"]["status"], "unavailable")

    def test_without_the_lease_and_without_the_outbox_the_receipt_is_unavailable(self):
        with patch.object(leadership, "holds", return_value=False), \
                patch.object(outbox, "available", return_value=False), \
                patch.object(outbox, "queue") as queue:
            result = receipt.attach_to_route(self._result(), {"need": "weather"})
        queue.assert_not_called()
        self.assertEqual(result["pq_trust"]["transparency"]["status"], "unavailable")

    def test_with_the_lease_the_outbox_is_never_used(self):
        with patch.object(leadership, "holds", return_value=True), \
                patch.object(outbox, "available", return_value=True), \
                patch.object(outbox, "queue") as queue, \
                patch.object(receipt, "available", return_value=True), \
                patch.object(receipt, "issue", return_value={
                    "index": 3, "inclusion_path": [], "checkpoint": "402signal.com/pq/log\n4\nAAAA\n",
                    "checkpoint_size": 4, "leaf_hash": "22" * 32, "state": "checkpoint_signed"}):
            result = receipt.attach_to_route(self._result(), {"need": "weather"})
        queue.assert_not_called()
        self.assertEqual(result["pq_trust"]["transparency"]["status"], "pending")


class DrainTests(unittest.TestCase):
    def test_drain_appends_in_order_acks_and_skips_corrupt_rows(self):
        bodies = [b'{"n":1}', b'{"n":2}', b'{"n":3}']
        rows = [(1, leaf_hash(bodies[0]), bodies[0]), (2, b"\x00" * 32, bodies[1]), (3, leaf_hash(bodies[2]), bodies[2])]
        appended, acked = [], []

        def append(raw):
            appended.append(raw)
            return {"idx": 100 + len(appended), "leaf_hash": leaf_hash(raw), "size": 101 + len(appended), "duplicate": False}

        with patch.object(leadership, "holds", return_value=True), \
                patch.object(outbox, "available", return_value=True), \
                patch.object(replay, "outbox_pending", return_value=rows), \
                patch.object(replay, "outbox_ack", side_effect=lambda row_id, idx: acked.append((row_id, idx)) or True), \
                patch.object(store, "append", side_effect=append), \
                patch.object(store, "leaf_at", side_effect=lambda idx: {"idx": idx}), \
                patch.object(store, "ready_to_checkpoint", return_value=True):
            self.assertEqual(outbox.drain(), 2)
        self.assertEqual(appended, [bodies[0], bodies[2]])
        self.assertEqual(acked, [(1, 101), (3, 102)])

    def test_drain_is_a_noop_without_the_lease_or_the_outbox(self):
        with patch.object(leadership, "holds", return_value=False), patch.object(replay, "outbox_pending") as pending:
            self.assertEqual(outbox.drain(), 0)
        pending.assert_not_called()
        with patch.object(leadership, "holds", return_value=True), patch.object(outbox, "available", return_value=False), \
                patch.object(replay, "outbox_pending") as pending:
            self.assertEqual(outbox.drain(), 0)
        pending.assert_not_called()

    def test_drain_stops_when_the_lease_is_lost_and_never_acks_a_non_durable_leaf(self):
        rows = [(1, leaf_hash(b"a"), b"a"), (2, leaf_hash(b"b"), b"b")]
        holds = iter([True, True, False])
        with patch.object(leadership, "holds", side_effect=lambda: next(holds)), \
                patch.object(outbox, "available", return_value=True), \
                patch.object(replay, "outbox_pending", return_value=rows), \
                patch.object(replay, "outbox_ack") as ack, \
                patch.object(store, "append", return_value={"idx": 5, "leaf_hash": leaf_hash(b"a"), "size": 6, "duplicate": False}), \
                patch.object(store, "leaf_at", return_value=None):
            self.assertEqual(outbox.drain(), 0)
        ack.assert_not_called()

    def test_maintenance_runs_the_drain_on_the_writer_only(self):
        self.assertIn("leaf_outbox_drain", [name for name, _ in maintenance.JOBS])
        with patch.object(leadership, "holds", return_value=True), patch.object(outbox, "drain", return_value=2) as drain, \
                patch.object(outbox, "prune", return_value=0), patch.dict(maintenance._last, {}, clear=True), \
                patch.object(maintenance, "_session_prune"), patch.object(maintenance, "_metrics_flush"), \
                patch.object(maintenance, "_replay_capacity"), patch.object(maintenance, "_replay_expire"):
            self.assertIn("leaf_outbox_drain", maintenance.run_due(now=1e9))
        drain.assert_called_once()
        with patch.object(leadership, "holds", return_value=False), patch.object(outbox, "drain") as drain:
            self.assertEqual(maintenance.run_due(now=2e9), [])
        drain.assert_not_called()


class PaidGateOutboxTests(unittest.TestCase):
    def setUp(self):
        self.httpd = server.BoundedThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.limiter = patch.object(server._ROUTE_LIMITER, "allow", return_value=True)
        self.limiter.start()

    def tearDown(self):
        self.limiter.stop()
        self.httpd.shutdown()
        self.httpd.server_close()

    def _post(self, payload, path="/route"):
        body = json.dumps(payload).encode("utf-8")
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=20)
        try:
            conn.request("POST", path, body=body, headers={
                "Content-Type": "application/json", "Content-Length": str(len(body)), "PAYMENT-SIGNATURE": "e30=",
            })
            resp = conn.getresponse()
            return resp.status, json.loads(resp.read() or b"{}")
        finally:
            conn.close()

    def test_plain_paid_check_passes_the_gate_without_the_lease_when_the_outbox_is_available(self):
        with patch.object(leadership, "holds", return_value=False), \
                patch.object(outbox, "available", return_value=True), \
                patch.object(ready, "cached_readiness", return_value={"ok": True, "checks": {}}):
            status, body = self._post({"need": "weather"})
        # Past the gate: whatever the fixture facilitator decides about the
        # placeholder payment, it is no longer refused for lack of the lease.
        self.assertNotEqual(body.get("error"), "writer_unavailable", (status, body))
        self.assertNotEqual(body.get("error"), "service_not_ready", (status, body))

    def test_binding_session_and_recovery_still_wait_for_the_writer(self):
        with patch.object(leadership, "holds", return_value=False), \
                patch.object(outbox, "available", return_value=True), \
                patch("live402.facilitator.verify") as verify:
            for payload in ({"need": "weather", "require_route_binding": True},
                            {"need": "weather", "require_transparency": True},
                            {"url": "https://seller.example/api", "session": "open"}):
                status, body = self._post(payload)
                self.assertEqual((status, body["error"]), (503, "writer_unavailable"), payload)
            status, body = self._post({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                       "params": {"name": "check", "arguments": {"need": "weather", "require_route_binding": True}}}, "/mcp")
            self.assertEqual((status, body["error"]), (503, "writer_unavailable"))
        verify.assert_not_called()

    def test_without_the_outbox_the_gate_is_unchanged(self):
        with patch.object(leadership, "holds", return_value=False), \
                patch.object(outbox, "available", return_value=False), \
                patch("live402.facilitator.verify") as verify:
            status, body = self._post({"need": "weather"})
        self.assertEqual((status, body["error"]), (503, "writer_unavailable"))
        verify.assert_not_called()


if __name__ == "__main__":
    unittest.main()
