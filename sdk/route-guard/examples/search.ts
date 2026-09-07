import { RouteClient, type RouteResponse, type RouteResult } from '@402signal/route-guard/client';
import { withVerifiedRoute, type VerifiedAction } from '@402signal/route-guard';

export interface SearchBuyer {
  /** Atomically reserve a durable job budget including separately assessed fees. */
  reserve(jobId:string, prices:Readonly<{routerAtomic:'3000'; sellerMaximumAtomic:'1000'; asset:'USDC'; network:'eip155:8453'}>):Promise<void>;
  /** Validate router recipient/token/chain/amount/effects; sign once in your own wallet. */
  signRouting(jobId:string, challenge:RouteResponse):Promise<string>;
  /** Independently match existing on-chain effects to your saved router intent. */
  confirmRouting(jobId:string, outcome:RouteResult):Promise<boolean>;
  /** Persist a seller intent and claim before sending. Never retry after ambiguity. */
  executeSellerOnce(jobId:string, action:VerifiedAction, challenge:Readonly<{status:number;bodyText:string;paymentRequired?:string;xPaymentRequired?:string}>):Promise<unknown>;
}

/** A single fresh job. To resume a lost routing response, call client.recover(id)
 * directly; do not rerun this orchestration with a new ID or re-sign automatically.
 */
export async function runSearch(options:{id:string;query:string;client:RouteClient;buyer:SearchBuyer;trustedLogVkey:string}) {
  const {id,query,client,buyer,trustedLogVkey}=options;
  if(typeof query!=='string'||query.length<1||query.length>300)throw new Error('invalid_search_query');
  const url='https://api.agentstools.dev/search?query='+encodeURIComponent(query)+'&max_results=5';
  const requestJson=JSON.stringify({url,need:'web search',networks:['base'],max_price_usd:0.001,require_route_binding:true});
  await client.prepare(id,requestJson);
  await buyer.reserve(id,{routerAtomic:'3000',sellerMaximumAtomic:'1000',asset:'USDC',network:'eip155:8453'});
  const challenge=await client.challenge(id);
  if(challenge.status!==402)throw new Error('routing_challenge_unavailable');
  await client.setPaymentHeader(id,{value:await buyer.signRouting(id,challenge)});
  const outcome=await client.submit(id);
  if(outcome.response?.status!==200||outcome.classification?.settlementReport!=='settled')return {state:'routing_unresolved_or_unpaid',outcome};
  if(!await buyer.confirmRouting(id,outcome))return {state:'routing_confirmation_unknown',outcome};
  // This fixed HTTPS origin is intentionally not taken from a model or route response.
  // Use plain non-payment-aware Fetch, without ambient credentials or redirects.
  const response=await fetch(url,{method:'GET',redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(10000)});
  if(response.redirected||response.status!==402)throw new Error('seller_challenge_unavailable');
  const chunks:Uint8Array[]=[];let size=0;const reader=response.body?.getReader();
  if(reader)try{for(;;){const x=await reader.read();if(x.done)break;size+=x.value.byteLength;if(size>262144)throw new Error('seller_challenge_too_large');chunks.push(x.value);}}catch(e){await reader.cancel();throw e;}
  const sellerChallenge={status:response.status,bodyText:new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)),
    paymentRequired:response.headers.get('PAYMENT-REQUIRED')??undefined,xPaymentRequired:response.headers.get('X-PAYMENT-REQUIRED')??undefined};
  const sellerResult=await withVerifiedRoute({routeResponseJson:outcome.response.bodyText,routeRequestJson:requestJson,
    trustedLogVkey,request:{url,method:'GET',body:new Uint8Array()},challenge:sellerChallenge},
    action=>buyer.executeSellerOnce(id,action,sellerChallenge));
  return {state:'buyer_executor_returned',outcome,sellerResult};
}
