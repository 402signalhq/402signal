"""Regenerate public synthetic v5 receipts; no persisted private key or network.
Run from the repository root with PYTHONPATH=.:tests and fixture dependencies.
"""
import json,os,tempfile,time
from pathlib import Path
from unittest.mock import patch
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from live402.pq import receipt,store
from live402 import batch_binding as bb
from test_algorand_manifest_profile import vector,profile,NOW
out=[]
with tempfile.TemporaryDirectory()as tmp,patch.dict(os.environ,{"LIVE402_FIXTURE":"1","LIVE402_PQ_LOG":"1","LIVE402_PQ_LOG_DB":tmp+"/pq.sqlite"}),patch("time.time",return_value=NOW):
 store.reset();vkey=receipt.configure_signer(Ed25519PrivateKey.generate())
 for kind,counts in ((profile.ATOMIC,(2,3,14,15)),(profile.INVOICE,(2,15,64))):
  for n in counts:
   v=vector(kind,n);b=bb.build(v["request"],v["observation"])
   result={"url":v["request"]["url"],"merchant_profile":kind,"live":True,"payable":True,"invocable":False,"status":402,"selected_payment":None,"batch_terms":b["terms"],"batch_binding":b}
   result=receipt.attach_to_route(result,v["request"])
   assert "pq_trust"in result,result
   out.append({"request":v["request"],"challenge":v["challenge"],"response":result,"trusted_vkey":vkey,"now":NOW})
 receipt.configure_signer(None);store.reset()
Path("tests/fixtures/algorand-manifest-v2.json").write_text(json.dumps(out,indent=2)+"\n")
print([(x["response"]["batch_terms"]["jobCount"],len(json.dumps(x["response"],separators=(",",":"))))for x in out])
