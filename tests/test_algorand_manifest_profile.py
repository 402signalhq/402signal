"""New profiles: synthetic quote/proof parity and existing routing economics."""
import base64, copy, hashlib, json, os, tempfile, time, unittest
from pathlib import Path
from unittest.mock import patch
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from live402 import batch_binding as bb, route_binding as rb, route, replay
from live402.batch_profiles import algorand_manifest as profile, algorand_generic
from live402.pq import receipt, store
import test_batch_binding as old_batch
from test_success_only_billing import RESOURCE, _headers, _payload, _verified, _settled

BASE = json.loads((Path(__file__).parent / "fixtures/algorand-generic-v5.json").read_text())
NOW = 1800000000


def vector(kind=profile.ATOMIC, count=3, now=NOW):
    limits = copy.deepcopy(BASE["request"]["buyer_limits"])
    limits["job_hashes"] = [hashlib.sha256(f"job-{i}".encode()).hexdigest() for i in range(count)]
    payments = count if kind == profile.ATOMIC else 1
    amount = "1000" if kind == profile.ATOMIC else "2500"
    limits["max_total_amount_atomic"] = str(int(amount) * payments)
    limits["max_sponsor_fee_micro_algo"] = str((payments + 1) * 1000)
    if kind == profile.ATOMIC:
        limits["max_item_amount_atomic"] = amount
    else:
        limits.pop("max_item_amount_atomic")
    request = {"url": "https://merchant.example/v2/jobs?invoice=example&order=original", "merchant_profile": kind, "buyer_limits": limits, "require_route_binding": True}
    context = rb.request_context(request["url"], "GET")
    quote = {"network": profile.NETWORK, "genesisHash": profile.GENESIS, "genesisId": "mainnet-v1.0", "transactionCount": payments + 1, "firstValid": "1001", "lastValid": "1101", "minFeeMicroAlgo": "1000", "feePerByteMicroAlgo": "0", "sponsorFeeMicroAlgo": str((payments + 1) * 1000), "observedAt": now, "expiresAt": now + 45}
    manifest = {"version": 2, "profile": kind, "network": profile.NETWORK, "asset": profile.ASSET, "recipient": limits["recipient"], "resource": request["url"], "requestHash": rb.digest(context), "jobCount": count, "paymentCount": payments, "paymentAmount": amount, "perJobAmount": amount if kind == profile.ATOMIC else None, "totalAmount": limits["max_total_amount_atomic"], "paymentIndices": list(range(1, payments + 1)), "sponsorIndex": 0, "feePayer": limits["fee_payer"], "jobHashes": limits["job_hashes"], "feeQuote": quote}
    envelope = {"x402Version": 2, "resource": {"url": request["url"], "mimeType": "application/json"}, "accepts": [{"scheme": "exact", "network": profile.NETWORK, "asset": profile.ASSET, "amount": amount, "payTo": limits["recipient"], "maxTimeoutSeconds": 60, "extra": {"feePayer": limits["fee_payer"]}}], "extensions": {profile.EXTENSION: manifest}}
    # Header-only offers avoid duplicating the same bounded manifest in a v5 proof.
    challenge = {"status": 402, "bodyText": "", "paymentRequired": base64.b64encode(rb.canonical(envelope)).decode(), "wwwAuthenticate": None}
    return {"request": request, "envelope": envelope, "challenge": challenge, "observation": {"request": context, "observed_at": now, "challenge": challenge}, "now": now}


def rebuilt(v):
    v = copy.deepcopy(v)
    v["challenge"]["paymentRequired"] = base64.b64encode(rb.canonical(v["envelope"])).decode()
    v["observation"]["challenge"] = v["challenge"]
    return bb.build(v["request"], v["observation"])


class AlgorandManifestTests(unittest.TestCase):
    def test_boundary_counts_independent_economics_and_quote_expiry(self):
        for kind, counts in ((profile.ATOMIC, (2, 3, 14, 15)), (profile.INVOICE, (2, 15, 64))):
            for count in counts:
                v = vector(kind, count)
                b = rebuilt(v)
                self.assertEqual(b["terms"]["jobCount"], count)
                self.assertEqual(b["terms"]["paymentCount"], count if kind == profile.ATOMIC else 1)
                self.assertEqual(b["terms"]["perJobAmount"], "1000" if kind == profile.ATOMIC else None)
                self.assertEqual(b["expires_at"], NOW + 45)
                bb.validate(b, v["request"], now=NOW + 44)
                with self.assertRaises(ValueError):
                    bb.validate(b, v["request"], now=NOW + 45)
        for kind, counts in ((profile.ATOMIC, (0, 1, 16)), (profile.INVOICE, (0, 1, 65))):
            for count in counts:
                with self.assertRaises(ValueError):
                    rebuilt(vector(kind, count))

    def test_manifest_and_quote_tampering_refused(self):
        for kind in profile.PROFILES:
            original = vector(kind)
            for key, value in (("version", 1), ("jobCount", 2), ("paymentCount", 2), ("paymentIndices", [2, 1]), ("totalAmount", "1"), ("perJobAmount", "17"), ("requestHash", "0" * 64), ("jobHashes", list(reversed(original["request"]["buyer_limits"]["job_hashes"]))), ("recipient", original["request"]["buyer_limits"]["fee_payer"])):
                v = copy.deepcopy(original)
                v["envelope"]["extensions"][profile.EXTENSION][key] = value
                with self.subTest(kind=kind, field=key), self.assertRaises(ValueError):
                    rebuilt(v)
            for key, value in (("network", "algorand:testnet"), ("transactionCount", 16), ("minFeeMicroAlgo", "999"), ("feePerByteMicroAlgo", "1"), ("sponsorFeeMicroAlgo", "15000"), ("expiresAt", NOW + 61), ("observedAt", NOW + 1), ("firstValid", "0"), ("lastValid", "5000")):
                v = copy.deepcopy(original)
                v["envelope"]["extensions"][profile.EXTENSION]["feeQuote"][key] = value
                with self.subTest(kind=kind, quote=key), self.assertRaises(ValueError):
                    rebuilt(v)

    def test_old_profile_and_aggregate_no_inferred_item_cap(self):
        v = vector(profile.INVOICE, 3)
        v["request"]["buyer_limits"]["max_item_amount_atomic"] = "1000"
        with self.assertRaises(ValueError):
            rebuilt(v)
        v = vector(profile.ATOMIC, 15)
        v["request"]["buyer_limits"]["max_sponsor_fee_micro_algo"] = "15000"
        with self.assertRaises(ValueError):
            rebuilt(v)
        old = BASE
        algorand_generic.validate(json.loads(old["challenge"]["bodyText"]), rb.request_context(old["request"]["url"], "GET"), old["request"]["buyer_limits"])
        with self.assertRaises(ValueError):
            algorand_generic.validate(vector()["envelope"], vector()["observation"]["request"], old["request"]["buyer_limits"])


class AlgorandManifestRouteTests(unittest.TestCase):
    setUp = old_batch.BatchTests.setUp
    cleanup = old_batch.BatchTests.cleanup
    result = old_batch.BatchTests.result
    issue = old_batch.BatchTests.issue

    def test_new_profiles_single_router_fee_and_private_recovery(self):
        for kind in profile.PROFILES:
            replay.reset()
            v = vector(kind, 3, int(time.time()))
            result = self.result(v)
            with patch("live402.route.run_probe", return_value=(200,result)), patch("live402.facilitator.verify",return_value=_verified()) as verify, patch("live402.facilitator.settle",return_value=_settled()) as settle:
                out = route.handle_route(v["request"],_headers(_payload()),RESOURCE)
                self.assertEqual(out[0],200,out)
                self.assertEqual(out[1]["billing"]["amount_atomic"],"3000")
                self.assertTrue(out[1]["billing"]["settled"])
                self.assertEqual((verify.call_count,settle.call_count),(1,1))
                replay.reset_memory()
                self.assertEqual(route.handle_route(v["request"],_headers(_payload()),RESOURCE),out)
                self.assertEqual((verify.call_count,settle.call_count),(1,1))

    def test_stale_quote_or_unknown_item_cap_never_settles(self):
        v=vector(profile.INVOICE,3,int(time.time())-46)
        with patch("live402.route.run_probe",return_value=(200,self.result(v))),patch("live402.facilitator.verify",return_value=_verified()),patch("live402.facilitator.settle")as settle:
            out=route.handle_route(v["request"],_headers(_payload()),RESOURCE)
            self.assertFalse(out[1]["billing"]["settled"])
            settle.assert_not_called()

class ManifestHttpSchemaTests(unittest.TestCase):
    def test_new_http_variants_match_runtime_and_keep_mcp_unchanged(self):
        from live402 import schema_http, schema_fields, mcp
        limits = schema_http.batch_limit_schemas()
        for kind, maximum in [(profile.ATOMIC,15),(profile.INVOICE,64)]:
            definition=limits[kind]
            expected=profile.COMMON_KEYS | ({"max_item_amount_atomic"} if kind==profile.ATOMIC else set())
            self.assertEqual(set(definition["required"]),expected)
            self.assertEqual(set(definition["properties"]),expected)
            self.assertFalse(definition["additionalProperties"])
            self.assertEqual(definition["properties"]["job_hashes"]["maxItems"],maximum)
            for count in [2,maximum]:
                request=vector(kind,count)["request"]
                bb.parse_request(request)
            self.assertEqual(definition["properties"]["max_sponsor_fee_micro_algo"]["pattern"],schema_http.uint64_pattern())
        self.assertEqual(schema_fields.route_body_schema(surface="mcp"),mcp.INPUT_SCHEMA)
        self.assertNotIn("merchant_profile",mcp.INPUT_SCHEMA["properties"])
