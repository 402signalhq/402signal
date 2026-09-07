#!/usr/bin/env python3
"""Synthetic example proof; public test key and no network or wallet payments."""
import json, os, sys, tempfile
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[4]
sys.path.insert(0,str(ROOT))
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from live402 import payment,route_binding as rb
from live402.pq import receipt,store

URL="https://api.agentstools.dev/search?query=x402%20payment%20protocol&max_results=5"
NOW=1788566402
def generate():
    request={"url":URL,"need":"web search","networks":["base"],"max_price_usd":0.001,"require_route_binding":True}
    acc={"scheme":"exact","network":"eip155:8453","asset":payment.USDC_BASE,"amount":"1000","payTo":"0x"+"11"*20,"maxTimeoutSeconds":300,"extra":{"name":"USD Coin","version":"2"}}
    env={"x402Version":2,"error":"Synthetic test challenge", "resource":{"url":URL.split("?")[0],"serviceName":"web-search","tags":["web","search","web-search","serp","results","grounding","research","real-time","multi-engine","agents"]},"accepts":[acc],"extensions":{"bazaar":{}}}
    with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{"LIVE402_FIXTURE":"1","LIVE402_PQ_LOG":"1","LIVE402_PQ_LOG_DB":tmp+"/log.sqlite","LIVE402_ROUTE_BINDING_TTL_S":"60"}):
        store.reset();vkey=receipt.configure_signer(Ed25519PrivateKey.from_private_bytes(bytes(range(32))))
        try:
            result={"url":URL,"live":True,"payable":True,"invocable":True,"status":402,"payTo":acc["payTo"],"envelope":env,"selected_payment":payment.selected_payment_fields(payment.validate_observed_accept(acc,env)),"probed_at":"2026-09-05T00:00:00Z","latency_ms":12,"applied_constraints":{"networks":["base"],"max_price_usd":0.001},"binding_observation":{"request":rb.request_context(URL,"GET"),"observed_at":NOW-2,"quote_sha256":rb.digest(env)}}
            result["decision_binding"]=rb.build(result,request,now=NOW-1)
            with patch("live402.pq.route_v4.secrets.token_bytes",return_value=bytes(32)),patch("live402.pq.route_v4.secrets.token_hex",return_value="02"*32),patch("live402.pq.jcs.utc_minutes_z",return_value="2026-09-05T00:00:00Z"):
                result=receipt.attach_to_route(result,request)
            result.pop("binding_observation")
            result["billing"]={"model":"success_only_v1","condition":"live_eligible_route_found","asset":"USDC","amount_atomic":"3000","display_amount":"$0.003","rail":"base","settlement_state":"settled","settlement_attempted":True,"settled":True}
            rb.verify_route(result,request,vkey=vkey,status=402,envelope=env,url=URL,method="GET",now=NOW)
            return {"synthetic_test_proof":True,"not_a_production_route":True,"no_wallet_payment":True,"query":"x402 payment protocol","url":URL,"request":request,"response":result,"challenge":env,"trusted_vkey":vkey,"now":NOW}
        finally: receipt.configure_signer(None);store.reset()
if __name__ == "__main__":
    out=Path(__file__).with_name("search-example-fixture.json")
    out.write_text(json.dumps(generate(),indent=2)+"\n")
    print(out)
