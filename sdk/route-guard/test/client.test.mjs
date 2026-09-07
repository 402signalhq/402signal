import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,writeFile,symlink,chmod,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RouteClient,classifyRouteResponse} from '../client.mjs';
import {FileAttemptStore} from '../file-store.mjs';
const URL='https://402signal.example/route',body='{"need":"search","require_route_binding":true}';
const unavailable={error:'recovery_unavailable',recovery_only:true,new_payment_allowed:false};
const billing={model:'success_only_v1',condition:'live_eligible_route_found',asset:'USDC',amount_atomic:'3000',display_amount:'$0.003',rail:'base',settlement_state:'settled',settlement_attempted:true,settled:true};
const winner=JSON.stringify({live:true,billing,pq_trust:{private:'saved-evidence'}});
class MemoryStore {
 values=new Map();
 async get(id,part){return this.values.get(id+':'+part);}
 async putOnce(id,part,v){const k=id+':'+part;if(this.values.has(k))return false;this.values.set(k,structuredClone(v));return true;}
}
function fixture(options={}) {
 const calls=[],store=options.store??new MemoryStore();let normal=0,recovery=0,clock=100000;
 const send=async(url,init)=>{
  calls.push({url,init});assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert.ok(init.signal);
  if(init.body==='{}' && init.headers['Replay-Only']==='1')return new Response(JSON.stringify(options.old?{}:unavailable),{status:options.old?402:503});
  if(!init.headers['PAYMENT-SIGNATURE']&&!init.headers['X-PAYMENT']&&!init.headers['PAYMENT-PAYLOAD'])return new Response('{"x402Version":2}',{status:402});
  assert.ok(await store.get('one','intent'));assert.ok(await store.get('one','submission'));
  if(init.headers['Replay-Only']==='1'){recovery++;if(options.recoveryThrow)throw Error('private');return new Response(winner,{status:200,headers:{'PAYMENT-RESPONSE':'retained-receipt'}});}
  normal++;
  if(options.ambiguous)throw Error('private-authorization-must-not-appear');
  return new Response(options.response??winner,{status:options.status??200,headers:options.status?{}:{'PAYMENT-RESPONSE':'retained-receipt'}});
 };
 const make=()=>new RouteClient({store,routerUrl:URL,recoveryProfile:'http-route-v1',fetch:send,now:()=>clock,timeoutMs:100});
 return {store,calls,make,client:make(),normal:()=>normal,recovery:()=>recovery,setClock:v=>clock=v};
}
async function prepared(f){await f.client.prepare('one',body);await f.client.setPaymentHeader('one',{value:'opaque-signed-authorization'});}
test('private scope persisted before challenge and original paid request; raw evidence saved',async()=>{
 const f=fixture();await f.client.prepare('one',body);assert.equal(f.calls.length,0);
 const intent=await f.store.get('one','intent');assert.match(intent.replayKey,/^[0-9a-f]{64}$/);
 const ch=await f.client.challenge('one');assert.equal(ch.status,402);assert.equal(f.normal(),0);
 await f.client.setPaymentHeader('one',{value:'opaque-signed-authorization'});
 const r=await f.client.submit('one');assert.equal(f.normal(),1);assert.equal(r.response.bodyText,winner);assert.equal(r.classification.settlementReport,'settled');assert.equal(r.newPaymentAllowed,false);
 const saved=await f.client.evidence('one');assert.equal(saved[0].response.bodyText,winner);assert.equal(JSON.stringify(saved).includes(intent.replayKey),false);
});
test('ambiguous transport automatically uses recovery only; restart never ordinary-submits again',async()=>{
 const f=fixture({ambiguous:true});await prepared(f);const r=await f.client.submit('one');assert.equal(r.recoveryOnly,true);assert.equal(r.response.bodyText,winner);
 const restarted=f.make();await restarted.submit('one');assert.equal(f.normal(),1);assert.equal(f.recovery(),2);
 const paid=f.calls.filter(x=>x.init.headers['PAYMENT-SIGNATURE']);assert.ok(paid.every(x=>x.init.body===body));assert.equal(new Set(paid.map(x=>x.init.headers['Replay-Key'])).size,1);
});
test('concurrent submit attempts claim one ordinary request and bounded recovery slots',async()=>{
 const f=fixture();await prepared(f);await Promise.all(Array.from({length:20},()=>f.make().submit('one')));assert.equal(f.normal(),1);assert.ok(f.recovery()<=6);
});
test('old or unconfirmed server sees no payment header',async()=>{
 const f=fixture({old:true});await prepared(f);await assert.rejects(f.client.submit('one'),{code:'recovery_compatibility_unconfirmed'});assert.equal(f.normal(),0);assert.equal(await f.store.get('one','submission'),undefined);
 assert.ok(f.calls.every(x=>!x.init.headers['PAYMENT-SIGNATURE']&&!x.init.headers['Replay-Key']));
});
test('unknown or rate-limited result never grants a new payment and is retained',async()=>{
 for(const [status,response]of[[429,'{"error":"limit"}'],[503,JSON.stringify({billing:{...billing,settlement_state:'unknown',settled:false}})]]){
  const f=fixture({status,response});await prepared(f);const r=await f.client.submit('one');assert.equal(r.newPaymentAllowed,false);assert.equal(r.response.bodyText,response);await f.client.submit('one');assert.equal(f.normal(),1);
 }
});
test('failed evidence persistence leaves ordinary submission permanently claimed',async()=>{
 const store=new MemoryStore(),put=store.putOnce.bind(store);store.putOnce=async(id,p,v)=>{if(p==='response-original')throw Error('disk');return put(id,p,v);};
 const f=fixture({store});await prepared(f);await assert.rejects(f.client.submit('one'),{code:'private_store_unavailable'});const r=await f.make().submit('one');assert.equal(r.recoveryOnly,true);assert.equal(f.normal(),1);
});
test('failed pre-send persistence sends no payment',async()=>{
 const store=new MemoryStore(),put=store.putOnce.bind(store);store.putOnce=async(id,p,v)=>{if(p==='submission')throw Error('disk');return put(id,p,v);};
 const f=fixture({store});await prepared(f);await assert.rejects(f.client.submit('one'),{code:'private_store_unavailable'});assert.equal(f.normal(),0);
});
test('original authorization and request are immutable',async()=>{
 const f=fixture();await prepared(f);await assert.rejects(f.client.prepare('one',body),{code:'attempt_already_exists'});await assert.rejects(f.client.setPaymentHeader('one',{value:'replacement'}),{code:'authorization_already_exists'});
 await f.client.submit('one');await assert.rejects(f.client.setPaymentHeader('one',{value:'replacement'}),{code:'already_submitted'});
});
test('expired and backwards-clock recovery do not send authorizations',async()=>{
 for(const time of[99999,220000]){const f=fixture();await prepared(f);await f.client.submit('one');f.setClock(time);const count=f.calls.length,r=await f.client.recover('one');assert.equal(r.reason,'recovery_window_elapsed');assert.equal(f.calls.length,count);assert.equal(r.newPaymentAllowed,false);}
});
test('recovery is capped across client restarts and failed retrievals',async()=>{
 const f=fixture({ambiguous:true,recoveryThrow:true});await prepared(f);await f.client.submit('one');for(let i=0;i<8;i++)await f.make().recover('one');assert.equal(f.normal(),1);assert.equal(f.recovery(),6);
});
test('duplicate-key JSON, wrong intent URL and header injection fail closed',async()=>{
 const f=fixture();await assert.rejects(f.client.prepare('one','{"require_route_binding":true,"require_route_binding":true}'));
 await f.client.prepare('one',body);await assert.rejects(f.client.setPaymentHeader('one',{value:'x\r\nInjected:y'}),{code:'invalid_payment_header'});
 f.store.values.get('one:intent').routerUrl='https://other.example/route';await assert.rejects(f.client.challenge('one'),{code:'invalid_saved_intent'});
});
test('billing parsing rejects duplicate keys and never upgrades server claims to confirmation',()=>{
 const v=classifyRouteResponse({status:200,bodyText:'{"billing":{},"billing":'+JSON.stringify(billing)+'}',paymentResponse:null,retryAfter:null});assert.equal(v.settlementReport,'unclassified');assert.equal(v.chainConfirmation,'not_checked');assert.equal(v.sellerExecutionAllowed,false);
});
test('zero replay/private material is sent in compatibility check; URL redirects refused',async()=>{
 const store=new MemoryStore(),calls=[];const client=new RouteClient({store,recoveryProfile:'http-route-v1',fetch:async(u,i)=>{calls.push(i);const r=new Response(JSON.stringify(unavailable),{status:503});Object.defineProperty(r,'redirected',{value:true});return r;}});
 await client.prepare('one',body);await client.setPaymentHeader('one',{value:'private'});await assert.rejects(client.submit('one'));assert.equal(calls.length,1);assert.equal(calls[0].body,'{}');assert.deepEqual(Object.keys(calls[0].headers).sort(),['Content-Type','Replay-Only']);
});
test('response byte limit and whole-stream deadline fail closed before payment compatibility',async()=>{
 for(const fetcher of[async()=>new Response('x'.repeat(262145),{status:503}),async()=>new Response(new ReadableStream({start(){}}),{status:503})]){
  const f=new RouteClient({store:new MemoryStore(),recoveryProfile:'http-route-v1',fetch:fetcher,timeoutMs:10});await f.prepare('one',body);await f.setPaymentHeader('one',{value:'private'});await assert.rejects(f.submit('one'),{code:'recovery_compatibility_unconfirmed'});
 }
});
test('unconfirmed profile, private URL and missing binding rejected',async()=>{
 assert.throws(()=>new RouteClient({store:new MemoryStore()}),{code:'confirmed_recovery_profile_required'});
 for(const routerUrl of['http://example.com/route','https://u:p@example.com/route','https://example.com/route?x=1','https://example.com/mcp'])assert.throws(()=>new RouteClient({store:new MemoryStore(),recoveryProfile:'http-route-v1',routerUrl}),{code:'invalid_router_url'});
 await assert.rejects(fixture().client.prepare('one','{"need":"x"}'),{code:'route_binding_required'});
});
test('private file store survives reconstruction, claims atomically and preserves modes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'signal-client-'));try{
  const dir=join(root,'private'),s=new FileAttemptStore(dir);assert.equal(await s.putOnce('one','intent',{secret:'x'}),true);assert.equal((await stat(dir)).mode&0o777,0o700);assert.equal((await stat(join(dir,'one.intent.json'))).mode&0o777,0o600);
  const claims=await Promise.all(Array.from({length:10},()=>new FileAttemptStore(dir).putOnce('one','submission',{at:1})));assert.equal(claims.filter(Boolean).length,1);assert.equal((await new FileAttemptStore(dir).get('one','intent')).secret,'x');
  await assert.rejects(s.putOnce('../bad','intent',{}));await assert.rejects(s.get('one','../../bad'));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('file store rejects symlinks, permissive files/directories and corrupt claims',async()=>{
 const root=await mkdtemp(join(tmpdir(),'signal-client-'));try{
  const dir=join(root,'private'),s=new FileAttemptStore(dir);await s.putOnce('one','intent',{});
  await symlink(join(dir,'one.intent.json'),join(dir,'one.authorization.json'));await assert.rejects(s.get('one','authorization'));
  await writeFile(join(dir,'one.submission.json'),'',{mode:0o600});await assert.rejects(s.get('one','submission'));
  await chmod(join(dir,'one.intent.json'),0o644);await assert.rejects(s.get('one','intent'));
  await chmod(dir,0o755);await assert.rejects(s.putOnce('two','intent',{}));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('actual file journal restart recovers with exact private scope and one initial submission',async()=>{
 const root=await mkdtemp(join(tmpdir(),'signal-client-'));try{
  const dir=join(root,'private'),f=fixture({store:new FileAttemptStore(dir),ambiguous:true});await prepared(f);await f.client.submit('one');await f.make().submit('one');assert.equal(f.normal(),1);assert.equal(f.recovery(),2);
  const raw=await readFile(join(dir,'one.intent.json'),'utf8');assert.ok(raw.includes('replayKey'));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('capability throttling retains retry guidance and sends no payment',async()=>{
 const store=new MemoryStore();let limited=false;
 const f=new RouteClient({store,recoveryProfile:'http-route-v1',fetch:async()=>new Response(limited?'{}':JSON.stringify(unavailable),{status:limited?429:503,headers:limited?{'Retry-After':'60'}:{}})});
 await f.prepare('one',body);await f.setPaymentHeader('one',{value:'private'});limited=true;
 await assert.rejects(f.submit('one'),e=>e.code==='recovery_rate_limited'&&e.retryAfter==='60');assert.equal(await store.get('one','submission'),undefined);
 await store.putOnce('one','submission',{at:Date.now()});const r=await f.recover('one');assert.equal(r.reason,'recovery_rate_limited');assert.equal(r.retryAfter,'60');assert.equal(r.newPaymentAllowed,false);
});
test('contradictory or incomplete settled claims remain unclassified',()=>{
 for(const [status,b]of[[402,billing],[200,{...billing,condition:'other'}],[200,{...billing,display_amount:'$1'}]]) {
  assert.equal(classifyRouteResponse({status,bodyText:JSON.stringify({billing:b}),paymentResponse:'receipt',retryAfter:null}).settlementReport,'unclassified');
 }
});
