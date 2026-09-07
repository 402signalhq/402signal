#!/usr/bin/env python3
"""Synthetic GET metadata conformance fixture. PUBLIC TEST KEY; no live I/O."""
import json, os, sys, tempfile
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from live402 import payment, route_binding as rb
from live402.pq import receipt, store

URL = "https://search.example/search?query=x402%20protocol&max_results=5"

def generate():
    key = Ed25519PrivateKey.from_private_bytes(bytes(range(32)))
    with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {
        "LIVE402_FIXTURE": "1", "LIVE402_PQ_LOG": "1",
        "LIVE402_ROUTE_BINDING_TTL_S": "60", "LIVE402_PQ_LOG_DB": tmp + "/log.sqlite",
    }):
        store.reset()
        vkey = receipt.configure_signer(key)
        try:
            acc = next(a for a in payment.payment_required(URL)["accepts"] if payment.rail_of_accept(a) == "base")
            acc = {k:v for k,v in acc.items() if k != "extra"}
            acc["amount"] = "1000"
            env = {"x402Version":2,"accepts":[acc],"resource": {
                "url": URL.split("?")[0], "serviceName":"web-search",
                "tags":["web","search","web-search","serp","results","grounding","research","real-time","multi-engine","agents"],
            }, "extensions":{"bazaar":{}}}
            request = {"need":"web search", "url":URL, "require_route_binding":True}
            result = {"url":URL,"live":True,"payable":True,"invocable":True,"status":402,
                "payTo":acc["payTo"],"envelope":env,
                "selected_payment":payment.selected_payment_fields(payment.validate_observed_accept(acc,env)),
                "probed_at":"2026-09-05T00:00:00Z","latency_ms":12,
                "binding_observation":{"request":rb.request_context(URL,"GET"),
                    "observed_at":1788566400,"quote_sha256":rb.digest(env)}}
            result["decision_binding"] = rb.build(result,request,now=1788566401)
            with patch("live402.pq.route_v4.secrets.token_bytes",return_value=bytes(32)), patch("live402.pq.route_v4.secrets.token_hex",return_value="01"*32), patch("live402.pq.jcs.utc_minutes_z",return_value="2026-09-05T00:00:00Z"):
                result=receipt.attach_to_route(result,request)
            result.pop("binding_observation")
            return {"test_only":True,"trusted_vkey":vkey,"request":request,"response":result,"challenge":env,"now":1788566402}
        finally:
            receipt.configure_signer(None)
            store.reset()

if __name__ == "__main__":
    out=Path(__file__).resolve().parents[1]/"tests/fixtures/route-binding-get.json"
    out.write_text(json.dumps(generate(),indent=2)+"\n")
    print(out)
