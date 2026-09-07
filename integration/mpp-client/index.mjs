/** Explicit mppx interoperability for existing Base USDC x402 exact payments.
 * No wallet creation, automatic fetch, RPC, broadcast or payment retry API.
 */
import {createHash} from 'node:crypto';
import {Mppx} from 'mppx/client';
import {charge} from 'mppx/evm/client';
import {getAddress} from 'viem';
import {parse} from '../../sdk/route-guard/internal-json.mjs';

export const BASE_NETWORK = 'eip155:8453';
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const MAX = 262144;
const HEADER_MAX = 32768;
const own = Object.hasOwn;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export class MppInteropError extends Error {
  constructor(code) {super(code);this.name='MppInteropError';this.code=code;}
}
const check = (condition, code) => {if(!condition)throw new MppInteropError(code);};
const canonical = value => {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(object(value))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
  return JSON.stringify(value);
};
const same = (a,b) => canonical(a)===canonical(b);
function freeze(value) {
  if(value&&typeof value==='object'){for(const v of Object.values(value))freeze(v);Object.freeze(value);}
  return value;
}
function strictJson(raw, limit=MAX) {
  try{return parse(raw,{ordinaryNumbers:true,limit});}catch{throw new MppInteropError('invalid_challenge_json');}
}
function address(value) {
  try{return getAddress(value);}catch{throw new MppInteropError('invalid_payment_address');}
}
function decodeHeader(value) {
  check(typeof value==='string'&&value.length>0&&value.length<=HEADER_MAX&&/^[A-Za-z0-9+/]+={0,2}$/.test(value),'invalid_payment_required');
  const bytes=Buffer.from(value,'base64');
  const withoutPadding = text => {const end=text.indexOf('=');return end<0?text:text.slice(0,end);};
  check(withoutPadding(bytes.toString('base64'))===withoutPadding(value),'invalid_payment_required');
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new MppInteropError('invalid_payment_required');}
  return strictJson(text,HEADER_MAX);
}
function snapshotRequest(request) {
  check(object(request)&&typeof request.url==='string','invalid_request');
  let url;try{url=new URL(request.url);}catch{throw new MppInteropError('invalid_request');}
  check(url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&url.href===request.url,'invalid_request');
  check(['GET','POST'].includes(request.method)&&request.body instanceof Uint8Array&&request.body.byteLength<=MAX,'invalid_request');
  check(request.method!=='GET'||request.body.byteLength===0,'invalid_request');
  return freeze({url:request.url,method:request.method,bodyBase64:Buffer.from(request.body).toString('base64')});
}
function resourceMatches(resource,request) {
  return resource===request.url||(request.method==='GET'&&request.bodyBase64===''
    &&new URL(request.url).search!==''&&resource===request.url.slice(0,request.url.indexOf('?')));
}
function normalizedAccept(value) {
  check(object(value),'unsupported_offer');
  const allowed=['scheme','network','asset','currency','amount','payTo','maxTimeoutSeconds','extra'];
  check(Object.keys(value).every(key=>allowed.includes(key)),'unsupported_offer_fields');
  check(value.scheme==='exact'&&value.network===BASE_NETWORK&&address(value.asset)===BASE_USDC,'unsupported_payment_method');
  check(!own(value,'currency')||address(value.currency)===BASE_USDC,'unsupported_currency');
  check(typeof value.amount==='string'&&/^[1-9][0-9]{0,77}$/.test(value.amount)&&BigInt(value.amount)<2n**256n,'invalid_amount');
  check(Number.isSafeInteger(value.maxTimeoutSeconds)&&value.maxTimeoutSeconds>=1&&value.maxTimeoutSeconds<=300,'unsupported_timeout');
  check(object(value.extra)&&value.extra.name==='USD Coin'&&value.extra.version==='2','unsupported_token_domain');
  check(!own(value.extra,'assetTransferMethod')||value.extra.assetTransferMethod==='eip3009','unsupported_transfer_method');
  address(value.payTo);
  const {currency,...accepted}=value;
  return accepted;
}
const TRANSFER_TYPES = {TransferWithAuthorization:[
  {name:'from',type:'address'},{name:'to',type:'address'},{name:'value',type:'uint256'},
  {name:'validAfter',type:'uint256'},{name:'validBefore',type:'uint256'},{name:'nonce',type:'bytes32'},
]};
function validateTypedData(data, expected, timeout) {
  check(object(data)&&data.primaryType==='TransferWithAuthorization'&&same(data.types,TRANSFER_TYPES),'unexpected_typed_data');
  check(same(data.domain,{chainId:8453,name:'USD Coin',verifyingContract:BASE_USDC,version:'2'}),'unexpected_typed_domain');
  const message=data.message;
  check(object(message)&&Object.keys(message).sort().join(',')==='from,nonce,to,validAfter,validBefore,value','unexpected_authorization');
  check(address(message.from)===expected.payer&&address(message.to)===expected.recipient&&message.value===BigInt(expected.amountAtomic),'unexpected_authorization');
  const now=BigInt(Math.floor(Date.now()/1000));
  check(typeof message.validAfter==='bigint'&&typeof message.validBefore==='bigint'
    &&message.validAfter>=now-605n&&message.validAfter<=now&&message.validBefore>now
    &&message.validBefore<=now+BigInt(timeout)+1n&&/^0x[0-9a-f]{64}$/.test(message.nonce),'unexpected_authorization');
}

/** Pure selection and snapshots. No account or signing capability is accepted.
 * authorize() is an explicit execution gate, not an mppx observational hook.
 * It must validate caller policy/proof and durably claim the job before returning
 * a sign-only account. That account must persist exact typed data before signing.
 */
export async function prepareBaseX402({request,challenge,expected}) {
  const savedRequest=snapshotRequest(request);
  check(object(expected)&&typeof expected.amountAtomic==='string','explicit_payment_policy_required');
  const policy=freeze({amountAtomic:expected.amountAtomic,recipient:address(expected.recipient),payer:address(expected.payer)});
  check(object(challenge)&&challenge.status===402&&typeof challenge.bodyText==='string'
    &&Buffer.byteLength(challenge.bodyText)<=MAX,'invalid_challenge');
  check(Object.keys(challenge).every(key=>['status','bodyText','paymentRequired','wwwAuthenticate','xPaymentRequired'].includes(key)),'unsupported_challenge_fields');
  check(!challenge.wwwAuthenticate,'native_mpp_unsupported');
  const envelope=decodeHeader(challenge.paymentRequired);
  check(object(envelope)&&envelope.x402Version===2&&object(envelope.resource)
    &&resourceMatches(envelope.resource.url,savedRequest)&&Array.isArray(envelope.accepts)
    &&envelope.accepts.length>=1&&envelope.accepts.length<=16,'invalid_challenge');
  if(challenge.xPaymentRequired!==undefined&&challenge.xPaymentRequired!==null)
    check(same(decodeHeader(challenge.xPaymentRequired),envelope),'challenge_channels_disagree');
  if(challenge.bodyText.trim())check(same(strictJson(challenge.bodyText),envelope),'challenge_channels_disagree');
  check(!envelope.extensions?.mppx,'mppx_nonce_extension_unsupported');
  // mppx discards empty discovery markers; preserve them in the final wire.
  const normalizedExtensions=envelope.extensions?Object.fromEntries(Object.entries(envelope.extensions)
    .filter(([,value])=>!(object(value)&&Object.keys(value).length===0))):undefined;
  const expectedExtensions=normalizedExtensions&&Object.keys(normalizedExtensions).length?normalizedExtensions:undefined;
  const matches=[];
  for(let index=0;index<envelope.accepts.length;index++) {
    const row=envelope.accepts[index];
    if(row?.network!==BASE_NETWORK||row?.scheme!=='exact')continue;
    const accepted=normalizedAccept(row);
    if(accepted.amount===policy.amountAtomic&&address(accepted.payTo)===policy.recipient)matches.push({index,accepted});
  }
  check(matches.length===1,'payment_policy_mismatch');
  const {index,accepted}=matches[0];
  const observedAt=Date.now();
  const expiresAt=observedAt+Math.min(60000,accepted.maxTimeoutSeconds*1000);
  const intent=freeze({version:1,protocol:'x402-v2',network:BASE_NETWORK,asset:BASE_USDC,
    request:savedRequest,challenge:envelope,selectedIndex:index,expected:policy,observedAt,expiresAt});
  const inspection=freeze({...intent,intentDigest:createHash('sha256').update(canonical(intent)).digest('hex')});
  // A known non-paying transport. This adapter never exposes either fetch API.
  const noTransport=async()=>{throw new MppInteropError('transport_not_exposed');};
  const client=Mppx.create({polyfill:false,fetch:noTransport,acceptPaymentPolicy:'never',
    methods:[charge({account:{address:policy.payer},networks:[8453],currencies:[BASE_USDC],maxAtomicAmount:policy.amountAtomic})]});
  check(client.rawFetch===noTransport,'unexpected_transport');
  const prepared=await client.preparePayment(new Response(null,{status:402,headers:{'PAYMENT-REQUIRED':challenge.paymentRequired}}),{
    request:{method:savedRequest.method},orderChallenges:candidates=>candidates.filter(candidate=>candidate.challenge.id===`x402:${index}`),
  });
  check(prepared.method.name==='evm'&&prepared.method.intent==='charge'&&prepared.challenge.id===`x402:${index}`,'unexpected_method');
  check(same(prepared.challenge.request,{...accepted,resource:envelope.resource,
    ...(expectedExtensions?{extensions:expectedExtensions}:{})}),'normalization_changed_offer');
  let consumed=false;
  return Object.freeze({inspection,async createPaymentPayload({authorize}) {
    check(!consumed,'credential_attempt_consumed');consumed=true;
    check(typeof authorize==='function','durable_authorization_gate_required');
    check(Date.now()>=observedAt&&Date.now()<expiresAt,'offer_expired');
    let permit;
    try{permit=await authorize(inspection);}catch{throw new MppInteropError('authorization_gate_unavailable');}
    if(permit===false||permit===null)return Object.freeze({status:'declined',newPaymentAllowed:false});
    check(Date.now()>=observedAt&&Date.now()<expiresAt,'offer_expired');
    check(object(permit)&&object(permit.account)&&address(permit.account.address)===policy.payer
      &&typeof permit.account.signTypedData==='function','guarded_account_required');
    let signed=false;
    const signTypedData=permit.account.signTypedData.bind(permit.account);
    const account=Object.freeze({address:policy.payer,async signTypedData(data) {
      check(!signed,'multiple_signatures_refused');signed=true;
      validateTypedData(data,policy,accepted.maxTimeoutSeconds);
      return signTypedData(data);
    }});
    let credential;
    try{credential=await prepared.createCredential({account});}catch{throw new MppInteropError('credential_outcome_unknown');}
    check(signed,'signature_missing');
    const paymentPayload=decodeHeader(credential);
    check(paymentPayload.x402Version===2&&same(paymentPayload.accepted,accepted)
      &&same(paymentPayload.resource,envelope.resource)&&same(paymentPayload.extensions??null,expectedExtensions??null),'unexpected_credential');
    if(envelope.extensions){paymentPayload.extensions=envelope.extensions;credential=Buffer.from(JSON.stringify(paymentPayload)).toString('base64');}
    const attached=prepared.setCredential({headers:{}},credential);
    const headers=new Headers(attached.headers);
    check(headers.get('PAYMENT-SIGNATURE')===credential&&[...headers].length===1,'unexpected_credential_transport');
    // The caller must durably save this complete payload before its one allowed
    // transmission. No transmission or automatic recovery is performed here.
    return freeze({status:'credential_created',paymentPayload,
      header:{name:'PAYMENT-SIGNATURE',value:credential},intentDigest:inspection.intentDigest,
      newPaymentAllowed:false,chainConfirmation:'not_checked'});
  }});
}
