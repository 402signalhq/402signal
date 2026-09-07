"""Synthetic policy closeout: isolated cloud tests, no provider calls."""
import copy,hashlib,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from live402 import admission

KEY='synthetic-private-capacity-key-00000001'
DIGEST=hashlib.sha256(KEY.encode()).hexdigest()
def policy():
 return {'version':2,'window_seconds':60,'max_keys':64,
  'ingress':{'global':100,'anonymous':5},'unpaid':{'global':40,'anonymous':3},
  'target':{'global':100,'origin':50,'failures':5},
  'anonymous_totals':{'ingress':10,'unpaid':6},
  'recovery':{'global':10,'anonymous_total':6,'anonymous':2,'customer':4},
  'customers':{DIGEST:{'ingress':20,'unpaid':10}}}

class ProtectedAdmissionTests(unittest.TestCase):
 def setUp(self):
  self.now=100.;self.headers={'X-402Signal-Key':KEY}
  self.e=admission.Engine(admission.Policy(policy()),lambda:self.now)
 def test_rotating_anonymous_peers_cannot_consume_partner_headroom(self):
  self.assertTrue(all(self.e.ingress({},str(i)) for i in range(10)))
  self.assertFalse(self.e.ingress({},'next'))
  self.assertTrue(self.e.ingress(self.headers,'shared-nat'))
  self.assertTrue(all(self.e.reserve({},str(i)) for i in range(6)))
  self.assertIsNone(self.e.reserve({},'next'))
  self.assertIsNotNone(self.e.reserve(self.headers,'shared-nat'))
 def test_global_ceiling_remains_authoritative(self):
  p=policy();p['unpaid']['global']=8;p['customers'][DIGEST]['unpaid']=20
  e=admission.Engine(admission.Policy(p),lambda:self.now)
  self.assertTrue(all(e.reserve({},str(i)) for i in range(6)))
  self.assertIsNotNone(e.reserve(self.headers,'p'));self.assertIsNotNone(e.reserve(self.headers,'p'))
  self.assertIsNone(e.reserve(self.headers,'p'))
 def test_confirmed_payment_refunds_anonymous_aggregate_once(self):
  leases=[self.e.reserve({},str(i)) for i in range(6)]
  self.assertIsNone(self.e.reserve({},'next'))
  leases[0].finish(True);leases[0].finish(True)
  self.assertIsNotNone(self.e.reserve({},'next'));self.assertIsNone(self.e.reserve({},'another'))
 def test_saturated_identity_map_preserves_preallocated_partner_counters(self):
  p=policy();p['max_keys']=16;e=admission.Engine(admission.Policy(p),lambda:self.now)
  for i in range(10):self.assertIsNotNone(e.take([('anonymous-churn:'+str(i),1)]))
  self.assertIsNone(e.take([('extra',1)]));self.assertEqual(len(e.buckets),16)
  self.assertTrue(e.ingress(self.headers,'p'));self.assertIsNotNone(e.reserve(self.headers,'p'))
  self.assertEqual(len(e.buckets),16)
 def test_pinned_counters_not_evicted_when_fully_refilled(self):
  p=policy();p['max_keys']=16;e=admission.Engine(admission.Policy(p),lambda:self.now)
  for i in range(10):e.take([('churn:'+str(i),1)])
  self.now+=60;self.assertIsNotNone(e.take([('replacement',1)]))
  self.assertTrue(e.pinned.issubset(e.buckets))
 def test_recovery_has_separate_capacity_and_no_work_refund(self):
  for _ in range(20):self.e.ingress(self.headers,'p')
  self.assertFalse(self.e.ingress(self.headers,'p'))
  for _ in range(10):self.e.reserve(self.headers,'p')
  balance=self.e.buckets['unpaid:global'].balance
  self.assertTrue(self.e.recover(self.headers,'p'))
  self.assertEqual(self.e.buckets['unpaid:global'].balance,balance)
  self.assertFalse(self.e.ingress(self.headers,'p'))
 def test_recovery_anonymous_aggregate_and_customer_global_ceiling(self):
  self.assertTrue(all(self.e.recover({},str(i)) for i in range(6)))
  self.assertFalse(self.e.recover({},'next'))
  self.assertTrue(all(self.e.recover(self.headers,'p') for _ in range(4)))
  self.assertFalse(self.e.recover(self.headers,'p'))
 def test_recovery_map_saturation_does_not_evict_spent_or_customer_buckets(self):
  p=policy();p['max_keys']=16;p['recovery']['global']=100;p['recovery']['anonymous_total']=90
  e=admission.Engine(admission.Policy(p),lambda:self.now)
  self.assertTrue(all(e.recover({},str(i)) for i in range(13)))
  self.assertFalse(e.recover({},'extra'));self.assertEqual(len(e.recovery_buckets),16)
  self.assertTrue(e.recover(self.headers,'partner'));self.assertEqual(len(e.recovery_buckets),16)
 def test_unknown_keys_share_peer_recovery_budget(self):
  self.assertTrue(self.e.recover({'X-402Signal-Key':'x'*40},'same'))
  self.assertTrue(self.e.recover({'X-402Signal-Key':'y'*40},'same'))
  self.assertFalse(self.e.recover({'X-402Signal-Key':'z'*40},'same'))
 def test_cold_start_pinned_counters_do_not_create_credit(self):
  e=admission.Engine(admission.Policy(policy()),lambda:self.now,cold_start=True)
  self.assertFalse(e.ingress(self.headers,'p'));self.assertFalse(e.recover(self.headers,'p'))
  self.now+=60
  self.assertTrue(e.ingress(self.headers,'p'));self.assertTrue(e.recover(self.headers,'p'))
  restarted=admission.Engine(admission.Policy(policy()),lambda:self.now,cold_start=True)
  self.assertFalse(restarted.recover(self.headers,'p'))
 def test_v1_remains_supported_but_v2_requires_real_headroom(self):
  p=policy();p['version']=1;del p['anonymous_totals'];del p['recovery']
  self.assertIsNone(admission.Policy(p).anonymous_totals)
  for field in ('ingress','unpaid'):
   p=policy();p['anonymous_totals'][field]=p[field]['global']
   with self.assertRaises(ValueError):admission.Policy(p)
  p=policy();p['version']=True
  with self.assertRaises(ValueError):admission.Policy(p)
 def test_versioned_policy_revokes_key_with_conservative_refill(self):
  with tempfile.TemporaryDirectory() as d:
   first=Path(d)/'v1.json';second=Path(d)/'v2.json'
   first.write_text(json.dumps(policy()));first.chmod(0o600)
   with patch.dict(os.environ,{'LIVE402_ADMISSION_POLICY_FILE':str(first)}):
    original=admission.engine();self.assertIsNotNone(original.identity(self.headers,'p')[1])
    revoked=policy();revoked['customers']={}
    first.write_text(json.dumps(revoked))
    self.assertIs(admission.engine(),original)
    self.assertIsNotNone(admission.engine().identity(self.headers,'p')[1])
    second.write_text(json.dumps(revoked));second.chmod(0o600)
    os.environ['LIVE402_ADMISSION_POLICY_FILE']=str(second)
    updated=admission.engine();self.assertIsNone(updated.identity(self.headers,'p')[1])
    self.assertFalse(updated.recover(self.headers,'p'))
 def test_invalid_replacement_fails_closed_and_does_not_reuse_old_key(self):
  with tempfile.TemporaryDirectory() as d:
   first=Path(d)/'good';bad=Path(d)/'bad';first.write_text(json.dumps(policy()));first.chmod(0o600)
   bad.write_text('{}');bad.chmod(0o600)
   with patch.dict(os.environ,{'LIVE402_ADMISSION_POLICY_FILE':str(first)}):
    self.assertTrue(admission.ready());os.environ['LIVE402_ADMISSION_POLICY_FILE']=str(bad)
    self.assertFalse(admission.ready());self.assertFalse(admission.recovery(self.headers,'p'))

 def test_http_anonymous_exhaustion_preserves_recognized_work_admission(self):
  import http.client,threading
  from live402 import server
  class Quiet(server.Handler):
   def log_message(self,*args):pass
  httpd=server.BoundedThreadingHTTPServer(('127.0.0.1',0),Quiet)
  thread=threading.Thread(target=httpd.serve_forever,daemon=True);thread.start()
  def execute(body,headers,resource):
   try:lease=admission.reserve(headers)
   except admission.Unavailable:return admission.rejected()
   lease.finish(False);return 200,{'synthetic_work':True},{}
  def request(headers):
   conn=http.client.HTTPConnection('127.0.0.1',httpd.server_port,timeout=5)
   try:
    conn.request('POST','/route','{}',{'Content-Type':'application/json',**headers})
    response=conn.getresponse();response.read();return response.status
   finally:conn.close()
  try:
   with patch.object(admission,'engine',return_value=self.e),patch.object(admission,'configured',return_value=True),patch.object(server,'handle_route',side_effect=execute),patch.object(server,'client_ip',side_effect=[str(i) for i in range(8)]):
    self.assertEqual([request({}) for _ in range(6)],[200]*6)
    self.assertEqual(request({}),429)
    self.assertEqual(request(self.headers),200)
  finally:httpd.shutdown();httpd.server_close();thread.join(timeout=5)

 def test_concurrent_anonymous_work_preserves_partner_headroom(self):
  from concurrent.futures import ThreadPoolExecutor
  p=policy();p['unpaid']['global']=8
  e=admission.Engine(admission.Policy(p),lambda:self.now)
  calls=[({},str(i),False) for i in range(100)]+[(self.headers,'partner',True) for _ in range(20)]
  with ThreadPoolExecutor(max_workers=16) as pool:
   results=list(pool.map(lambda c:(c[2],e.reserve(c[0],c[1]) is not None),calls))
  self.assertEqual(sum(ok for known,ok in results),8)
  self.assertLessEqual(sum(ok for known,ok in results if not known),6)
  self.assertGreaterEqual(sum(ok for known,ok in results if known),2)
 def test_concurrent_recovery_uses_its_own_global_and_class_ceiling(self):
  from concurrent.futures import ThreadPoolExecutor
  calls=[({},str(i),False) for i in range(100)]+[(self.headers,'partner',True) for _ in range(20)]
  with ThreadPoolExecutor(max_workers=16) as pool:
   results=list(pool.map(lambda c:(c[2],self.e.recover(c[0],c[1])),calls))
  self.assertEqual(sum(ok for known,ok in results),10)
  self.assertEqual(sum(ok for known,ok in results if known),4)
  self.assertEqual(self.e.buckets['unpaid:global'].balance,40)
