"""Hosted /route traffic class: public clocks stay organic-only."""

from __future__ import annotations

import os
import tempfile
import time
import unittest
from unittest.mock import patch

os.environ.setdefault("LIVE402_FIXTURE", "1")

from live402 import history, lab_traffic, payment, probe, reputation, validate


VALID = "0xabcabcabcabcabcabcabcabcabcabcabcabcabca"
OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"


def _envelope(pay_to=VALID, amount="10000"):
    return {
        "x402Version": 2,
        "accepts": [
            {
                "scheme": "exact",
                "network": payment.BASE_CAIP2,
                "asset": payment.USDC_BASE,
                "amount": amount,
                "payTo": pay_to,
                "maxTimeoutSeconds": 60,
            }
        ],
    }


def _snap(url, *, traffic=history.TRAFFIC_ORGANIC, live=True, pay_to=VALID, **extra):
    ts = extra.pop("ts", int(time.time()))
    row = {
        "url": url,
        "live": bool(live),
        "status": 402 if live else None,
        "latency_ms": extra.pop("latency_ms", 10),
        "payTo": pay_to if live else None,
        "ts": ts,
        "rail": "base",
        "amount": extra.pop("amount", "10000"),
        "asset": payment.USDC_BASE,
        "envelope": _envelope(pay_to if live else VALID),
        "_route_traffic_class": traffic,
    }
    row.update(extra)
    return row


class TrafficClassTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self._prev = os.environ.get("LIVE402_HISTORY_DB")
        os.environ["LIVE402_HISTORY_DB"] = os.path.join(self.tmp.name, "hist.sqlite")
        os.environ.pop("LIVE402_ROUTE_TRAFFIC_CLASS", None)
        history.reset()
        self.addCleanup(history.reset)

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("LIVE402_HISTORY_DB", None)
        else:
            os.environ["LIVE402_HISTORY_DB"] = self._prev

    def test_unknown_defaults_to_unclassified_not_organic(self):
        url = "https://ordinary.example/api"
        self.assertEqual(history.classify_traffic_class(url, {"traffic_class": "organic"}), "unclassified")
        history.record_probe(url, _snap(url, traffic=history.TRAFFIC_UNCLASSIFIED))
        stored = history._connect().execute("SELECT traffic_class FROM probes").fetchone()[0]
        self.assertEqual(stored, "unclassified")
        self.assertEqual(history.summary(url)["n_7d"], 0)
        self.assertIsNone(history.summary(url).get("last_success_402"))

    def test_caller_labels_cannot_select_class(self):
        url = "https://ordinary.example/paid"
        history.record_probe(
            url,
            _snap(url, traffic=history.TRAFFIC_UNCLASSIFIED, traffic_class="organic", lab_testing=lab_traffic.classification()),
        )
        self.assertEqual(
            history._connect().execute("SELECT traffic_class FROM probes").fetchone()[0],
            "unclassified",
        )

    def test_sponsored_internal_unclassified_do_not_move_public_clocks(self):
        url = "https://seller.example/wx"
        t0 = int(time.time()) - 30
        history.record_probe(url, _snap(url, traffic=history.TRAFFIC_ORGANIC, ts=t0))
        first = history.summary(url)
        self.assertEqual(first["n_7d"], 1)
        self.assertIsNotNone(first.get("last_success_402"))
        last_ok = first["last_success_402"]
        last_checked = first["last_checked"]
        for cls in (history.TRAFFIC_SPONSORED, history.TRAFFIC_INTERNAL, history.TRAFFIC_UNCLASSIFIED):
            history.record_probe(
                url,
                _snap(url, traffic=cls, pay_to=OTHER, ts=t0 + 10),
            )
        after = history.summary(url)
        self.assertEqual(after["n_7d"], 1)
        self.assertEqual(after["last_success_402"], last_ok)
        self.assertEqual(after["last_checked"], last_checked)
        self.assertEqual(after["last_payTo"], VALID)
        hints = history.rank_hints([url])
        self.assertEqual(hints[url]["n_7d"], 1)
        ev = history.reputation_evidence(url)
        self.assertEqual(ev["n_7d"], 1)
        self.assertEqual(ev["scoring_probe_count_7d"], 1)
        pulse = history.pulse_observed()
        self.assertEqual(int(pulse.get("n_7d") or 0), 1)

    def test_organic_settled_route_moves_last_success(self):
        url = "https://seller.example/route"
        t0 = int(time.time()) - 20
        bid = "a" * 32
        later = _snap(url, traffic=history.TRAFFIC_ORGANIC, ts=t0, batch_id=bid)
        history.persist_route_batch(bid, [later])
        self.assertIsNone(history.summary(url).get("last_success_402"))
        history.mark_batch_settled(bid)
        summ = history.summary(url)
        self.assertEqual(summ["n_7d"], 1)
        self.assertEqual(summ["last_success_402"], t0)

    def test_sponsored_settled_route_does_not_move_last_success(self):
        url = "https://seller.example/trial"
        t0 = int(time.time()) - 20
        bid = "b" * 32
        later = _snap(url, traffic=history.TRAFFIC_SPONSORED, ts=t0, batch_id=bid)
        history.persist_route_batch(bid, [later])
        history.mark_batch_settled(bid)
        summ = history.summary(url)
        self.assertEqual(summ["n_7d"], 0)
        self.assertIsNone(summ.get("last_success_402"))
        stored = history._connect().execute("SELECT traffic_class FROM probes").fetchone()[0]
        self.assertEqual(stored, "sponsored")

    def test_lab_url_is_self_test_even_when_stamped_organic(self):
        url = "https://lab.example/api"
        with patch.dict(os.environ, {"LIVE402_LAB_ORIGINS": "https://lab.example"}):
            history.reset()
            history.record_probe(url, _snap(url, traffic=history.TRAFFIC_ORGANIC))
            self.assertEqual(
                history._connect().execute("SELECT traffic_class FROM probes").fetchone()[0],
                "self_test",
            )
            self.assertEqual(history.summary(url)["n_7d"], 0)
            self.assertEqual(history.reputation_evidence(url)["self_test_count_7d"], 1)

    def test_env_default_is_server_side_only(self):
        url = "https://ordinary.example/env"
        from live402 import reqctx

        token = reqctx.traffic_class.set("")
        try:
            with patch.dict(os.environ, {"LIVE402_ROUTE_TRAFFIC_CLASS": "organic"}):
                history.record_probe(
                    url,
                    {
                        "live": True,
                        "status": 402,
                        "payTo": VALID,
                        "rail": "base",
                        "envelope": _envelope(),
                        "url": url,
                    },
                )
            stored = history._connect().execute("SELECT traffic_class FROM probes").fetchone()[0]
            self.assertEqual(stored, "organic")
            self.assertEqual(history.summary(url)["n_7d"], 1)
            with patch.dict(os.environ, {"LIVE402_ROUTE_TRAFFIC_CLASS": "bogus"}):
                self.assertEqual(history.route_traffic_from_env(), "unclassified")
        finally:
            reqctx.traffic_class.reset(token)

    def test_read_time_extras(self):
        url = "https://seller.example/ages"
        t0 = int(time.time()) - 40
        history.record_probe(url, _snap(url, traffic=history.TRAFFIC_ORGANIC, ts=t0))
        history.record_probe(url, _snap(url, traffic=history.TRAFFIC_ORGANIC, pay_to=OTHER, ts=t0 + 10))
        attached = history.attach_to_result({"url": url, "live": True, "payTo": OTHER, "rail": "base", "probed_at": probe.now_iso()})
        self.assertIsInstance(attached.get("payTo_age_s"), int)
        self.assertGreaterEqual(attached["payTo_age_s"], 0)
        self.assertIsInstance(attached.get("observed_age_s"), int)
        self.assertIn("claimed_payTo_match", attached)

    def test_validate_unlisted_miss_reason(self):
        with patch("live402.validate.catalog_item_for", return_value=None), patch(
            "live402.validate.fixtures.fixture_mode", return_value=False
        ), patch("live402.probe.probe_url") as probed:
            code, body = validate.validate_url("https://evil.example/x402")
        self.assertEqual(code, 200)
        self.assertEqual(body.get("miss_reason"), "unlisted")
        probed.assert_not_called()

    def test_validate_does_not_write_observed_but_may_touch_clocks(self):
        url = "https://fixture.402signal.local/weather"
        history.reset()
        before = history.summary(url).get("last_checked")
        code, body = validate.validate_url(url)
        self.assertEqual(code, 200)
        pulse = history.pulse_observed()
        self.assertEqual(int(pulse.get("n_7d") or 0), 0)
        self.assertEqual(history.summary(url)["n_7d"], 0)
        self.assertIsNone(history.summary(url).get("last_success_402"))
        self.assertNotEqual(history.summary(url).get("last_checked"), before)
        self.assertIn("observed_age_s", body)

    def test_scoring_excludes_non_organic(self):
        url = "https://seller.example/score"
        for cls in (history.TRAFFIC_SPONSORED, history.TRAFFIC_INTERNAL, history.TRAFFIC_UNCLASSIFIED):
            history.record_probe(url, _snap(url, traffic=cls))
        spec = reputation.model_spec()
        self.assertEqual(spec["model_id"], "reputation-v2")
        self.assertIn("organic", spec["traffic_policy"])
        ev = history.reputation_evidence(url)
        self.assertEqual(ev["scoring_probe_count_7d"], 0)
        self.assertEqual(ev["n_7d"], 0)


if __name__ == "__main__":
    unittest.main()
