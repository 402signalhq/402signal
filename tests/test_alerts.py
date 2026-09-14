"""Change alerts: key-scoped subscriptions, observation-driven events, signed at-least-once delivery."""

from __future__ import annotations

import hashlib
import http.client
import json
import os
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

os.environ.setdefault("LIVE402_FIXTURE", "1")

from live402 import admission, alerts, history, maintenance, payment, server, session, shadow

HOST = "alerts-seller.example"
URL = "https://%s/api/quote" % HOST
PAYTO_A = "0xabcabcabcabcabcabcabcabcabcabcabcabcabca"
PAYTO_B = "0xbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc"
KEY_ONE = "customer-key-one-" + "x" * 30
KEY_TWO = "customer-key-two-" + "y" * 30
HOOK = "https://hooks.example.com/402signal"


def _policy():
    return admission.Policy({
        "version": 1, "window_seconds": 60, "max_keys": 1024,
        "ingress": {"global": 100, "anonymous": 10},
        "unpaid": {"global": 50, "anonymous": 5},
        "target": {"global": 10, "origin": 5, "failures": 5},
        "customers": {
            hashlib.sha256(KEY_ONE.encode()).hexdigest(): {"ingress": 7, "unpaid": 3},
            hashlib.sha256(KEY_TWO.encode()).hexdigest(): {"ingress": 7, "unpaid": 3},
        },
    })


def _snap(live, pay_to=PAYTO_A, amount="10000", ts=None, miss="timeout"):
    row = {
        "live": bool(live), "status": 402 if live else None, "latency_ms": 10, "has_402_challenge": bool(live),
        "payTo": pay_to if live else None, "_route_traffic_class": history.TRAFFIC_ORGANIC,
    }
    if ts is not None:
        row["ts"] = int(ts)
    if live:
        row["envelope"] = {"x402Version": 2, "accepts": [{
            "scheme": "exact", "network": payment.BASE_CAIP2, "asset": payment.USDC_BASE,
            "amount": amount, "payTo": pay_to, "maxTimeoutSeconds": 60,
        }]}
        row.update(amount=amount, asset=payment.USDC_BASE, rail="base")
    else:
        row["miss_reason"] = miss
    return row


class AlertsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._env = {k: os.environ.get(k) for k in ("LIVE402_SESSION_DB", "LIVE402_HISTORY_DB", "LIVE402_CATALOG_DB")}
        os.environ["LIVE402_SESSION_DB"] = os.path.join(self.tmp.name, "session.sqlite")
        os.environ["LIVE402_HISTORY_DB"] = os.path.join(self.tmp.name, "history.sqlite")
        os.environ["LIVE402_CATALOG_DB"] = os.path.join(self.tmp.name, "catalog.sqlite")
        history.reset()
        shadow.reset()
        self.sent = []
        self.post_fails =False
        self.status = 200

        def fake_post(url, body, headers, timeout):
            self.sent.append((url, body, dict(headers)))
            if self.post_fails:
                raise OSError("connection refused")
            return self.status

        engine = admission.Engine(_policy(), cold_start=True)
        self.patches = [
            patch.object(alerts, "_post", fake_post),
            patch.object(alerts, "_target_ok", lambda url: True),
            patch.object(admission, "engine", return_value=engine),
            patch.object(admission, "configured", return_value=True),
        ]
        for p in self.patches:
            p.start()
        self.httpd = server.BoundedThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        for p in self.patches:
            p.stop()
        session.reset()
        history.reset()
        shadow.reset()
        for key, value in self._env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmp.cleanup()

    def _call(self, method, path, body=None, key=KEY_ONE):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            headers = {}
            if key:
                headers["X-402Signal-Key"] = key
            data = None
            if body is not None:
                data = json.dumps(body).encode()
                headers["Content-Type"] = "application/json"
            elif method == "POST":
                data = b""
            conn.request(method, path, body=data, headers=headers)
            resp = conn.getresponse()
            raw = resp.read()
            return resp.status, dict(resp.getheaders()), (json.loads(raw) if raw else None)
        finally:
            conn.close()

    def _create(self, **overrides):
        body = {"url": HOOK, "hosts": [HOST], "events": ["price", "recipient", "liveness"]}
        body.update(overrides)
        status, _, out = self._call("POST", "/alerts", body)
        self.assertEqual(status, 201, out)
        return out

    def test_key_required_for_every_verb(self):
        self.assertEqual(self._call("GET", "/alerts", key=None)[0], 401)
        self.assertEqual(self._call("GET", "/alerts", key="z" * 40)[0], 401)
        self.assertEqual(self._call("POST", "/alerts", {"url": HOOK, "hosts": [HOST]}, key=None)[0], 401)
        self.assertEqual(self._call("DELETE", "/alerts/0123456789abcdef", key=None)[0], 401)
        status, headers, body = self._call("GET", "/alerts", key=None)
        self.assertEqual(body["error"], "key_required")
        self.assertIn("no-store", headers.get("Cache-Control", ""))

    def test_create_list_get_delete_are_owner_scoped(self):
        created = self._create()
        self.assertTrue(created["signing_secret"].startswith("whsec_"))
        self.assertEqual(created["hosts"], [HOST])
        self.assertEqual(created["hosts_known"], {HOST: False})
        self.assertTrue(created["active"])
        status, _, listing = self._call("GET", "/alerts")
        self.assertEqual(status, 200)
        self.assertEqual([s["id"] for s in listing["subscriptions"]], [created["id"]])
        self.assertNotIn("whsec_", json.dumps(listing))
        self.assertEqual(listing["limits"]["subscriptions_per_key"], alerts.MAX_SUBSCRIPTIONS)
        status, _, detail = self._call("GET", "/alerts/" + created["id"])
        self.assertEqual((status, detail["deliveries"]), (200, []))
        self.assertEqual(self._call("GET", "/alerts/" + created["id"], key=KEY_TWO)[0], 404)
        self.assertEqual(self._call("GET", "/alerts", key=KEY_TWO)[2]["subscriptions"], [])
        self.assertEqual(self._call("DELETE", "/alerts/" + created["id"], key=KEY_TWO)[0], 404)
        self.assertEqual(self._call("DELETE", "/alerts/" + created["id"])[0], 204)
        self.assertEqual(self._call("GET", "/alerts/" + created["id"])[0], 404)
        self.assertEqual(self._call("GET", "/alerts")[2]["subscriptions"], [])

    def test_validation_and_limits(self):
        cases = [
            ({"url": "http://hooks.example.com/x", "hosts": [HOST]}, "url_not_public_https"),
            ({"url": "https://402signal.com/route", "hosts": [HOST]}, "url_not_public_https"),
            ({"url": HOOK}, "hosts_required"),
            ({"url": HOOK, "hosts": ["not a host"]}, "invalid_host"),
            ({"url": HOOK, "hosts": ["h%d.example" % i for i in range(alerts.MAX_HOSTS + 1)]}, "too_many_hosts"),
            ({"url": HOOK, "hosts": [HOST], "events": ["bogus"]}, "invalid_events"),
        ]
        for body, error in cases:
            status, _, out = self._call("POST", "/alerts", body)
            self.assertEqual((status, out["error"]), (400, error), body)
        with patch.object(alerts, "_target_ok", lambda url: False):
            status, _, out = self._call("POST", "/alerts", {"url": "https://10.0.0.8/hook", "hosts": [HOST]})
            self.assertEqual((status, out["error"]), (400, "url_not_public_https"))
        for _ in range(alerts.MAX_SUBSCRIPTIONS):
            self._create()
        status, _, out = self._call("POST", "/alerts", {"url": HOOK, "hosts": [HOST]})
        self.assertEqual((status, out["error"]), (409, "too_many_subscriptions"))

    def test_scan_delivers_each_change_once_with_a_valid_signature(self):
        t0 = int(time.time()) - 500
        history.record_probe(URL, _snap(True, PAYTO_A, ts=t0))
        created = self._create()
        secret = created["signing_secret"]
        self.assertEqual(alerts.scan(now=int(time.time()) + 5), 0)
        self.assertEqual(self.sent, [])
        t1 = int(time.time()) + 100
        history.record_probe(URL, _snap(True, PAYTO_B, amount="20000", ts=t1))
        history.record_probe(URL, _snap(False, ts=t1 + 1))
        self.assertEqual(alerts.scan(now=t1 + 10), 1)
        self.assertEqual(len(self.sent), 1)
        url, body, headers = self.sent[0]
        self.assertEqual(url, HOOK)
        self.assertEqual(headers["X-402Signal-Event"], "402signal.alerts")
        self.assertTrue(alerts.verify_signature(secret, headers["X-402Signal-Signature"], body))
        self.assertFalse(alerts.verify_signature("whsec_wrong", headers["X-402Signal-Signature"], body))
        payload = json.loads(body)
        self.assertEqual(payload["subscription_id"], created["id"])
        self.assertEqual(headers["X-402Signal-Delivery"], payload["delivery_id"])
        by_event = {e["event"]: e for e in payload["events"]}
        self.assertEqual(set(by_event), {"price_changed", "recipient_changed", "liveness_changed"})
        self.assertEqual(by_event["price_changed"]["amount_atomic"], "20000")
        self.assertEqual((by_event["recipient_changed"]["payTo"], by_event["recipient_changed"]["observed_payTo"]), (PAYTO_A, PAYTO_B))
        self.assertEqual((by_event["liveness_changed"]["live"], by_event["liveness_changed"]["miss_reason"]), (False, "timeout"))
        for event in payload["events"]:
            self.assertEqual((event["host"], event["url"], event["endpoint_page"]), (HOST, URL, "https://402signal.com/endpoints/" + HOST))
        self.assertEqual(alerts.scan(now=t1 + 20), 0)
        self.assertEqual(len(self.sent), 1)
        detail = self._call("GET", "/alerts/" + created["id"])[2]
        self.assertEqual((detail["last_status"], detail["consecutive_failures"], len(detail["deliveries"])), (200, 0, 1))
        self.assertEqual((detail["deliveries"][0]["kind"], detail["deliveries"][0]["events"]), ("alerts", 3))
        # Coming back up is a liveness change too; price and recipient clocks are silent.
        history.record_probe(URL, _snap(True, PAYTO_B, amount="20000", ts=t1 + 30))
        self.assertEqual(alerts.scan(now=t1 + 40), 1)
        self.assertEqual([e["event"] for e in json.loads(self.sent[1][1])["events"]], ["liveness_changed"])

    def test_more_changes_than_one_batch_are_all_delivered_across_scans(self):
        """Security review F1: the 201st change used to be skipped for good."""
        t0 = int(time.time()) - 3600
        urls = ["https://%s/api/q%03d" % (HOST, i) for i in range(alerts.MAX_EVENTS_PER_DELIVERY + 1)]
        for i, url in enumerate(urls):
            history.record_probe(url, _snap(True, PAYTO_A, ts=t0 + i))
        self._create(events=["price"])
        self.assertEqual(alerts.scan(now=t0 + 400), 0)
        for i, url in enumerate(urls):
            history.record_probe(url, _snap(True, PAYTO_A, amount="20000", ts=t0 + 1000 + i))
        self.assertEqual(alerts.scan(now=t0 + 2000), 1)
        first = json.loads(self.sent[-1][1])["events"]
        self.assertEqual(len(first), alerts.MAX_EVENTS_PER_DELIVERY)
        self.assertEqual(alerts.scan(now=t0 + 2010), 1)
        second = json.loads(self.sent[-1][1])["events"]
        delivered = {e["url"] for e in first} | {e["url"] for e in second}
        self.assertEqual(delivered, set(urls))
        self.assertIn(urls[-1], {e["url"] for e in second})
        self.assertNotIn("_ts", first[0])
        self.assertEqual(alerts.scan(now=t0 + 2020), 0)

    def _tied_price_changes(self, n, ts):
        urls = ["https://%s/api/tie%03d" % (HOST, i) for i in range(n)]
        for url in urls:
            history.record_probe(url, _snap(True, PAYTO_A, ts=ts - 1000))
        self._create(events=["price"])
        self.assertEqual(alerts.scan(now=ts - 600), 0)
        for url in urls:
            history.record_probe(url, _snap(True, PAYTO_A, amount="20000", ts=ts))
        return urls

    def _delivered_urls(self, index=None):
        bodies = self.sent if index is None else [self.sent[index]]
        return [e["url"] for _url, body, _headers in bodies for e in json.loads(body)["events"]]

    def test_changes_stamped_in_one_second_all_go_out_without_repeats(self):
        """Security review F1 refresh: a batch cut inside one second used to resend the same 200 for good."""
        t0 = int(time.time()) - 3600
        n = 2 * alerts.MAX_EVENTS_PER_DELIVERY + 1
        urls = self._tied_price_changes(n, t0)
        sizes = []
        for step in range(4):
            if step == 1:
                session.forget_store()  # a writer restart between scans: the marker lives in the store
            if alerts.scan(now=t0 + 1000 + 10 * step):
                sizes.append(len(self._delivered_urls(-1)))
        self.assertEqual(sizes, [alerts.MAX_EVENTS_PER_DELIVERY, alerts.MAX_EVENTS_PER_DELIVERY, 1])
        delivered = self._delivered_urls()
        self.assertEqual(len(delivered), n)
        self.assertEqual(set(delivered), set(urls))
        # Once the whole second went out the marker is dropped with the advancing cursor.
        row = session.store().alert_sub_get(json.loads(self.sent[-1][1])["subscription_id"], hashlib.sha256(KEY_ONE.encode()).hexdigest())
        self.assertNotIn(alerts.SENT_KEY, json.loads(row[8]))

    def test_a_failed_tied_batch_is_repeated_then_the_rest_follow(self):
        t0 = int(time.time()) - 3600
        urls = self._tied_price_changes(alerts.MAX_EVENTS_PER_DELIVERY + 1, t0)
        self.post_fails = True
        self.assertEqual(alerts.scan(now=t0 + 1000), 1)
        failed = set(self._delivered_urls(-1))
        self.assertEqual(len(failed), alerts.MAX_EVENTS_PER_DELIVERY)
        self.post_fails = False
        retry_at = t0 + 1000 + alerts.BACKOFF_BASE_S + 1
        self.assertEqual(alerts.scan(now=retry_at), 1)
        self.assertEqual(set(self._delivered_urls(-1)), failed)
        self.assertEqual(alerts.scan(now=retry_at + 10), 1)
        self.assertEqual(set(self._delivered_urls(-1)), set(urls) - failed)
        self.assertEqual(alerts.scan(now=retry_at + 20), 0)

    def test_a_cut_liveness_transition_is_kept_for_the_next_batch(self):
        t0 = int(time.time()) - 3600
        price_urls = ["https://%s/api/p%03d" % (HOST, i) for i in range(alerts.MAX_EVENTS_PER_DELIVERY)]
        down = "https://%s/api/goes-down" % HOST
        for i, url in enumerate(price_urls):
            history.record_probe(url, _snap(True, PAYTO_A, ts=t0 + i))
        history.record_probe(down, _snap(True, PAYTO_A, ts=t0))
        self._create(events=["price", "liveness"])
        self.assertEqual(alerts.scan(now=t0 + 400), 0)
        for i, url in enumerate(price_urls):
            history.record_probe(url, _snap(True, PAYTO_A, amount="20000", ts=t0 + 1000 + i))
        history.record_probe(down, _snap(False, ts=t0 + 1500))
        self.assertEqual(alerts.scan(now=t0 + 2000), 1)
        first = json.loads(self.sent[-1][1])["events"]
        self.assertEqual({e["event"] for e in first}, {"price_changed"})
        self.assertEqual(alerts.scan(now=t0 + 2010), 1)
        second = json.loads(self.sent[-1][1])["events"]
        self.assertIn(("liveness_changed", down, False), {(e["event"], e["url"], e.get("live")) for e in second})
        self.assertEqual(alerts.scan(now=t0 + 2020), 0)

    def test_each_scan_delivers_to_a_bounded_number_of_subscriptions(self):
        t0 = int(time.time()) - 3600
        history.record_probe(URL, _snap(True, PAYTO_A, ts=t0))
        self._create(events=["price"])
        self._create(events=["price"], url=HOOK + "/second")
        self.assertEqual(alerts.scan(now=t0 + 5), 0)
        history.record_probe(URL, _snap(True, PAYTO_A, amount="20000", ts=t0 + 10))
        with patch.object(alerts, "MAX_DELIVERIES_PER_SCAN", 1):
            self.assertEqual(alerts.scan(now=t0 + 20), 1)
            self.assertEqual(alerts.scan(now=t0 + 30), 1)
            self.assertEqual(alerts.scan(now=t0 + 40), 0)
        self.assertEqual({u for u, _b, _h in self.sent}, {HOOK, HOOK + "/second"})

    def test_events_filter_and_unrelated_hosts_stay_silent(self):
        t0 = int(time.time()) - 500
        other = "https://other-seller.example/api/x"
        history.record_probe(URL, _snap(True, PAYTO_A, ts=t0))
        history.record_probe(other, _snap(True, PAYTO_A, ts=t0))
        self._create(events=["price"])
        t1 = int(time.time()) + 100
        history.record_probe(URL, _snap(False, ts=t1))
        history.record_probe(other, _snap(True, PAYTO_B, amount="90000", ts=t1))
        self.assertEqual(alerts.scan(now=t1 + 5), 0)
        history.record_probe(URL, _snap(True, PAYTO_A, amount="30000", ts=t1 + 10))
        self.assertEqual(alerts.scan(now=t1 + 15), 1)
        events = json.loads(self.sent[0][1])["events"]
        self.assertEqual([(e["event"], e["url"]) for e in events], [("price_changed", URL)])

    def test_failure_backs_off_disables_and_a_successful_ping_reenables(self):
        t0 = int(time.time()) - 500
        history.record_probe(URL, _snap(True, PAYTO_A, ts=t0))
        created = self._create()
        t1 = int(time.time()) + 100
        history.record_probe(URL, _snap(True, PAYTO_A, amount="20000", ts=t1))
        self.post_fails =True
        self.assertEqual(alerts.scan(now=t1 + 5), 1)
        detail = self._call("GET", "/alerts/" + created["id"])[2]
        self.assertEqual((detail["consecutive_failures"], detail["active"]), (1, True))
        self.assertIn("next_attempt_at", detail)
        self.assertEqual(detail["deliveries"][0]["error"], "OSError")
        self.assertEqual(alerts.scan(now=t1 + 6), 0)
        clock = t1 + 10
        for _ in range(alerts.MAX_FAILURES - 1):
            clock += alerts.BACKOFF_MAX_S + 1
            self.assertEqual(alerts.scan(now=clock), 1)
        detail = self._call("GET", "/alerts/" + created["id"])[2]
        self.assertEqual((detail["active"], detail["disabled"]["reason"], detail["consecutive_failures"]), (False, "delivery_failed", alerts.MAX_FAILURES))
        self.assertEqual(alerts.scan(now=clock + alerts.BACKOFF_MAX_S + 1), 0)
        self.post_fails =False
        status, _, out = self._call("POST", "/alerts/%s/test" % created["id"])
        self.assertEqual((status, out["delivered"], out["status"], out["active"]), (200, True, 200, True))
        self.assertEqual(self.sent[-1][2]["X-402Signal-Event"], "402signal.ping")
        self.assertTrue(alerts.verify_signature(created["signing_secret"], self.sent[-1][2]["X-402Signal-Signature"], self.sent[-1][1]))
        detail = self._call("GET", "/alerts/" + created["id"])[2]
        self.assertEqual((detail["active"], detail["consecutive_failures"]), (True, 0))
        # The undelivered change is still owed: the cursor never advanced on failure.
        before = len(self.sent)
        self.assertEqual(alerts.scan(now=clock + 2 * alerts.BACKOFF_MAX_S), 1)
        self.assertEqual([e["event"] for e in json.loads(self.sent[before][1])["events"]], ["price_changed"])

    def test_non_2xx_counts_as_failure(self):
        t0 = int(time.time()) - 500
        history.record_probe(URL, _snap(True, PAYTO_A, ts=t0))
        created = self._create()
        self.status = 500
        status, _, out = self._call("POST", "/alerts/%s/test" % created["id"])
        self.assertEqual((status, out["delivered"], out["status"]), (200, False, 500))
        self.assertEqual(self._call("GET", "/alerts/" + created["id"])[2]["consecutive_failures"], 1)

    def test_verify_signature_rejects_skew_and_tampering(self):
        body = b'{"a":1}'
        header = alerts.sign("whsec_x", 1_700_000_000, body)
        self.assertTrue(alerts.verify_signature("whsec_x", header, body, now=1_700_000_100))
        self.assertFalse(alerts.verify_signature("whsec_x", header, body, now=1_700_000_100 + 3600))
        self.assertFalse(alerts.verify_signature("whsec_x", header, b'{"a":2}', now=1_700_000_100))
        self.assertFalse(alerts.verify_signature("whsec_x", "t=abc,v1=00", body, now=1_700_000_100))
        self.assertFalse(alerts.verify_signature("whsec_x", "", body, now=1_700_000_100))

    def test_scan_is_a_writer_maintenance_job(self):
        self.assertIn(("alerts_scan", 120.0), maintenance.JOBS)
        self.assertIs(maintenance._JOB_FUNCS["alerts_scan"], maintenance._alerts_scan)


if __name__ == "__main__":
    unittest.main()
