import copy,json,pathlib,unittest
from live402.batch_profiles.algorand import validate
from live402 import route_binding as rb
V=json.loads((pathlib.Path(__file__).parent/'fixtures/algorand-batch-profile.json').read_text())
class AlgorandProfileTests(unittest.TestCase):
 def test_exact_manifest(self):self.assertEqual(validate(V['envelope'],V['context'],V['limits']),V['expected'])
 def test_required_independent_pins_and_caps(self):
  for key in V['limits']:
   x=copy.deepcopy(V);x['limits'].pop(key)
   with self.subTest(key=key),self.assertRaises(rb.BindingError):validate(x['envelope'],x['context'],x['limits'])
  for key,value in [('max_total_amount_atomic','1999'),('max_sponsor_fee_micro_algo','14999'),('max_total_amount_atomic','02000'),('recipient',V['limits']['fee_payer']),('network','algorand:testnet'),('asset','1'),('fee_payer',V['limits']['recipient'])]:
   x=copy.deepcopy(V);x['limits'][key]=value
   with self.subTest(key=key),self.assertRaises(rb.BindingError):validate(x['envelope'],x['context'],x['limits'])
 def test_every_manifest_field_committed(self):
  for key in V['expected']:
   x=copy.deepcopy(V);x['envelope']['extensions']['402signal-atomic-batch'].pop(key)
   with self.subTest(key=key),self.assertRaises(rb.BindingError):validate(x['envelope'],x['context'],x['limits'])
 def test_types_and_extra_protocol_fields(self):
  for mutate in [lambda x:x['envelope']['extensions'].update(other={}),lambda x:x['envelope']['accepts'][0]['extra'].update(other=True),lambda x:x['envelope']['accepts'][0].update(maxTimeoutSeconds=True),lambda x:x['envelope']['extensions']['402signal-atomic-batch'].update(version=True),lambda x:x['limits'].update(extra=True)]:
   x=copy.deepcopy(V);mutate(x)
   with self.assertRaises(rb.BindingError):validate(x['envelope'],x['context'],x['limits'])
 def test_query_method_body_and_recipient_tampering(self):
  for key,value in [('method','POST'),('body_sha256','00'*32),('url',V['context']['url']+'&left=x'),('url',V['context']['url'].replace('left=alpha','left=%ZZ')),('url',V['context']['url'].replace('left=alpha','left=%FF')),('url',V['context']['url']+'#fragment')]:
   x=copy.deepcopy(V);x['context'][key]=value
   with self.subTest(value=value),self.assertRaises(rb.BindingError):validate(x['envelope'],x['context'],x['limits'])
 def test_invalid_address_checksum_rejected_even_when_all_fields_agree(self):
  x=copy.deepcopy(V);wrong='B'+V['limits']['recipient'][1:-1]+'A';x['limits']['recipient']=wrong;x['envelope']['accepts'][0]['payTo']=wrong;x['envelope']['extensions']['402signal-atomic-batch']['recipient']=wrong
  with self.assertRaises(rb.BindingError):validate(x['envelope'],x['context'],x['limits'])

 def test_noncanonical_address_padding_is_rejected(self):
  x=copy.deepcopy(V);alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';address=V['limits']['recipient'];wrong=address[:-1]+alphabet[alphabet.index(address[-1])+1];x['limits']['recipient']=wrong;x['envelope']['accepts'][0]['payTo']=wrong;x['envelope']['extensions']['402signal-atomic-batch']['recipient']=wrong
  with self.assertRaises(rb.BindingError):validate(x['envelope'],x['context'],x['limits'])
