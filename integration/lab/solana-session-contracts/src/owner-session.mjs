import {createHash} from 'node:crypto';
import {Challenge} from 'mppx';
import {buildOpenPaymentChannelTransaction,ActiveSession,serializeSessionCredential,PENDING_SERVER_SIGNATURE,voucherMessageBytes} from '@solana/mpp/client';
import {createNoopSigner,getTransactionDecoder,getCompiledTransactionMessageDecoder,getBase58Encoder,getBase58Decoder} from '@solana/kit';
import {parse} from '../../sdk/route-guard/internal-json.mjs';
const channelHelpers=await import(new URL('./server/session/on-chain.js',import.meta.resolve('@solana/mpp')));
const codecs=await import(new URL('./generated/payment-channels/accounts/channel.js',import.meta.resolve('@solana/mpp')));
export const SOLANA_SESSION_PROGRAM='CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX';
export const SOLANA_USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// RPC returns the full genesis hash; CAIP-2 uses its truncated chain reference.
export const SOLANA_GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const check=(v,m)=>{if(!v)throw Error(m);};
const json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v);
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const sha=x=>createHash('sha256').update(x).digest('hex');
const bytes=x=>Buffer.from(x).toString('base64');
const uint=x=>{check(typeof x==='string'&&/^[1-9][0-9]{0,19}$/.test(x)&&BigInt(x)<2n**64n,'invalid atomic');return BigInt(x);};
const address=x=>{check(typeof x==='string'&&getBase58Encoder().encode(x).length===32,'invalid address');return x;};
const txDecode=wire=>getTransactionDecoder().decode(Buffer.from(wire,'base64'));
function nativeChallenge(raw){
 check(typeof raw==='string'&&raw.length<=16384&&raw.startsWith('Payment ')&&!raw.includes(String.fromCharCode(92)),'invalid session challenge');
 const attrs={};for(const part of raw.slice(8).split(', ')){const m=/^([A-Za-z]+)="([^"]*)"$/.exec(part);check(m&&!Object.hasOwn(attrs,m[1]),'ambiguous challenge');attrs[m[1]]=m[2];}
 check(Object.keys(attrs).every(k=>['id','realm','method','intent','request','expires','description','digest','opaque'].includes(k)),'unsupported challenge field');
 check(attrs.method==='solana'&&attrs.intent==='session'&&attrs.expires&&attrs.request,'wrong protocol');
 const decoded=parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(attrs.request,'base64url')),{ordinaryNumbers:true,limit:16384});
 const challenge=Challenge.deserialize(raw);check(json(decoded)===json(challenge.request),'normalization changed request');return challenge;
}
/** Pure unsigned preparation. Operator pays native fees/rent; no RPC fallback,
 * ephemeral key generation, Fetch patching, permit/delegation or automatic open.
 */
export async function prepareSolanaSession({wwwAuthenticate,request,policy}){
 const challenge=nativeChallenge(wwwAuthenticate),r=challenge.request,p=JSON.parse(json(policy));
 check(r.network==='mainnet'&&r.currency===SOLANA_USDC&&r.decimals===6&&r.programId===SOLANA_SESSION_PROGRAM,'unsupported session network/token/program');
 check(!r.modes||r.modes.length===0||json(r.modes)===json(['push']),'push only');
 check(!r.pullVoucherStrategy&&(!r.splits||r.splits.length===0),'delegation/splits refused');
 check(Object.keys(r).every(k=>['cap','currency','decimals','description','externalId','minVoucherDelta','modes','network','operator','programId','recentBlockhash','recentSlot','recipient','splits'].includes(k)),'unreviewed session terms');
 for(const k of ['payer','operator','recipient','programDataAddress'])address(p[k]);
 check(/^[0-9a-f]{64}$/.test(p.programDataSha256)&&uint(p.maximumOperatorOpenLamports)>0n,'reviewed deployment and operator budget required');
 check(p.operator===r.operator&&p.recipient===r.recipient&&p.payer!==p.operator&&p.payer!==p.recipient,'party mismatch');
 check(uint(p.depositAtomic)<=uint(r.cap)&&uint(r.cap)<=uint(p.maxSessionAtomic),'session capital cap');
 check(r.minVoucherDelta===undefined||uint(r.minVoucherDelta)<=uint(p.depositAtomic),'minimum increment exceeds capital');
 check(p.gracePeriod===900&&Number.isSafeInteger(p.voucherExpiresAt)&&p.voucherExpiresAt>Math.floor(Date.now()/1000)+900&&p.voucherExpiresAt<=Math.floor(Date.now()/1000)+86400,'explicit voucher lifetime required');
 check(typeof r.recentSlot==='string'&&/^[1-9][0-9]{0,19}$/.test(r.recentSlot)&&BigInt(r.recentSlot)<2n**64n,'fresh open slot required');address(r.recentBlockhash);uint(p.salt);
 const url=new URL(request.url);check(url.protocol==='https:'&&url.href===request.url&&challenge.realm===url.host&&!url.username&&!url.password&&!url.hash&&['GET','POST'].includes(request.method)&&/^[0-9a-f]{64}$/.test(request.digest),'exact request required');
 const now=Date.now(),expiresAt=Math.min(Date.parse(challenge.expires),now+60000);check(Number.isFinite(expiresAt)&&expiresAt>now,'challenge expired');
 const parameters={request:r,signer:createNoopSigner(p.payer),authorizedSigner:p.payer,deposit:p.depositAtomic,gracePeriod:p.gracePeriod,salt:p.salt};
 const open=await buildOpenPaymentChannelTransaction(parameters),tx=txDecode(open.transaction),message=getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
 check(message.staticAccounts[0]===p.operator&&message.header.numSignerAccounts===2&&message.instructions.length===1&&!message.addressTableLookups?.length,'unexpected transaction shape');
 check(message.staticAccounts[message.instructions[0].programAddressIndex]===SOLANA_SESSION_PROGRAM&&Object.values(tx.signatures).every(s=>s===null),'unexpected signing or instruction');
 const value={version:1,rawChallenge:wwwAuthenticate,challenge,request,policy:p,open,messageBase64:bytes(tx.messageBytes),observedAt:now,expiresAt};
 return freeze({...value,intentDigest:sha(json(value))});
}
export async function quoteSolanaSessionRent(rpc){
 const [channel,escrow]=await Promise.all([rpc('getMinimumBalanceForRentExemption',[codecs.getChannelDecoder().fixedSize,{commitment:'finalized'}]),rpc('getMinimumBalanceForRentExemption',[165,{commitment:'finalized'}])]);
 check(Number.isSafeInteger(channel)&&Number.isSafeInteger(escrow)&&channel>0&&escrow>0,'invalid rent quote');
 return {channelBytes:codecs.getChannelDecoder().fixedSize,escrowBytes:165,operatorRentLamports:String(BigInt(channel)+BigInt(escrow)),buyerRentLamports:'0',transactionFeeLamports:'requires prepared-message quote',rentReturn:'escrow at distribution; channel PDA may need later reclaim'};
}
/** Inject an owner-controlled durable ledger implementing bind/once/require/
 * transition; PostgreSQL BaseBatchLedger is one compatible implementation.
 */
export class OwnerSessionController {
 constructor(ledger,plan){this.ledger=ledger;this.plan=freeze(JSON.parse(json(plan)));}
 async initialize(){await this.ledger.initialize();await this.ledger.bind(this.plan);await this.ledger.once('progress',{state:'new'});}
 fresh(){check(Date.now()>=this.plan.observedAt&&Date.now()<this.plan.expiresAt,'original observation expired');}
 async signOpen(owner,rpc){
  this.fresh();const p=this.plan;check(owner.address===p.policy.payer&&typeof owner.signTransactions==='function','owner transaction signer required');
  check(typeof rpc==='function','read-only deployment preflight required');
  await verifySolanaSessionDeployment(rpc,p);this.fresh();
  await this.ledger.transition('new','open-signing');let calls=0;const bound=owner.signTransactions.bind(owner);
  const guarded={address:owner.address,signTransactions:async(txs,...rest)=>{this.fresh();check(++calls===1&&txs.length===1&&bytes(txs[0].messageBytes)===p.messageBase64,'unexpected transaction authority');check(await this.ledger.once('open:sign-intent',{messageBase64:p.messageBase64}),'signing already claimed');return bound(txs,...rest);}};
  const open=await buildOpenPaymentChannelTransaction({request:p.challenge.request,signer:guarded,authorizedSigner:p.policy.payer,deposit:p.policy.depositAtomic,gracePeriod:p.policy.gracePeriod,salt:p.policy.salt});
  check(calls===1&&bytes(txDecode(open.transaction).messageBytes)===p.messageBase64,'signed message changed');
  const payload={action:'open',authorizedSigner:p.policy.payer,mode:'push',channelId:open.channelId,deposit:open.deposit,gracePeriod:open.gracePeriod,mint:open.mint,payee:open.payee,payer:open.payer,recentSlot:open.openSlot,salt:open.salt,signature:PENDING_SERVER_SIGNATURE,transaction:open.transaction};
  const result={payload,authorization:serializeSessionCredential({challenge:p.challenge,payload})};await this.ledger.once('open:credential',result);await this.ledger.transition('open-signing','open-ready');return result;
 }
 async sendOpen(send){this.fresh();await this.ledger.transition('open-ready','open-inflight');const credential=freeze(await this.ledger.require('open:credential'));try{const result=await send(credential);check(typeof result.reference==='string'&&getBase58Encoder().encode(result.reference).length===64,'missing existing transaction');await this.ledger.once('open:ack',{transactionSignature:result.reference});return {state:'provider_ack'};}catch{return {state:'unknown',newPaymentAllowed:false};}}
 async confirmOpen(rpc,signature){
  const existing=await this.ledger.get('open:confirmed');if(existing){check(existing.state==='chain_confirmed'&&(!signature||signature===existing.transactionSignature),'confirmation conflicts');if((await this.ledger.require('progress')).state==='open-inflight')await this.ledger.transition('open-inflight','active:0');return existing;}
  check((await this.ledger.require('progress')).state==='open-inflight','open not sent');
  signature??=(await this.ledger.require('open:ack')).transactionSignature;
  const observed=await observeSolanaOpen(rpc,this.plan,signature);if(observed.state!=='chain_confirmed')return observed;
  await this.ledger.once('open:confirmed',observed);await this.ledger.transition('open-inflight','active:0');return observed;
 }
 async voucher(owner,sequence,increment,send){
  this.fresh();check(owner.address===this.plan.policy.payer&&typeof owner.signMessages==='function'&&Number.isInteger(sequence)&&sequence>=1&&sequence<=64,'voucher owner/bound');
  const before=sequence===1?0n:BigInt((await this.ledger.require('voucher:'+ (sequence-1)+':accepted')).cumulative);
  const cap=before+uint(increment);check(cap<=BigInt(this.plan.policy.depositAtomic),'voucher exceeds deposit');
  await this.ledger.transition('active:'+(sequence-1),'voucher-inflight:'+sequence);let calls=0;const bound=owner.signMessages.bind(owner),p=this.plan;
  const expected={channelId:p.open.channelId,cumulativeAmount:cap.toString(),expiresAt:p.policy.voucherExpiresAt};
  const signer={address:owner.address,signMessages:async(messages,...rest)=>{this.fresh();check(++calls===1&&messages.length===1&&bytes(messages[0].content)===bytes(voucherMessageBytes(expected)),'unexpected voucher bytes');check(await this.ledger.once('voucher:'+sequence+':sign-intent',expected),'voucher already signed');return bound(messages,...rest);}};
  const session=new ActiveSession({channelId:p.open.channelId,cumulative:before,expiresAt:p.policy.voucherExpiresAt,signer});const voucher=await session.prepareIncrement(BigInt(increment));
  const payload={action:'voucher',voucher},credential={payload,authorization:serializeSessionCredential({challenge:p.challenge,payload})};await this.ledger.once('voucher:'+sequence+':credential',credential);
  try{const ack=await send(freeze(credential));check(ack.reference===p.open.channelId+':'+cap,'voucher acknowledgement mismatch');await this.ledger.once('voucher:'+sequence+':accepted',{cumulative:cap.toString()});await this.ledger.transition('voucher-inflight:'+sequence,'active:'+sequence);return {state:'voucher_accepted',chainSettled:false};}catch{return {state:'unknown',newPaymentAllowed:false};}
 }
 async recoverVoucher(sequence,recover){
  check(Number.isInteger(sequence)&&sequence>=1&&sequence<=64,'recovery sequence refused');
  const stage='voucher:'+sequence,credential=await this.ledger.require(stage+':credential');
  const intent=await this.ledger.require(stage+':sign-intent'),cap=intent.cumulativeAmount;
  check(intent.channelId===this.plan.open.channelId&&credential.payload?.voucher?.data?.cumulativeAmount===cap&&BigInt(cap)<=BigInt(this.plan.policy.depositAtomic),'saved voucher mismatch');
  const previous=sequence===1?'0':(await this.ledger.require('voucher:'+(sequence-1)+':accepted')).cumulative;check(BigInt(cap)>BigInt(previous),'recovery cumulative bounds');
  const prior=await this.ledger.get(stage+':accepted'),state=(await this.ledger.require('progress')).state;
  if(prior){check(prior.cumulative===cap,'accepted voucher mismatch');if(state==='voucher-inflight:'+sequence)await this.ledger.transition(state,'active:'+sequence);return {state:'voucher_accepted',chainSettled:false};}
  check(state==='voucher-inflight:'+sequence,'voucher recovery requires unresolved send');
  const authorizationDigest=sha(credential.authorization);let attempt;
  for(let n=1;n<=6;n++)if(await this.ledger.once(stage+':recovery:'+n,{authorizationDigest})){attempt=stage+':recovery:'+n;break;}
  check(attempt,'merchant recovery limit reached');
  try{
   const result=JSON.parse(json(await recover(JSON.parse(json(credential)))));
   check(result.recoveryOnly===true&&result.url===this.plan.request.url&&result.authorizationDigest===authorizationDigest&&typeof result.bodyText==='string'&&result.evidenceDigest===sha(json({url:this.plan.request.url,status:200,bodyText:result.bodyText,authorizationDigest}))&&json(result.body)===json(JSON.parse(result.bodyText))&&result.body?.reference===this.plan.open.channelId+':'+cap&&result.body.chargedCumulativeAmount===cap&&result.body.chargedAmount===(BigInt(cap)-BigInt(previous)).toString()&&result.body.chainSettled===false,'recovery receipt mismatch');
   await this.ledger.once(attempt+':evidence',result);await this.ledger.once(stage+':accepted',{cumulative:cap});
   const current=(await this.ledger.require('progress')).state;if(current==='voucher-inflight:'+sequence)await this.ledger.transition(current,'active:'+sequence);
   check((await this.ledger.get(stage+':accepted'))?.cumulative===cap,'recovery not retained');
   return {state:'voucher_accepted',chainSettled:false};
  }catch{return {state:'unknown',newPaymentAllowed:false};}
 }
 async close(sequence,send){check(Number.isInteger(sequence)&&sequence>=1&&sequence<=64,'close sequence');await this.ledger.transition('active:'+sequence,'close-inflight');const prior=await this.ledger.require('voucher:'+sequence+':credential'),p=this.plan;const payload={action:'close',channelId:p.open.channelId,voucher:prior.payload.voucher};const credential={payload,authorization:serializeSessionCredential({challenge:p.challenge,payload})};await this.ledger.once('close:credential',credential);try{const ack=await send(freeze(credential));check(typeof ack.reference==='string'&&getBase58Encoder().encode(ack.reference).length===64,'close transaction missing');await this.ledger.once('close:ack',ack);return {state:'provider_ack',chainSettled:false};}catch{return {state:'unknown',newPaymentAllowed:false};}}
 async confirmClose(rpc,signature){const existing=await this.ledger.get('close:confirmed');if(existing){check(existing.state==='chain_confirmed'&&(!signature||signature===existing.transactionSignature),'confirmation conflicts');if((await this.ledger.require('progress')).state==='close-inflight')await this.ledger.transition('close-inflight','closed');return existing;}check((await this.ledger.require('progress')).state==='close-inflight','close not sent');const credential=await this.ledger.require('close:credential');const observed=await observeSolanaClose(rpc,this.plan,signature,credential.payload.voucher);if(observed.state==='chain_confirmed'){await this.ledger.once('close:confirmed',observed);await this.ledger.transition('close-inflight','closed');}return observed;}
}
/** Actual transaction bytes, token deltas and generated account decoder must
 * agree. A bare successful signature or local SDK session flag is insufficient.
 */
export async function observeSolanaOpen(rpc,plan,signature){
 try{
  check(getBase58Encoder().encode(signature).length===64,'signature');check(await rpc('getGenesisHash',[])===SOLANA_GENESIS,'chain');
  const tx=await rpc('getTransaction',[signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);
  check(tx&&tx.meta&&tx.meta.err===null&&Number.isSafeInteger(tx.slot)&&tx.slot>=Number(plan.open.openSlot),'transaction');
  const decoded=txDecode(tx.transaction[0]);check(decoded.signatures[plan.policy.operator]&&getBase58Decoder().decode(decoded.signatures[plan.policy.operator])===signature,'transaction signature mismatch');check(bytes(decoded.messageBytes)===plan.messageBase64,'message mismatch');
  const message=getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);const payerIndex=message.staticAccounts.indexOf(plan.policy.payer);
  check(tx.meta.preBalances[payerIndex]===tx.meta.postBalances[payerIndex],'unexpected buyer native debit');
  const balances=(rows,owner)=>rows.filter(x=>x.owner===owner&&x.mint===SOLANA_USDC).reduce((sum,x)=>sum+BigInt(x.uiTokenAmount.amount),0n);
  check(balances(tx.meta.postTokenBalances,plan.policy.payer)-balances(tx.meta.preTokenBalances,plan.policy.payer)===-BigInt(plan.open.deposit),'token debit');
  check(balances(tx.meta.postTokenBalances,plan.open.channelId)-balances(tx.meta.preTokenBalances,plan.open.channelId)===BigInt(plan.open.deposit),'escrow credit');
  const response=await rpc('getAccountInfo',[plan.open.channelId,{encoding:'base64',commitment:'finalized',minContextSlot:tx.slot}]);
  check(response?.context?.slot>=tx.slot&&response.value?.owner===SOLANA_SESSION_PROGRAM&&!response.value.executable,'channel owner');
  const raw=Buffer.from(response.value.data[0],'base64');check(raw.length===codecs.getChannelDecoder().fixedSize,'channel size');const c=codecs.getChannelDecoder().decode(raw),p=plan.policy;
  check(c.discriminator===0&&c.status===0&&c.payer===p.payer&&c.payee===p.recipient&&c.authorizedSigner===p.payer&&c.rentPayer===p.operator&&c.mint===SOLANA_USDC&&c.deposit===BigInt(p.depositAtomic)&&c.salt===BigInt(p.salt)&&c.openSlot===BigInt(plan.open.openSlot)&&c.gracePeriod===900&&c.settlement.settled===0n&&c.settlement.payoutWatermark===0n,'channel fields');
  return {state:'chain_confirmed',transactionSignature:signature,slot:tx.slot,evidenceDigest:sha(json({planDigest:plan.intentDigest,tx,channel:response})),channel:JSON.parse(json(c))};
 }catch{return {state:'unknown',newPaymentAllowed:false};}
}

/** Checks the real SDK's exact Ed25519 + settle_and_seal + distribute sequence,
 * buyer refund and merchant payout. Program-account rent reclamation is tracked
 * separately when the channel is still retained for the anti-replay window.
 */
export async function observeSolanaClose(rpc,plan,signature,voucher){
 try{
  check(getBase58Encoder().encode(signature).length===64&&await rpc('getGenesisHash',[])===SOLANA_GENESIS,'chain/signature');
  const tx=await rpc('getTransaction',[signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);check(tx?.meta?.err===null&&Number.isSafeInteger(tx.slot),'transaction');
  const decoded=txDecode(tx.transaction[0]),message=getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
  check(message.staticAccounts[0]===plan.policy.operator&&decoded.signatures[plan.policy.operator]&&getBase58Decoder().decode(decoded.signatures[plan.policy.operator])===signature&&!message.addressTableLookups?.length,'fee payer/signature');
  const settlement=channelHelpers.buildSettleAndSealInstructions({channelId:plan.open.channelId,merchantSigner:createNoopSigner(plan.policy.recipient),programId:SOLANA_SESSION_PROGRAM,...(voucher?{voucher:{authorizedSigner:plan.policy.payer,signed:voucher}}:{})});
  const distribute=await channelHelpers.buildDistributeInstruction({channelState:{channelId:plan.open.channelId,payee:plan.policy.recipient,payer:plan.policy.payer},mint:SOLANA_USDC,programId:SOLANA_SESSION_PROGRAM,rentPayer:plan.policy.operator,splits:[],tokenProgram:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'});
  const expected=[...settlement.instructions,distribute];check(message.instructions.length===expected.length,'instruction count');
  message.instructions.forEach((ix,i)=>{const e=expected[i];check(message.staticAccounts[ix.programAddressIndex]===e.programAddress&&bytes(ix.data)===bytes(e.data)&&json((ix.accountIndices??[]).map(n=>message.staticAccounts[n]))===json((e.accounts??[]).map(a=>a.address)),'instruction mismatch');});
  const cumulative=voucher?BigInt(voucher.data.cumulativeAmount):0n,refund=BigInt(plan.open.deposit)-cumulative;check(cumulative>=0n&&refund>=0n,'payout bounds');
  const balances=(rows,owner)=>rows.filter(x=>x.owner===owner&&x.mint===SOLANA_USDC).reduce((sum,x)=>sum+BigInt(x.uiTokenAmount.amount),0n);
  const delta=owner=>balances(tx.meta.postTokenBalances,owner)-balances(tx.meta.preTokenBalances,owner);
  check(delta(plan.policy.payer)===refund&&delta(plan.policy.recipient)===cumulative&&delta(plan.open.channelId)===-BigInt(plan.open.deposit),'payout/refund mismatch');
  const payerIndex=message.staticAccounts.indexOf(plan.policy.payer);check(tx.meta.preBalances[payerIndex]===tx.meta.postBalances[payerIndex],'unexpected buyer native debit');
  const response=await rpc('getAccountInfo',[plan.open.channelId,{encoding:'base64',commitment:'finalized',minContextSlot:tx.slot}]);check(response?.context?.slot>=tx.slot,'state lag');
  if(response.value){check(response.value.owner===SOLANA_SESSION_PROGRAM&&!response.value.executable,'channel owner');const raw=Buffer.from(response.value.data[0],'base64');check(raw.length===codecs.getChannelDecoder().fixedSize,'channel size');const c=codecs.getChannelDecoder().decode(raw);check(c.status===3&&c.payer===plan.policy.payer&&c.payee===plan.policy.recipient&&c.authorizedSigner===plan.policy.payer&&c.mint===SOLANA_USDC&&c.settlement.settled===cumulative&&c.settlement.payoutWatermark===cumulative,'channel not distributed');}
  return {state:'chain_confirmed',transactionSignature:signature,slot:tx.slot,merchantAtomic:cumulative.toString(),returnedBuyerAtomic:refund.toString(),channelRent:response.value?'reclaim_pending':'account_deallocated',evidenceDigest:sha(json({planDigest:plan.intentDigest,tx,channel:response}))};
 }catch{return {state:'unknown',newPaymentAllowed:false};}
}

/** Read-only pre-sign check of the upgradeable program identity, fresh channel,
 * payer balance and the operator's explicitly capped rent plus network fee.
 * A program-data hash is an operator-reviewed deployment pin, not a source audit.
 */
export async function verifySolanaSessionDeployment(rpc,plan){
 check(await rpc('getGenesisHash',[])===SOLANA_GENESIS,'wrong chain');
 const loader='BPFLoaderUpgradeab1e11111111111111111111111';
 const [program,data,channel]=await Promise.all([rpc('getAccountInfo',[SOLANA_SESSION_PROGRAM,{encoding:'base64',commitment:'finalized'}]),rpc('getAccountInfo',[plan.policy.programDataAddress,{encoding:'base64',commitment:'finalized'}]),rpc('getAccountInfo',[plan.open.channelId,{encoding:'base64',commitment:'finalized'}])]);
 check(program?.value?.executable&&program.value.owner===loader&&data?.value?.owner===loader&&!data.value.executable&&!channel.value,'deployed program/fresh channel required');
 const raw=Buffer.from(program.value.data[0],'base64'),programData=Buffer.from(data.value.data[0],'base64');
 check(raw.length===36&&raw.readUInt32LE(0)===2&&getBase58Decoder().decode(raw.subarray(4))===plan.policy.programDataAddress&&programData.length>=45&&programData.readUInt32LE(0)===3&&sha(programData)===plan.policy.programDataSha256,'deployment pin mismatch');
 const message=getCompiledTransactionMessageDecoder().decode(Buffer.from(plan.messageBase64,'base64')),payerAta=message.staticAccounts[message.instructions[0].accountIndices[6]];
 const balance=await rpc('getTokenAccountBalance',[payerAta,{commitment:'finalized'}]);check(balance?.value?.decimals===6&&BigInt(balance.value.amount)>=BigInt(plan.policy.depositAtomic),'payer USDC balance insufficient');
 const rent=await quoteSolanaSessionRent(rpc),fee=await rpc('getFeeForMessage',[plan.messageBase64,{commitment:'finalized'}]);check(Number.isSafeInteger(fee?.value)&&fee.value>=0,'current blockhash/fee required');
 const cost=BigInt(rent.operatorRentLamports)+BigInt(fee.value);check(cost<=BigInt(plan.policy.maximumOperatorOpenLamports),'operator budget exceeded');
 const operator=await rpc('getBalance',[plan.policy.operator,{commitment:'finalized'}]);check(Number.isSafeInteger(operator?.value)&&BigInt(operator.value)>=cost,'operator SOL balance insufficient');
 return {state:'ready',operatorOpenLamports:cost.toString(),buyerNativeLamports:'0',programDataSha256:plan.policy.programDataSha256};
}
