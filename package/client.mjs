/** Buyer-owned routing lifecycle. No signer, wallet or merchant executor. */
import {randomBytes} from 'node:crypto';
import {parse} from './internal-json.mjs';
import {isUnsettledRouteMiss} from './index.mjs';

const LIMIT = 262144;
const PROFILE = 'http-route-v1';
const PARTS = new Set(['intent','authorization','submission','response-original',
  ...Array.from({length:6},(_,i)=>`recovery-${i+1}`),
  ...Array.from({length:6},(_,i)=>`response-recovery-${i+1}`)]);
export class RouteClientError extends Error {
  constructor(code) {super(code);this.name='RouteClientError';this.code=code;}
}
function check(ok, code) {if(!ok) throw new RouteClientError(code);}
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const json = raw => parse(raw,{ordinaryNumbers:true,limit:LIMIT});
const copy = value => JSON.parse(JSON.stringify(value));
function idValid(id) {check(typeof id==='string' && /^[A-Za-z0-9_-]{1,64}$/.test(id),'invalid_attempt_id');}
export function validStorePart(part) {return PARTS.has(part);}
function router(value, allowLoopback) {
  let u;try {u=new URL(value);} catch {throw new RouteClientError('invalid_router_url');}
  const loopback=allowLoopback===true && u.protocol==='http:' && ['127.0.0.1','[::1]','localhost'].includes(u.hostname);
  check((u.protocol==='https:'||loopback) && !u.username && !u.password && !u.search && !u.hash && u.pathname==='/route','invalid_router_url');
  return u.href;
}
function responseRecord(status,bodyText,paymentResponse,retryAfter,paymentRequired) {
  check(Number.isInteger(status)&&status>=100&&status<=599&&typeof bodyText==='string'&&Buffer.byteLength(bodyText)<=LIMIT,'invalid_response');
  check(paymentResponse===null || typeof paymentResponse==='string'&&paymentResponse.length<=16384,'invalid_response');
  check(paymentRequired===null || typeof paymentRequired==='string'&&paymentRequired.length>0&&paymentRequired.length<=16384&&/^[\x21-\x7e]+$/.test(paymentRequired),'invalid_payment_challenge');
  return {status,bodyText,paymentResponse,paymentRequired,retryAfter:typeof retryAfter==='string'&&retryAfter.length<=128?retryAfter:null};
}
/** Server billing claims are not independent chain confirmation or spending authority. */
export function classifyRouteResponse(response) {
  let settlement='unclassified';
  try {
    const v=json(response.bodyText),b=v.billing;
    if([200,503].includes(response.status)&&object(b)&&b.model==='success_only_v1'&&b.condition==='live_eligible_route_found'&&b.asset==='USDC'&&b.amount_atomic==='3000'&&b.display_amount==='$0.003'&&['base','solana','algorand'].includes(b.rail)) {
      if(b.settlement_state==='settled'&&b.settlement_attempted===true&&b.settled===true) settlement='settled';
      if(b.settlement_state==='not_attempted'&&b.settlement_attempted===false&&b.settled===false&&response.paymentResponse===null) settlement='not_attempted';
      if(b.settlement_state==='unknown') settlement='unknown';
    }
  } catch {}
  return Object.freeze({settlementReport:settlement,
    normalMiss:isUnsettledRouteMiss({httpStatus:response.status,routeResponseJson:response.bodyText,paymentResponseHeader:response.paymentResponse}),
    chainConfirmation:'not_checked',newPaymentAllowed:false,sellerExecutionAllowed:false});
}

export class RouteClient {
  #url;#store;#fetch;#timeout;#now;#customerKey;
  constructor({store,routerUrl='https://402signal.com/route',customerKey,recoveryProfile,fetch:fetchImpl=globalThis.fetch,timeoutMs=75000,allowInsecureLoopback=false,now=Date.now}) {
    check(recoveryProfile===PROFILE,'confirmed_recovery_profile_required');
    check(store&&typeof store.get==='function'&&typeof store.putOnce==='function','durable_store_required');
    check(typeof fetchImpl==='function'&&typeof now==='function'&&Number.isSafeInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=90000,'invalid_client_options');
    check(customerKey===undefined || typeof customerKey==='string'&&/^[A-Za-z0-9_-]{32,128}$/.test(customerKey),'invalid_customer_key');
    this.#customerKey=customerKey;
    this.#url=router(routerUrl,allowInsecureLoopback);this.#store=store;this.#fetch=fetchImpl;this.#timeout=timeoutMs;this.#now=now;
  }
  async #get(id,part) {
    idValid(id);check(PARTS.has(part),'invalid_store_part');
    try {const v=await this.#store.get(id,part);return v===undefined?undefined:copy(v);} catch {throw new RouteClientError('private_store_unavailable');}
  }
  async #put(id,part,value) {
    idValid(id);check(PARTS.has(part),'invalid_store_part');
    try {const result=await this.#store.putOnce(id,part,copy(value));check(typeof result==='boolean','invalid_store_result');return result;} catch {throw new RouteClientError('private_store_unavailable');}
  }
  async #intent(id) {
    const v=await this.#get(id,'intent');
    check(object(v)&&v.version===1&&v.id===id&&v.routerUrl===this.#url&&v.recoveryProfile===PROFILE&&/^[0-9a-f]{64}$/.test(v.replayKey),'invalid_saved_intent');
    const body=json(v.requestJson);check(object(body)&&body.require_route_binding===true,'route_binding_required');
    return v;
  }
  async #request(bodyText,headers={},timeout=this.#timeout) {
    const controller=new AbortController();let timer;
    const work=(async()=>{
      const r=await this.#fetch(this.#url,{method:'POST',body:bodyText,headers:{'Content-Type':'application/json',...headers,...(this.#customerKey===undefined?{}:{'X-402Signal-Key':this.#customerKey})},redirect:'error',credentials:'omit',cache:'no-store',signal:controller.signal});
      check(!r.redirected && (!r.url||r.url===this.#url),'redirect_refused');
      const length=r.headers.get('content-length');check(length===null||/^\d+$/.test(length)&&Number(length)<=LIMIT,'response_too_large');
      const chunks=[];let size=0;const reader=r.body?.getReader();
      if(reader)try {
        for(;;){const x=await reader.read();if(x.done)break;size+=x.value.byteLength;check(size<=LIMIT,'response_too_large');chunks.push(x.value);}
      } catch(e) {await reader.cancel().catch(()=>{});throw e;}
      const raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
      const required=r.headers.get('PAYMENT-REQUIRED'),legacy=r.headers.get('X-PAYMENT-REQUIRED');
      check(required===null||legacy===null||required===legacy,'conflicting_payment_challenges');
      return responseRecord(r.status,raw,r.headers.get('PAYMENT-RESPONSE'),r.headers.get('Retry-After'),required??legacy);
    })();
    try {
      return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new RouteClientError('transport_ambiguous'));},timeout);})]);
    } catch(error) {
      // Caller transports can include credentials in their error text.
      throw error instanceof RouteClientError ? error : new RouteClientError('transport_ambiguous');
    } finally {clearTimeout(timer);controller.abort();}
  }
  async #capability() {
    // Only the configured router receives the API access key. No payment or private
    // request material is sent before confirming its recovery contract.
    let r;try {r=await this.#request('{}',{'Replay-Only':'1'},Math.min(this.#timeout,10000));} catch {throw new RouteClientError('recovery_compatibility_unconfirmed');}
    if(r.status===429){const error=new RouteClientError('recovery_rate_limited');error.retryAfter=r.retryAfter;throw error;}
    let b;try {b=json(r.bodyText);} catch {throw new RouteClientError('recovery_compatibility_unconfirmed');}
    check(r.status===503&&r.paymentResponse===null&&object(b)&&b.error==='recovery_unavailable'&&b.recovery_only===true&&b.new_payment_allowed===false,'recovery_compatibility_unconfirmed');
  }
  /** Persist private scope before the original challenge or paid submission. */
  async prepare(id,requestJson) {
    idValid(id);const body=json(requestJson);check(object(body)&&body.require_route_binding===true,'route_binding_required');
    const intent={version:1,id,routerUrl:this.#url,recoveryProfile:PROFILE,requestJson,replayKey:randomBytes(32).toString('hex')};
    check(await this.#put(id,'intent',intent),'attempt_already_exists');
    return Object.freeze({id,prepared:true});
  }
  /** Unpaid challenge only. Never invokes a payment-aware fetch wrapper. */
  async challenge(id) {
    const v=await this.#intent(id);check(await this.#get(id,'submission')===undefined,'already_submitted');
    await this.#capability();
    return Object.freeze(await this.#request(v.requestJson,{'Replay-Key':v.replayKey}));
  }
  /** Caller validates/signs/reserves its own economic intent outside this client. */
  async setPaymentHeader(id,{name='PAYMENT-SIGNATURE',value}) {
    await this.#intent(id);check(await this.#get(id,'submission')===undefined,'already_submitted');
    check(['PAYMENT-SIGNATURE','PAYMENT-PAYLOAD','X-PAYMENT'].includes(name)&&typeof value==='string'&&value.length>0&&value.length<=16384&&/^[\x21-\x7e]+$/.test(value),'invalid_payment_header');
    check(await this.#put(id,'authorization',{name,value}),'authorization_already_exists');
  }
  async #authorization(id) {
    const a=await this.#get(id,'authorization');
    check(object(a)&&['PAYMENT-SIGNATURE','PAYMENT-PAYLOAD','X-PAYMENT'].includes(a.name)&&typeof a.value==='string'&&a.value.length>0&&a.value.length<=16384&&/^[\x21-\x7e]+$/.test(a.value),'invalid_saved_authorization');return a;
  }
  #result(id,response,recovery,reason,retryAfter=null) {
    return Object.freeze({id,recoveryOnly:recovery,newPaymentAllowed:false,sellerExecutionAllowed:false,reason,retryAfter,
      ...(response?{response:Object.freeze(response),classification:classifyRouteResponse(response)}:{})});
  }
  /** Durable one-shot claim occurs before any ordinary paid HTTP request. */
  async submit(id) {
    const v=await this.#intent(id),a=await this.#authorization(id);
    if(await this.#get(id,'submission')!==undefined)return this.recover(id);
    await this.#capability();
    const at=this.#now();check(Number.isSafeInteger(at)&&at>=0,'invalid_clock');
    if(!await this.#put(id,'submission',{at}))return this.recover(id);
    let response;
    try {response=await this.#request(v.requestJson,{'Replay-Key':v.replayKey,[a.name]:a.value});}
    catch {return this.recover(id);}
    check(await this.#put(id,'response-original',response),'response_evidence_conflict');
    return this.#result(id,response,false,'response_received');
  }
  /** At most six attempts; no ordinary POST, signer, budget release or TTL extension. */
  async recover(id) {
    const v=await this.#intent(id),a=await this.#authorization(id),sent=await this.#get(id,'submission');
    check(object(sent)&&Number.isSafeInteger(sent.at)&&sent.at>=0,'submission_record_required');
    const age=this.#now()-sent.at;
    if(!Number.isFinite(age)||age<0||age>=120000)return this.#result(id,null,true,'recovery_window_elapsed');
    let slot;
    for(let i=1;i<=6;i++)if(await this.#put(id,`recovery-${i}`,{at:this.#now()})){slot=i;break;}
    if(slot===undefined)return this.#result(id,null,true,'recovery_attempt_limit');
    try {await this.#capability();} catch(error) {return this.#result(id,null,true,error.code==='recovery_rate_limited'?'recovery_rate_limited':'recovery_compatibility_unconfirmed',error.retryAfter??null);}
    const remaining=120000-(this.#now()-sent.at);
    if(remaining<=0||remaining>120000)return this.#result(id,null,true,'recovery_window_elapsed');
    let response;
    try {response=await this.#request(v.requestJson,{'Replay-Key':v.replayKey,'Replay-Only':'1',[a.name]:a.value},Math.min(10000,remaining,this.#timeout));}
    catch {return this.#result(id,null,true,'recovery_transport_unavailable');}
    check(await this.#put(id,`response-recovery-${slot}`,response),'response_evidence_conflict');
    return this.#result(id,response,true,'recovery_response_received');
  }
  /** Private raw response evidence, including earlier outcomes; never an authorization. */
  async evidence(id) {
    await this.#intent(id);const out=[];
    for(const part of ['response-original',...Array.from({length:6},(_,i)=>`response-recovery-${i+1}`)]) {
      const v=await this.#get(id,part);if(v!==undefined)out.push(Object.freeze({part,response:Object.freeze(v)}));
    }
    return Object.freeze(out);
  }
}
