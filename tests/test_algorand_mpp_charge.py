"""Native MPP charge parsing/fee model parity using actual SDK public vectors."""
import copy,json,os,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
from live402 import batch_binding as bb,route_binding as rb,route,replay,schema_http,mcp
from live402.batch_profiles import algorand_charge as ac
from live402.pq import receipt,store
import test_batch_binding as old
from test_success_only_billing import RESOURCE,_headers,_payload,_verified,_settled
VECTORS=json.loads((Path(__file__).parent/"fixtures/algorand-mpp-charge.json").read_text())
def observation(v, now=None): return {"request":rb.request_context(v["request"]["url"],"GET"),"observed_at":v["now"] if now is None else now,"challenge":v["challenge"]}
class AlgorandMppTests(unittest.TestCase):
    def test_actual_sdk_quote_and_exact_unsigned_size_parity(self):
        for v in VECTORS:
            b=bb.build(v["request"],observation(v))
            self.assertEqual(b["terms"],v["expectedTerms"])
            self.assertEqual(ac.fee_model(v["offer"])[1],v["unsignedSizes"])
            self.assertEqual(b["expires_at"],v["now"]+60)
            self.assertEqual(bb.parse_request(v["request"]),observation(v)["request"])
    def test_lease_network_cap_sponsor_unknown_fields_and_underfunded_fee_rejected(self):
        for v in VECTORS[:2]:
            for mutation in [lambda x:x.update(amount="0"),lambda x:x.update(recipient=v["buyer"]),lambda x:x["methodDetails"].update(lease="AA=="),lambda x:x["methodDetails"].update(network="algorand:testnet"),lambda x:x["methodDetails"].update(feePayer=True),lambda x:x["methodDetails"]["suggestedParams"].update(fee=100),lambda x:x["methodDetails"]["suggestedParams"].update(minFee=True),lambda x:x.update(extra="ignored")]:
                bad=copy.deepcopy(v["offer"]);mutation(bad)
                with self.assertRaises(ValueError): ac.validate(bad,observation(v)["request"],v["request"]["buyer_limits"])
            for change in [{"max_network_fee_micro_algo":"999"},{"max_amount_atomic":"0"},{"fee_payer":False},{"realm":" "}]:
                limits={**v["request"]["buyer_limits"],**change}
                with self.assertRaises(ValueError):ac.validate(v["offer"],observation(v)["request"],limits)
    def test_nullable_fee_payer_schema_and_mcp_separation(self):
        s=schema_http.batch_limit_schemas()[ac.PROFILE]
        self.assertEqual(set(s["required"]),ac.KEYS);self.assertFalse(s["additionalProperties"])
        self.assertEqual(s["properties"]["fee_payer"]["anyOf"][0],{"type":"null"})
        self.assertNotIn("merchant_profile",mcp.INPUT_SCHEMA["properties"])
    def test_native_header_realm_duplicate_and_wrong_intent_refused(self):
        v=VECTORS[0]
        for mutate in [lambda x:x["request"]["buyer_limits"].update(realm="merchant.example"),lambda x:x["challenge"].update(wwwAuthenticate=x["challenge"]["wwwAuthenticate"]+', realm="payments.example"'),lambda x:x["challenge"].update(wwwAuthenticate=x["challenge"]["wwwAuthenticate"].replace('intent="charge"','intent="session"'))]:
            bad=copy.deepcopy(v);mutate(bad)
            with self.assertRaises(ValueError):bb.build(bad["request"],observation(bad))
class NativeChargeBillingTests(unittest.TestCase):
    setUp=old.BatchTests.setUp
    cleanup=old.BatchTests.cleanup
    def test_valid_charge_bills_exact_router_fee_once_and_replays_after_memory_restart(self):
        for source in [VECTORS[0],VECTORS[4]]:
            replay.reset()
            v=copy.deepcopy(source);now=int(time.time());v["now"]=now
            import datetime,re
            expires=datetime.datetime.fromtimestamp(now+60,datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z")
            v["challenge"]["wwwAuthenticate"]=re.sub(r'expires="[^"]+"','expires="'+expires+'"',v["challenge"]["wwwAuthenticate"])
            b=bb.build(v["request"],observation(v));result={"url":v["request"]["url"],"merchant_profile":ac.PROFILE,"live":True,"payable":True,"invocable":False,"status":402,"selected_payment":None,"batch_terms":b["terms"],"_batch_observation":observation(v)}
            with patch.dict(os.environ,{"BATCH_OBSERVATION_PROFILES":ac.PROFILE}),patch("live402.route.run_probe",return_value=(200,result)),patch("live402.facilitator.verify",return_value=_verified())as verify,patch("live402.facilitator.settle",return_value=_settled())as settle:
                out=route.handle_route(v["request"],_headers(_payload()),RESOURCE);self.assertEqual(out[1]["billing"]["amount_atomic"],"3000");self.assertTrue(out[1]["billing"]["settled"],out);replay.reset_memory();self.assertEqual(route.handle_route(v["request"],_headers(_payload()),RESOURCE),out);self.assertEqual((verify.call_count,settle.call_count),(1,1))
