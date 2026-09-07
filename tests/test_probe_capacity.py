"""Capacity refusals are not observations or completed negative answers."""
import copy
import os
import tempfile
import unittest
from unittest.mock import patch
from live402 import admission, probe, route, history
import test_route_miss_status as miss_status

class ProbeCapacityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"LIVE402_HISTORY_DB": self.temp.name + "/history.sqlite"})
        self.env.start()
        history.reset()

    def tearDown(self):
        history.reset()
        self.env.stop()
        self.temp.cleanup()

    def routed(self, rows):
        items=[{"resource":r["url"]} for r in rows]
        with patch.object(probe,"fetch_discovery",return_value=items), \
             patch.object(probe,"rank_resources",return_value=items), \
             patch.object(probe,"_history_boost_shortlist",return_value=items), \
             patch("live402.hydrate.hydrate_finalists"), \
             patch.object(probe,"_probe_tranche",return_value=copy.deepcopy(rows)), \
             patch.object(probe,"_commit_route_batch",return_value={}) as commit:
            body=probe.route_need("weather")
        return body,commit.call_args.args[1]

    def denied(self,url="https://example.com/weather"):
        with patch.object(admission,"reserve_probe",side_effect=admission.Unavailable), \
             patch.object(probe,"_probe_url_unbudgeted") as network:
            out=probe.probe_url(url)
        network.assert_not_called()
        return out

    def check_failure(self, body, count):
        self.assertEqual(body["miss_reason"],"probe_capacity")
        self.assertEqual(body["stop_reason"],"probe_capacity")
        self.assertFalse(body["candidate_evaluation_complete"])
        self.assertFalse(body["evaluation_complete"])
        self.assertEqual(body["candidates_probed"],count)
        self.assertEqual(body["tried"],count)
        with patch.object(probe,"route_need",return_value=body):
            code,public=route.run_probe({"need":"weather"})
        self.assertEqual(code,503)
        out=miss_status.MissStatusTests().execute(public)
        self.assertEqual(out[0],503)
        self.assertTrue(out[1]["retryable"])
        self.assertEqual(out[2]["Cache-Control"],"no-store")
        self.assertFalse(out[1]["billing"]["settled"])

    def test_all_refused_remain_retryable_and_unobserved(self):
        body,rows=self.routed([self.denied()])
        self.check_failure(body,0)
        self.assertNotIn("health",body)
        self.assertNotIn("probed_at",body)
        self.assertEqual(body["unprobed_count"],1)
        self.assertEqual(history.persist_route_batch("capacity-all",rows),{})

    def test_partial_refusal_does_not_discard_real_negative(self):
        observed={"url":"https://other.example/weather","live":False,"payable":False,
                  "invocable":False,"miss_reason":"no_402_envelope","status":404,"probes":[]}
        body,rows=self.routed([observed,self.denied()])
        self.check_failure(body,1)
        self.assertEqual(rows[0],observed)
        self.assertEqual(body["status"],404)
        self.assertEqual(body["last"]["url"],observed["url"])
        self.assertEqual(body["unprobed_count"],1)
        metas=history.persist_route_batch("capacity-partial",rows)
        self.assertNotIn("https://example.com/weather",metas)
        self.assertIn(observed["url"],metas)

    def test_direct_refusal_never_fabricates_history(self):
        with patch.object(probe,"direct_url_allowed",return_value=True), \
             patch.object(route,"_lookup_claimed",return_value=None), \
             patch.object(admission,"reserve_probe",side_effect=admission.Unavailable), \
             patch.object(probe,"_probe_url_unbudgeted") as network, \
             patch.object(history,"persist_route_batch") as persist, \
             patch.object(history,"attach_to_result") as attach:
            code,body=route.run_probe({"url":"https://example.com/weather"})
        self.assertEqual(code,503)
        self.check_failure(body,0)
        self.assertNotIn("observed",body)
        network.assert_not_called();persist.assert_not_called();attach.assert_not_called()

    def test_real_completed_miss_preserves_success_classification(self):
        body,_=self.routed([{"url":"https://other.example/weather","live":False,
                            "payable":False,"invocable":False,"miss_reason":"no_402_envelope","probes":[]}])
        self.assertTrue(body["candidate_evaluation_complete"])
        self.assertEqual(body["candidates_probed"],1)
        with patch.object(probe,"route_need",return_value=body):
            code,public=route.run_probe({"need":"weather"})
        self.assertEqual(miss_status.MissStatusTests().execute(public)[0],200)

    def test_capacity_preserves_winner_stop_and_partial_completion(self):
        rows=[self.denied(),{"url":"https://winner.example","live":True}]
        ranked=[{"resource":r["url"]} for r in rows]
        self.assertFalse(probe._candidate_evaluation_complete(ranked,rows))
        self.assertEqual(probe._stop_reason(winner=rows[1],ranked=ranked,probed=rows,
                                          probe_budget_exhausted=False,some_live=True),"winner_selected")
