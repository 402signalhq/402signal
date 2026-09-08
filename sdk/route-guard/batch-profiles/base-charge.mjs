import {uint} from './base.mjs';
const NETWORK='eip155:8453',ASSET='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const check=x=>{if(!x)throw new Error('unsupported_native_base_charge');};
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
function address(x){check(typeof x==='string'&&/^0x[0-9a-fA-F]{40}$/.test(x)&&BigInt(x)>0n);return x.toLowerCase();}
function keys(x,req,opt=[]){check(obj(x)&&req.every(k=>Object.hasOwn(x,k))&&Object.keys(x).every(k=>[...req,...opt].includes(k)));}
export function validateBaseChargeProfile(e,ctx,l){
 keys(l,['network','asset','recipient','max_call_amount_atomic','realm']);keys(e,['amount','currency','recipient','methodDetails'],['description','externalId']);
 check(typeof l.realm==='string'&&l.realm.length>0&&l.realm.length<=256&&l.realm.trim()&&/^[\x20-\x7e]+$/.test(l.realm));
 const d=e.methodDetails;keys(d,['chainId','credentialTypes'],['decimals']);
 check(d.chainId===8453&&Array.isArray(d.credentialTypes)&&d.credentialTypes.length===1&&d.credentialTypes[0]==='authorization'&&(!Object.hasOwn(d,'decimals')||d.decimals===6));
 for(const k of ['description','externalId'])check(!Object.hasOwn(e,k)||typeof e[k]==='string'&&e[k].length<=2048);
 check(ctx.method==='GET'&&l.network===NETWORK&&l.asset===ASSET&&address(e.currency)===ASSET.toLowerCase()&&address(e.recipient)===address(l.recipient)&&uint(e.amount)<=uint(l.max_call_amount_atomic));
 return {network:NETWORK,asset:ASSET,recipient:address(e.recipient),per_call_amount_atomic:e.amount,credential_type:'authorization',intent:'charge'};
}
