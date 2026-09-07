# Synthetic proof only. No network or production keys.
import json,sys,base64,re
from unittest.mock import patch
from pathlib import Path
root=Path(__file__).resolve().parents[3]
sys.path[:0]=[str(root),str(root/'tests')]
from test_batch_binding import BatchTests,vector
from live402 import route_binding as rb
now=1800000000
v=vector(1,now)
# Public deterministic seed-8 test operator, supplied by the actual SDK helper.
operator=sys.argv[1]
v['request']['url']='https://merchant.example/solana/session/sha256'
v['request']['buyer_limits'].update(recipient=operator,operator=operator,max_session_cap_atomic='4000')
h=v['challenge']['wwwAuthenticate'];part=re.search(r'request="([^"]+)"',h).group(1)
a=json.loads(base64.urlsafe_b64decode(part+'='*((-len(part))%4)))
a.update(operator=operator,recipient=operator,cap='4000')
b=base64.urlsafe_b64encode(json.dumps(a,separators=(',',':')).encode()).decode().rstrip('=')
v['challenge']['wwwAuthenticate']=h.replace(part,b)
v['observation']['challenge']=v['challenge'];v['observation']['request']=rb.request_context(v['request']['url'],'GET')
t=BatchTests();t.setUp()
try:
 with patch('time.time',return_value=now):result=t.issue(v)
 result['billing']={'model':'success_only_v1','condition':'live_eligible_route_found','asset':'USDC','amount_atomic':'3000','display_amount':'$0.003','rail':'base','settlement_state':'settled','settlement_attempted':True,'settled':True}
 output={'request':v['request'],'challenge':v['challenge'],'response':result,'trusted_vkey':t.vkey,'now':now}
 output['baseFinality']=[]
 for offset in [0,900]:
  bv=vector(0,now+offset)
  with patch('time.time',return_value=now+offset):br=t.issue(bv)
  br['billing']=result['billing']
  output['baseFinality'].append({'request':bv['request'],'challenge':bv['challenge'],'response':br,'trusted_vkey':t.vkey,'now':now+offset})
 Path(sys.argv[2]).write_text(json.dumps(output,indent=2)+'\n')
finally:t.doCleanups()
