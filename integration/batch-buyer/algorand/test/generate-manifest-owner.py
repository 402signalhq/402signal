import json,os,tempfile,base64,hashlib
from pathlib import Path
from unittest.mock import patch
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from live402.pq import receipt,store
from live402 import batch_binding as bb,route_binding as rb
from test_algorand_manifest_profile import vector,profile,NOW
def address(n):
 p=Ed25519PrivateKey.from_private_bytes(bytes([n])*32).public_key().public_bytes(serialization.Encoding.Raw,serialization.PublicFormat.Raw);return base64.b32encode(p+hashlib.new('sha512_256',p).digest()[-4:]).decode().rstrip('=')
out=[]
with tempfile.TemporaryDirectory()as tmp,patch.dict(os.environ,{'LIVE402_FIXTURE':'1','LIVE402_PQ_LOG':'1','LIVE402_PQ_LOG_DB':tmp+'/pq.sqlite'}),patch('time.time',return_value=NOW):
 store.reset();vkey=receipt.configure_signer(Ed25519PrivateKey.generate())
 for kind in (profile.ATOMIC,profile.INVOICE):
  v=vector(kind,3);l=v['request']['buyer_limits'];l['recipient']=address(2);l['fee_payer']=address(3);l['max_total_amount_atomic']='3000';e=v['envelope'];q=e['accepts'][0];q['payTo']=address(2);q['extra']['feePayer']=address(3);q['amount']='1000'if kind==profile.ATOMIC else'3000';m=e['extensions'][profile.EXTENSION];m.update(recipient=address(2),feePayer=address(3),totalAmount='3000',paymentAmount=q['amount']);v['challenge']['paymentRequired']=base64.b64encode(rb.canonical(e)).decode();b=bb.build(v['request'],v['observation']);result={'url':v['request']['url'],'merchant_profile':kind,'live':True,'payable':True,'invocable':False,'status':402,'selected_payment':None,'batch_terms':b['terms'],'batch_binding':b};result=receipt.attach_to_route(result,v['request']);out.append({'request':v['request'],'challenge':v['challenge'],'response':result,'trusted_vkey':vkey,'now':NOW,'buyer':address(1),'merchant':address(2),'sponsor':address(3)})
 receipt.configure_signer(None);store.reset()
Path('integration/batch-buyer/algorand/test/manifest-owner-fixtures.json').write_text(json.dumps(out,indent=2)+'\n')
