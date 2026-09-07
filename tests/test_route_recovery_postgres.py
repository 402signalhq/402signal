"""Real HTTP/process-restart recovery against disposable PostgreSQL only.

Payment signatures, provider replies and merchant probes are synthetic fixtures.
This qualifies storage/orchestration across all supported wire formats, not chain
signature validity or live facilitator compatibility. No external calls are made.
"""
from __future__ import annotations

import base64
import hashlib
import http.client
import json
import multiprocessing
import os
from pathlib import Path
import struct
import tempfile
import time
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
COUNTERS = ("verify", "settle", "probe", "history", "pq", "begin", "authorize", "finish", "ingress", "rpc", "network")
AUTHORITY = "92" * 16
RUNTIME_ROLE = "recovery_http_runtime"


def _wire_payload(rail, nonce="original"):
    from live402 import algo_tx, discover, payment
    from tests.test_pay_replay import _payload
    if rail == "base":
        return _payload(nonce)
    accept = next(item for item in payment.payment_required(discover.ROUTE, dynamic=False)["accepts"]
                  if payment.rail_of_accept(item) == rail)
    if rail == "solana":
        # Structurally serialized v0 SPL TransferChecked message. Dummy
        # signatures/account bytes intentionally cannot authorize a live payment.
        keys = b"".join(bytes([index]) * 32 for index in range(1, 6))
        data = b"\x0c" + struct.pack("<Q", 3000) + b"\x06"
        instruction = b"\x04\x04\x01\x03\x02\x00" + bytes([len(data)]) + data
        blockhash = hashlib.sha256(nonce.encode()).digest()
        message = b"\x80\x01\x00\x02\x05" + keys + blockhash + b"\x01" + instruction + b"\x00"
        inner = {"transaction": base64.b64encode(b"\x01" + b"A" * 64 + message).decode()}
    else:
        txn = {"type": "axfer", "xaid": int(payment.USDC_ALGORAND_ASA), "aamt": 3000,
               "arcv": algo_tx.decode_address(payment.payto_algorand()), "snd": b"S" * 32,
               "fv": 1, "lv": 100, "fee": 1000,
               "gh": base64.b64decode(payment.ALGORAND_MAINNET.split(":", 1)[1]),
               "note": nonce.encode()}
        signed = algo_tx.msgpack_encode({"sig": b"A" * 64, "txn": txn})
        inner = {"paymentIndex": 0, "paymentGroup": [base64.b64encode(signed).decode()]}
    return {"x402Version": 2, "resource": {"url": discover.ROUTE}, "accepted": accept, "payload": inner}


def _http_worker(connection, counters, environment, rail, expired_at=None):
    # Spawn provides a new interpreter and empty replay maps, rather than a
    # same-process reset masquerading as restart evidence.
    os.environ.clear()
    os.environ.update(environment)
    from live402 import admission, facilitator, history, payment, replay, route, server

    def count(name):
        with counters.get_lock():
            counters[COUNTERS.index(name)] += 1

    def counted(name, function):
        def call(*args, **kwargs):
            count(name)
            return function(*args, **kwargs)
        return call

    def verify(*args, **kwargs):
        count("verify")
        return SimpleNamespace(ok=True)

    def settle(payload, accept, **kwargs):
        count("settle")
        transaction = {"base": "0x" + "cd" * 32, "solana": "1" * 64,
                       "algorand": base64.b32encode(b"R" * 32).decode().rstrip("=")}[rail]
        return SimpleNamespace(ok=True, body={"success": True, "network": accept["network"],
                                             "transaction": transaction})

    def forbidden_network(*args, **kwargs):
        count("network")
        raise AssertionError("external call attempted in synthetic recovery test")

    class Quiet(server.Handler):
        def log_message(self, *args):
            pass

    with ExitStack() as stack:
        policy = admission.Policy({"version": 1, "window_seconds": 60, "max_keys": 128,
            "ingress": {"global": 1, "anonymous": 1}, "unpaid": {"global": 1, "anonymous": 1},
            "target": {"global": 1, "origin": 1, "failures": 1}, "customers": {}})
        engine = admission.Engine(policy)
        stack.enter_context(patch.object(admission, "configured", return_value=True))
        stack.enter_context(patch.object(admission, "engine", return_value=engine))
        stack.enter_context(patch.object(facilitator, "verify", side_effect=verify))
        stack.enter_context(patch.object(facilitator, "settle", side_effect=settle))
        stack.enter_context(patch.object(facilitator, "post_json", side_effect=forbidden_network))
        stack.enter_context(patch("live402.algo_tx.algorand_accept_extra", side_effect=counted("rpc", lambda *a, **k: {})))
        stack.enter_context(patch("live402.algod.suggested_params", side_effect=forbidden_network))
        stack.enter_context(patch.object(route, "run_probe", side_effect=counted("probe", route.run_probe)))
        stack.enter_context(patch.object(history, "mark_batch_settled", side_effect=counted("history", history.mark_batch_settled)))
        stack.enter_context(patch.object(history, "persist_route_batch", side_effect=counted("history", history.persist_route_batch)))
        stack.enter_context(patch.object(route, "_attach_pq_trust", side_effect=counted("pq", lambda code, result, body: result)))
        for name in ("begin", "authorize", "finish"):
            stack.enter_context(patch.object(replay, name, side_effect=counted(name, getattr(replay, name))))
        stack.enter_context(patch.object(server.Handler, "_route_allowed", counted("ingress", server.Handler._route_allowed)))
        if expired_at is not None:
            # Advance only the replay expiry observer; preserve the actual stored
            # expiry, request deadline, socket clock and recovery limiter clock.
            stack.enter_context(patch.object(replay, "time", SimpleNamespace(time=lambda: expired_at)))
        assert not replay._completed and not replay._inflight
        httpd = server.BoundedThreadingHTTPServer(("127.0.0.1", 0), Quiet)
        connection.send((httpd.server_port, os.getpid()))
        connection.close()
        httpd.serve_forever(poll_interval=0.05)


@unittest.skipUnless(os.environ.get("LIVE402_PG_TEST_DESTRUCTIVE") == "isolated-ci-only",
                     "requires explicitly disposable loopback PostgreSQL")
class PostgreSQLHTTPRecoveryTests(unittest.TestCase):
    def setUp(self):
        import psycopg
        from psycopg.conninfo import conninfo_to_dict, make_conninfo
        from live402.replay_postgres import validate_settings
        config, _ = validate_settings({"LIVE402_REPLAY_AUTHORITY_ID": AUTHORITY,
            "LIVE402_REPLAY_POSTGRES_DSN": os.environ["LIVE402_PG_TEST_DSN"],
            "LIVE402_PG_TEST_SUPPORT": "1"}, conninfo_to_dict)
        if config.get("host") != "127.0.0.1" or config.get("dbname") != "402signal_ci":
            raise RuntimeError("refusing destructive tests outside disposable loopback CI database")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.admin = psycopg.connect(**config, autocommit=True)
        self.addCleanup(self.admin.close)
        self.admin.execute("DROP SCHEMA IF EXISTS signal_replay CASCADE")
        if not self.admin.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (RUNTIME_ROLE,)).fetchone():
            self.admin.execute("CREATE ROLE recovery_http_runtime LOGIN PASSWORD 'isolated-recovery-fixture'")
        self.admin.execute("GRANT pg_read_all_data TO recovery_http_runtime")
        self.admin.execute((ROOT / "ops/replay-postgres-functions.sql").read_text())
        self.admin.execute("INSERT INTO signal_replay.authority(singleton,authority_id,schema_version,active,legacy_ready,admitted,max_rows,max_bytes,migration_digest) VALUES(TRUE,%s,1,TRUE,TRUE,0,1000,268435456,%s)", (AUTHORITY, "0" * 64))
        self.admin.execute("INSERT INTO signal_replay.runtime_policy VALUES(TRUE,%s,%s,(extract(epoch FROM pg_postmaster_start_time())*1000000)::bigint,inet_server_addr())", (AUTHORITY, RUNTIME_ROLE))
        runtime_dsn = make_conninfo(**dict(config, user=RUNTIME_ROLE, password="isolated-recovery-fixture"))
        self.environment = {key: value for key, value in os.environ.items() if not key.startswith("FLY_")}
        self.environment.update(LIVE402_FIXTURE="1", LOCAL_FREE="0", LIVE402_REPLAY_BACKEND="postgres",
            LIVE402_REPLAY_POSTGRES_DSN=runtime_dsn, LIVE402_REPLAY_AUTHORITY_ID=AUTHORITY,
            LIVE402_REPLAY_POSTGRES_API="functions-v1", LIVE402_PG_TEST_SUPPORT="1",
            LIVE402_ROUTER_WRITERS="1", LIVE402_ADMISSION_POLICY_FILE="",
            LIVE402_HISTORY_DB=str(Path(self.tmp.name) / "history.sqlite"),
            LIVE402_REPLAY_DB=str(Path(self.tmp.name) / "must-not-exist.sqlite"))
        self.ctx = multiprocessing.get_context("spawn")
        self.counters = self.ctx.Array("i", len(COUNTERS))
        self.processes = []
        self.addCleanup(self.stop_all)

    def stop_all(self):
        for process in self.processes:
            self.stop(process)

    def stop(self, process):
        if process.is_alive():
            process.terminate()
            process.join(timeout=5)
            if process.is_alive():
                process.kill()
                process.join(timeout=5)
        self.assertFalse(process.is_alive())

    def start(self, rail, expired_at=None):
        parent, child = self.ctx.Pipe(duplex=False)
        process = self.ctx.Process(target=_http_worker, args=(child, self.counters, self.environment, rail, expired_at))
        process.start()
        self.processes.append(process)
        child.close()
        self.assertTrue(parent.poll(15), "HTTP fixture process did not start")
        port, pid = parent.recv()
        parent.close()
        return process, port, pid

    def request(self, port, payload, *, recovery=False, key="a1" * 32, body=None):
        from tests.test_pay_replay import _headers_for, _weather_body
        headers = dict(_headers_for(payload))
        if key is None:
            headers.pop("Replay-Key")
        else:
            headers["Replay-Key"] = key
        if recovery:
            headers["Replay-Only"] = "1"
        headers["Content-Type"] = "application/json"
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            connection.request("POST", "/route", json.dumps(body if body is not None else _weather_body()), headers)
            response = connection.getresponse()
            return response.status, response.read(), dict(response.getheaders())
        finally:
            connection.close()

    def snapshot(self):
        return (self.admin.execute("SELECT * FROM signal_replay.entries ORDER BY fp_hash").fetchall(),
                self.admin.execute("SELECT * FROM signal_replay.authority").fetchall(), tuple(self.counters[:]))

    def qualify(self, rail):
        payload = _wire_payload(rail)
        initial, port, initial_pid = self.start(rail)
        first = self.request(port, payload)
        self.assertEqual(first[0], 200, first)
        first_body = json.loads(first[1])
        self.assertEqual(first_body["billing"]["rail"], rail)
        self.assertTrue(first_body["billing"]["settled"])
        self.assertIn("PAYMENT-RESPONSE", first[2])
        blocked = self.request(port, payload)
        self.assertEqual(blocked[0], 429)
        self.assertFalse(json.loads(blocked[1])["new_payment_allowed"])
        self.stop(initial)
        baseline = self.snapshot()
        self.assertEqual(len(baseline[0]), 1)
        self.assertEqual(baseline[1][0][5], 1, "exactly one admitted authorization")
        created, expires = self.admin.execute("SELECT created_at,expires_at FROM signal_replay.entries").fetchone()
        self.assertAlmostEqual(expires - created, 120, delta=2)
        for name in ("verify", "settle", "probe", "pq", "begin", "authorize", "finish"):
            self.assertEqual(baseline[2][COUNTERS.index(name)], 1, name)
        self.assertGreaterEqual(baseline[2][COUNTERS.index("history")], 1)
        self.assertEqual(baseline[2][COUNTERS.index("network")], 0)

        restarted, port, restarted_pid = self.start(rail)
        self.assertNotEqual(initial_pid, restarted_pid)
        for _ in range(2):
            recovered = self.request(port, payload, recovery=True)
            self.assertEqual(recovered[:2], first[:2], "exact response bytes survive process restart")
            self.assertEqual(recovered[2].get("PAYMENT-RESPONSE"), first[2]["PAYMENT-RESPONSE"])
            self.assertEqual(recovered[2]["Cache-Control"], "no-store")
            self.assertEqual(self.snapshot(), baseline)
        unavailable = [
            self.request(port, payload, recovery=True, key="b2" * 32),
            self.request(port, payload, recovery=True, key=None),
            self.request(port, payload, recovery=True, body={"need": "changed"}),
            self.request(port, _wire_payload(rail, "new-authorization"), recovery=True),
        ]
        for result in unavailable:
            self.assertEqual(result[0], 503)
            self.assertEqual(json.loads(result[1])["error"], "recovery_unavailable")
        self.stop(restarted)
        self.assertEqual(self.snapshot(), baseline)
        self.assertEqual(self.admin.execute("SELECT expires_at FROM signal_replay.entries").fetchone()[0], expires)

        expired, port, expired_pid = self.start(rail, expired_at=expires + 1)
        self.assertNotEqual(expired_pid, restarted_pid)
        result = self.request(port, payload, recovery=True)
        self.assertEqual(result[0], 503)
        self.assertEqual(json.loads(result[1])["error"], "recovery_unavailable")
        self.stop(expired)
        self.assertEqual(self.snapshot(), baseline, "expiry observation cannot renew response or execute work")
        self.assertFalse(Path(self.environment["LIVE402_REPLAY_DB"]).exists(), "no SQLite fallback")

    def test_base_http_recovery_after_process_restart(self):
        self.qualify("base")

    def test_solana_http_recovery_after_process_restart(self):
        self.qualify("solana")

    def test_algorand_http_recovery_after_process_restart(self):
        self.qualify("algorand")


if __name__ == "__main__":
    unittest.main()
