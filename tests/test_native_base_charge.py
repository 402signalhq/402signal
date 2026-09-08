import base64,copy,json,unittest
from pathlib import Path
from live402 import batch_binding as bb
from live402.batch_profiles import base_charge,native_charge
V=json.loads((Path(__file__).parent/'fixtures/base-native-mpp-v5.json').read_text())
class NativeBaseTests(unittest.TestCase):
 def test_actual_mppx_wire_signed_roundtrip(self):
  bb.verify_route(V['response'],V['request'],vkey=V['trusted_vkey'],challenge=V['challenge'],now=V['now'])
 def test_wrong_terms_fail_before_billable(self):
  e,_=bb.wire(V['challenge'],V['observation']['request'],'base-mpp-charge-v1')
  for field,value in [('amount','0'),('amount','01000'),('amount','1001'),('currency','0x'+'2'*40),('recipient','0x'+'2'*40)]:
   b=copy.deepcopy(e);b[field]=value
   with self.subTest(field=field,value=value),self.assertRaises(ValueError):base_charge.validate(b,V['observation']['request'],V['request']['buyer_limits'])
  for field,value in [('chainId',True),('chainId',1),('splits',[]),('permit2Address','0x'+'2'*40),('decimals',False)]:
   b=copy.deepcopy(e);b['methodDetails'][field]=value
   with self.subTest(field=field),self.assertRaises(ValueError):base_charge.validate(b,V['observation']['request'],V['request']['buyer_limits'])
 def test_ambiguous_or_expired_wire_rejects(self):
  for tail in [', id="other"',', Basic realm="other"',', header="Cookie"']:
   c={**V['challenge'],'wwwAuthenticate':V['challenge']['wwwAuthenticate']+tail}
   with self.assertRaises(ValueError):bb.wire(c,V['observation']['request'],'base-mpp-charge-v1')
  with self.assertRaises(ValueError):bb.verify_route(V['response'],V['request'],vkey=V['trusted_vkey'],challenge=V['challenge'],now=V['now']+60)
 def test_alternate_protocol_is_opaque_but_original_proof_still_binds_it(self):
  alternate={**V['challenge'],'paymentRequired':'e30='}
  bb.wire(alternate,V['observation']['request'],'base-mpp-charge-v1')
  with self.assertRaises(ValueError):bb.verify_route(V['response'],V['request'],vkey=V['trusted_vkey'],challenge=alternate,now=V['now'])
 def test_schema_and_runtime_agree(self):
  from live402.schema_http import batch_limit_schemas
  import re
  schema=batch_limit_schemas()['base-mpp-charge-v1'];self.assertEqual(set(schema['required']),set(V['request']['buyer_limits']));bb.parse_request(V['request'])
  for amount in ['0','01','18446744073709551616',1000]:
   body=copy.deepcopy(V['request']);body['buyer_limits']['max_call_amount_atomic']=amount
   self.assertFalse(type(amount) is str and re.fullmatch(schema['properties']['max_call_amount_atomic']['pattern'],amount))
   with self.assertRaises(ValueError):bb.parse_request(body)

 def test_explicit_standard_realm_may_differ_from_host(self):
  v=copy.deepcopy(V);v['request']['buyer_limits']['realm']='merchant-payments';v['challenge']['wwwAuthenticate']=v['challenge']['wwwAuthenticate'].replace('realm="merchant.example"','realm="merchant-payments"');v['observation']['challenge']=v['challenge']
  self.assertEqual(bb.build(v['request'],v['observation'])['terms']['per_call_amount_atomic'],'1000')
  v['request']['buyer_limits']['realm']='another-realm'
  with self.assertRaises(ValueError):bb.build(v['request'],v['observation'])
