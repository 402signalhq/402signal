import json,os,tempfile
from pathlib import Path
from unittest.mock import patch
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from live402.pq import receipt,store
from live402 import batch_binding as bb
from test_algorand_mpp_charge import VECTORS,observation
result=[]
with tempfile.TemporaryDirectory()as tmp,patch.dict(os.environ,{"LIVE402_FIXTURE":"1","LIVE402_PQ_LOG":"1","LIVE402_PQ_LOG_DB":tmp+"/pq.sqlite"}),patch("time.time",return_value=1800000000):
 store.reset();vkey=receipt.configure_signer(Ed25519PrivateKey.generate())
 for v in VECTORS:
  b=bb.build(v["request"],observation(v));out={"url":v["request"]["url"],"merchant_profile":v["request"]["merchant_profile"],"live":True,"payable":True,"invocable":False,"status":402,"selected_payment":None,"batch_terms":b["terms"],"batch_binding":b};out=receipt.attach_to_route(out,v["request"]);assert "pq_trust"in out;result.append({**v,"response":out,"trusted_vkey":vkey})
 receipt.configure_signer(None);store.reset()
Path("tests/fixtures/algorand-mpp-charge-v5.json").write_text(json.dumps(result,indent=2)+"\n")
