/** Explicit native MPP Base USDC authorization. Caller owns durable intent and transport. */
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {Challenge, Credential} from 'mppx';
import {charge} from 'mppx/evm/client';
import {getAddress,keccak256,toBytes} from 'viem';
import {selectNativeCharge} from '../../sdk/route-guard/batch-profiles/native-charge.mjs';
import {verifyBatchRoute} from '../../sdk/route-guard/batch.mjs';
import {validateBaseChargeProfile} from '../../sdk/route-guard/batch-profiles/base-charge.mjs';
const BASE_USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const check=(ok,code='unsupported_native_base_charge')=>{if(!ok)throw new Error(code);};
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const canon=x=>Array.isArray(x)?'['+x.map(canon).join(',')+']':obj(x)?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canon(x[k])).join(',')+'}':JSON.stringify(x);
const eq=(a,b)=>canon(a)===canon(b);
const sha=x=>createHash('sha256').update(x).digest('hex');
const freeze=x=>{if(obj(x)||Array.isArray(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
function address(x){check(typeof x==='string'&&/^0x[0-9a-fA-F]{40}$/.test(x)&&BigInt(x)>0n);return getAddress(x);}
function amount(x){check(typeof x==='string'&&/^[1-9][0-9]{0,77}$/.test(x)&&BigInt(x)<2n**256n);return BigInt(x);}
function keys(x,required,optional=[]){check(obj(x)&&required.every(k=>Object.hasOwn(x,k))&&Object.keys(x).every(k=>[...required,...optional].includes(k)));}
/** No network, signing or payment occurs before the caller's durable authorize callback. */
export function prepareNativeBaseMpp({request,challenge:wire,policy,now=()=>Date.now()}){
 keys(request,['url','method','body']);check(typeof request.url==='string'&&request.body instanceof Uint8Array&&request.body.length<=262144);
 const url=new URL(request.url);check(url.protocol==='https:'&&!url.username&&!url.password&&!url.hash);
 check(['GET','POST'].includes(request.method)&&(request.method!=='GET'||request.body.length===0));
 const snapshot=freeze({url:request.url,method:request.method,bodyBase64:Buffer.from(request.body).toString('base64')});
 keys(wire,['status','wwwAuthenticate'],['bodyText','paymentRequired']);
 check(wire.status===402);
 const retainedWire={status:wire.status,bodyText:wire.bodyText??'',paymentRequired:wire.paymentRequired??null,wwwAuthenticate:wire.wwwAuthenticate};
 keys(policy,['network','asset','recipient','payer','maxAmountAtomic'],['realm','maxAuthorizationSeconds']);
 const recipient=address(policy.recipient),payer=address(policy.payer);
 check(policy.network==='eip155:8453'&&address(policy.asset)===BASE_USDC);
 const max=amount(policy.maxAmountAtomic),horizon=policy.maxAuthorizationSeconds??300;
 check(Number.isSafeInteger(horizon)&&horizon>=1&&horizon<=300);
 const validateOffer=offer=>{
 keys(offer,['amount','currency','recipient','methodDetails'],['description','externalId']);
 const md=offer.methodDetails;keys(md,['chainId','credentialTypes'],['decimals']);
 check(md.chainId===8453&&eq(md.credentialTypes,['authorization'])&&(!Object.hasOwn(md,'decimals')||md.decimals===6));
 check(address(offer.currency)===BASE_USDC&&address(offer.recipient)===recipient&&amount(offer.amount)<=max);
 for(const k of ['description','externalId'])if(Object.hasOwn(offer,k))check(typeof offer[k]==='string'&&offer[k].length<=2048);
 };
 const bodyDigest='sha-256='+createHash('sha256').update(Buffer.from(snapshot.bodyBase64,'base64')).digest('base64');
 const selected=selectNativeCharge(retainedWire,{url:snapshot.url},'evm',policy.realm,validateOffer,bodyDigest);
 const {params}=selected,challenge=Challenge.deserialize(selected.raw);
 check(eq(challenge.request,selected.request)&&challenge.id===params.id&&challenge.realm===params.realm&&challenge.method===params.method&&challenge.intent===params.intent);
 check(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(params.expires));
 const expires=Date.parse(params.expires),initial=now();
 check(Number.isSafeInteger(initial)&&Number.isFinite(expires)&&initial<expires&&expires-initial<=horizon*1000);
 const assertFresh=()=>{const n=now();check(Number.isSafeInteger(n)&&n>=initial&&n<Math.floor(expires/1000)*1000,'expired_native_base_charge');};
 if(params.digest)check(params.digest==='sha-256='+createHash('sha256').update(Buffer.from(snapshot.bodyBase64,'base64')).digest('base64'));
 check(snapshot.method!=='POST'||!!params.digest,'native_post_requires_body_digest');
 const offer=challenge.request;validateOffer(offer);
 const inspection=freeze({protocol:'mpp',method:'evm',intent:'charge',network:'eip155:8453',asset:BASE_USDC,recipient,payer,amountAtomic:offer.amount,expiresAt:expires,request:snapshot,challengeSha256:sha(wire.wwwAuthenticate),responseSha256:sha(canon(retainedWire)),selectedChallengeSha256:sha(selected.raw),selectedChallengeId:params.id});
 const nonce=keccak256(toBytes(challenge.id+challenge.realm));
 // One chain authorization keeps one durable claim even if a header or offer is re-presented.
 const authorizationId=sha(canon({network:'eip155:8453',asset:BASE_USDC,payer,nonce}));let used=false;
 return Object.freeze({inspection,authorizationId,async createCredential({authorize}){
  check(!used,'authorization_already_claimed');used=true;assertFresh();check(typeof authorize==='function','durable_authorization_required');
  const account=await authorize(Object.freeze({authorizationId,inspection}));assertFresh();
  check(obj(account)&&address(account.address)===payer&&typeof account.signTypedData==='function');
  const expected={domain:{name:'USD Coin',version:'2',chainId:8453,verifyingContract:BASE_USDC},message:{from:payer,to:recipient,value:BigInt(offer.amount),validAfter:0n,validBefore:BigInt(Math.floor(expires/1000)),nonce},primaryType:'TransferWithAuthorization',types:{TransferWithAuthorization:[{name:'from',type:'address'},{name:'to',type:'address'},{name:'value',type:'uint256'},{name:'validAfter',type:'uint256'},{name:'validBefore',type:'uint256'},{name:'nonce',type:'bytes32'}]}};
  let signCalls=0;
  const equalTyped=isDeepStrictEqual;
  const method=charge({account:{address:payer,signTypedData:async data=>{
   assertFresh();check(++signCalls===1&&equalTyped(data,expected),'unexpected_signing_effects');
   const signature=await account.signTypedData(data);assertFresh();check(typeof signature==='string'&&/^0x[0-9a-fA-F]{130}$/.test(signature));return signature;
  }},networks:[8453],currencies:[BASE_USDC],authorization:{name:'USD Coin',version:'2'},maxAtomicAmount:policy.maxAmountAtomic});
  const value=await method.createCredential({challenge});assertFresh();check(signCalls===1);
  const credential=Credential.deserialize(value);check(eq(credential.challenge,challenge));
  check(credential.source===`did:pkh:eip155:8453:${payer}`);
  const payload=credential.payload;keys(payload,['from','to','value','validAfter','validBefore','nonce','signature','type']);
  check(payload.type==='authorization'&&payload.from===payer&&payload.to===recipient&&payload.value===offer.amount&&payload.validAfter==='0'&&payload.validBefore===String(Math.floor(expires/1000))&&payload.nonce===expected.message.nonce);
  return freeze({authorizationId,headerName:params.header??'Authorization',headerValue:value,request:snapshot,inspection});
 }});
}

/** First verify the signed GET observation and exact fresh seller challenge. */
export function prepareVerifiedNativeBaseMpp({routeEvidence,...options}){
 const now=options.now??(()=>Date.now());
 const bound=verifyBatchRoute({...routeEvidence,now:Math.floor(now()/1000)});
 check(bound.profile==='base-mpp-charge-v1'&&options.request.method==='GET'&&options.request.body.length===0&&bound.request.url===options.request.url,'native_observation_request_mismatch');
 check(eq(bound.challenge,{status:options.challenge.status,bodyText:options.challenge.bodyText??'',paymentRequired:options.challenge.paymentRequired??null,wwwAuthenticate:options.challenge.wwwAuthenticate}),'native_observation_challenge_mismatch');
 const selected=selectNativeCharge(bound.challenge,bound.request,'evm',bound.buyer_limits.realm,e=>validateBaseChargeProfile(e,bound.request,bound.buyer_limits));
 const result=prepareNativeBaseMpp({...options,now});
 check(result.inspection.selectedChallengeSha256===sha(selected.raw),'native_observation_selection_mismatch');
 check(bound.terms.per_call_amount_atomic===result.inspection.amountAtomic&&bound.terms.recipient.toLowerCase()===result.inspection.recipient.toLowerCase(),'native_observation_terms_mismatch');
 return result;
}
