import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {RouteClient} from '../client.mjs';
const key='synthetic_customer_credential_1234567890';
const body='{"need":"search","require_route_binding":true}';
const unavailable=JSON.stringify({error:'recovery_unavailable',recovery_only:true,new_payment_allowed:false});
class Store {values=new Map(); async get(id,p){return this.values.get(id+':'+p);} async putOnce(id,p,v){const k=id+':'+p;if(this.values.has(k))return false;this.values.set(k,structuredClone(v));return true;}}
function fixture({headers={},customerKey=key}={}) {
 const store=new Store(),calls=[];
 const client=new RouteClient({store,customerKey,recoveryProfile:'http-route-v1',fetch:async(url,init)=>{
  calls.push({url,init});
  if(init.body==='{}')return new Response(unavailable,{status:503});
  return new Response('{"x402Version":2}',{status:init.headers['PAYMENT-SIGNATURE']?200:402,headers});
 }});return {client,store,calls};
}
test('API credential is scoped to router for challenge, submission and recovery, never journaled',async()=>{
 const {client,store,calls}=fixture();await client.prepare('one',body);await client.challenge('one');
 await client.setPaymentHeader('one',{value:'synthetic_authorization'});await client.submit('one');await client.recover('one');
 assert.equal(calls.length,6);assert.ok(calls.every(({url,init})=>url==='https://402signal.com/route'&&init.headers['X-402Signal-Key']===key&&init.redirect==='error'&&init.credentials==='omit'));
 assert.equal(JSON.stringify([...store.values]).includes(key),false);assert.equal(JSON.stringify(await client.evidence('one')).includes(key),false);assert.equal(JSON.stringify(client).includes(key),false);
});
test('invalid API credentials fail before any network access and errors do not echo them',()=>{
 for(const customerKey of[null,1,'',key+'\r\nsecret: value','x'.repeat(129),'short','é'.repeat(32),'a'.repeat(31)]){
  assert.throws(()=>new RouteClient({store:new Store(),recoveryProfile:'http-route-v1',customerKey,fetch:()=>assert.fail('must not fetch')}),e=>e.code==='invalid_customer_key'&&e.message==='invalid_customer_key');
 }
});
test('anonymous clients still send no API credential',async()=>{
 const store=new Store();const c=new RouteClient({store,recoveryProfile:'http-route-v1',fetch:async(_,i)=>{assert.equal(i.headers['X-402Signal-Key'],undefined);return new Response(unavailable,{status:503});}});
 await c.prepare('one',body);await c.challenge('one');
});
test('journal cannot retarget API credentials to a seller URL',async()=>{
 const {client,store,calls}=fixture();await client.prepare('one',body);store.values.get('one:intent').routerUrl='https://seller.example/route';
 await assert.rejects(client.challenge('one'),{code:'invalid_saved_intent'});assert.equal(calls.length,0);
});
test('raw transport rejects an actual redirect without forwarding the credential',async()=>{
 let targetHits=0;
 const target=createServer((_,res)=>{targetHits++;res.end('unexpected');});await new Promise(r=>target.listen(0,'127.0.0.1',r));
 const router=createServer((req,res)=>{assert.equal(req.headers['x-402signal-key'],key);res.writeHead(307,{Location:`http://127.0.0.1:${target.address().port}/route`});res.end();});await new Promise(r=>router.listen(0,'127.0.0.1',r));
 try {const c=new RouteClient({store:new Store(),customerKey:key,recoveryProfile:'http-route-v1',routerUrl:`http://127.0.0.1:${router.address().port}/route`,allowInsecureLoopback:true});await c.prepare('one',body);await assert.rejects(c.challenge('one'),{code:'recovery_compatibility_unconfirmed'});assert.equal(targetHits,0);}
 finally{router.closeAllConnections();target.closeAllConnections();await Promise.all([new Promise(r=>router.close(r)),new Promise(r=>target.close(r))]);}
});
test('raw challenge header is retained for caller validation without decoding or payment',async()=>{
 const value=Buffer.from('{"x402Version":2}').toString('base64');
 for(const headers of[{'PAYMENT-REQUIRED':value},{'X-PAYMENT-REQUIRED':value},{'PAYMENT-REQUIRED':value,'X-PAYMENT-REQUIRED':value}]){
  const {client,store}=fixture({headers});await client.prepare('one',body);const r=await client.challenge('one');assert.equal(r.paymentRequired,value);assert.equal(await store.get('one','authorization'),undefined);
 }
});
test('conflicting or oversized challenge headers fail closed',async()=>{
 for(const headers of[{'PAYMENT-REQUIRED':'abc','X-PAYMENT-REQUIRED':'def'},{'PAYMENT-REQUIRED':'x'.repeat(16385)}]){
  const {client}=fixture({headers});await client.prepare('one',body);await assert.rejects(client.challenge('one'),e=>['conflicting_payment_challenges','invalid_payment_challenge'].includes(e.code));
 }
});

test('transport exceptions never expose the API credential',async()=>{
 let calls=0;const c=new RouteClient({store:new Store(),customerKey:key,recoveryProfile:'http-route-v1',fetch:async()=>{if(++calls===1)return new Response(unavailable,{status:503});throw Error(key);}});
 await c.prepare('one',body);await assert.rejects(c.challenge('one'),e=>e.code==='transport_ambiguous'&&!String(e).includes(key));
});
