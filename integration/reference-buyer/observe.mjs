/** Observation only: no merchant request, credential, purchase or automatic new attempt. */
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { check, address, https, strictJson } from './policy.mjs';

export function observationPlan(config) {
  check(config && config.version === 1 && typeof config.directory === 'string' && config.directory.startsWith('/'), 'private_posix_directory_required');
  const p=config.policy;
  check(p && p.routerUrl === 'https://402signal.com/route' && p.campaignMaximumAtomic === '3000' &&
    p.buyerNativeFeeAtomic === '0' && Array.isArray(p.sellers) && p.sellers.length === 0, 'observation_only_policy_required');
  address(p.buyerAddress); address(p.routerPayTo); https(p.rpcUrl);
  check(!/^0x0{40}$/i.test(p.buyerAddress) && !/^0x0{40}$/i.test(p.routerPayTo),'zero_address_refused');
  check(p.buyerAddress.toLowerCase() !== p.routerPayTo.toLowerCase(), 'recipient_refused');
  const request = strictJson(config.routeRequestJson);
  let url; try { url=new URL(request.url); } catch {}
  check(url && url.protocol==='https:' && !url.username && !url.password && !url.hash &&
    Object.keys(request).every(k=>['url','need','networks','max_price_usd','require_route_binding'].includes(k)) && (request.need===undefined || typeof request.need==='string' && request.need.trim().length>0 && request.need.length<=256) &&
    request.require_route_binding === true && JSON.stringify(request.networks)==='["base"]' &&
    typeof request.max_price_usd==='number' && Number.isFinite(request.max_price_usd) && request.max_price_usd>=0, 'observation_request_refused');
  check(config.trust && typeof config.trust.approvedKeyFile==='string' && typeof config.trust.approvedFingerprint==='string' &&
    /^[0-9a-f]{64}$/.test(config.trust.approvedFingerprint) && typeof config.trust.provenance==='string' && config.trust.provenance.trim().length>0, 'independent_key_bootstrap_required');
  return Object.freeze({mode:'plan', network:'eip155:8453', merchantProfile:'supported exact GET observation',
    endpoint:request.url, maximum402SignalFeeUSDC:'0.003', maximumBuyerNetworkFeeAtomic:'0',
    feePath:'Base USDC EIP-3009 authorization; facilitator submits, buyer signs no native transaction',
    sellerExecution:'disabled', networkRequests:0, signerLoaded:false,
    package:'route-guard-v0.7.0; reviewed reference-buyer source',
    observeRequires:'Approved key pin, explicit budget acknowledgment, existing account module, router and read-only Base RPC access'});
}

export function approvedKey(config) {
  const key=readFileSync(resolve(config.trust.approvedKeyFile),'utf8').trim();
  check(createHash('sha256').update(key,'utf8').digest('hex')===config.trust.approvedFingerprint, 'approved_key_fingerprint_mismatch');
  check(key.length>0 && key.length<1024,'invalid_approved_key');
  return key;
}

export async function observeOnce({id,config,buyer,client,journal,verifyReceipt,trustedLogVkey,recover=false}) {
  observationPlan(config);
  let outcome;
  if(recover) {
    check(journal.job(id).request.routeRequestJson===config.routeRequestJson,'original_observation_required');
    outcome=await client.recover(id);
  } else {
    buyer.reserveObservation(id,config.routeRequestJson);
    await client.prepare(id,config.routeRequestJson);
    const challenge=await client.challenge(id);
    const value=await buyer.signRouting(id,challenge);
    await client.setPaymentHeader(id,{value});
    outcome=await client.submit(id);
  }
  const report={mode:recover?'recover':'observe', sellerExecution:'disabled',newPaymentAllowed:false,
    billingReport:outcome.classification?.settlementReport??'unknown',chainConfirmation:'not_checked',
    receiptVerification:'not_available',delivery:'not_checked',privateEvidenceRetained:true};
  if(buyer.validatedFreeMiss(id,outcome))return {...report,billingReport:'not_attempted',state:'completed_normal_miss'};
  if(outcome.response?.status===200 && outcome.classification?.settlementReport==='settled') {
    try { verifyReceipt({routeResponseJson:outcome.response.bodyText,routeRequestJson:config.routeRequestJson,trustedLogVkey}); report.receiptVerification='signature_and_inclusion_verified'; }
    catch { report.receiptVerification='failed'; }
    try { report.chainConfirmation=await buyer.confirmRouting(id,outcome)?'confirmed':'unknown'; }
    catch { report.chainConfirmation='unknown'; }
  }
  return {...report,state:report.receiptVerification==='signature_and_inclusion_verified'?'observation_retained':'observation_unresolved'};
}

export async function main(argv=process.argv.slice(2),env=process.env) {
  const [command='offline',file,id]=argv;
  if(command==='offline') {
    check(argv.length<=1,'invalid_arguments');
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('../buyer-checks/run.mjs',import.meta.url))],{
      env:{PATH:env.PATH},encoding:'utf8',timeout:15000,maxBuffer:100000});
    check(result.status===0,'offline_checks_incomplete');process.stdout.write(result.stdout);return;
  }
  check(['plan','observe','recover'].includes(command) && file,'explicit_operation_required');
  const config=strictJson(readFileSync(resolve(file),'utf8'));const plan=observationPlan(config);
  if(command==='plan'){
    check(argv.length===2,'invalid_arguments');
    let trustPinVerified=false;try {approvedKey(config);trustPinVerified=true;}catch{}
    console.log(JSON.stringify({...plan,trustPinVerified,operatorApprovalRecorded:config.purpose==='operator-approved-observation',runtimeReady:process.versions.node.split('.')[0]==='24' && process.platform!=='win32'}));return;
  }
  check(argv.length===3 && /^[A-Za-z0-9_-]{1,64}$/.test(id),'original_attempt_id_required');
  check(config.purpose==='operator-approved-observation','synthetic_plan_cannot_spend');
  check(env.REFERENCE_OBSERVE_ACK==='one-check-0.003-no-seller','observation_authorization_required');
  check(process.versions.node.split('.')[0]==='24' && process.platform!=='win32','node24_posix_required');
  const trustedLogVkey=approvedKey(config); // Validate independent pin before importing a signer.
  const [{BaseBuyer},{BuyerJournal},{RouteClient},{FileAttemptStore},{verifyReceipt}]=await Promise.all([
    import('./base-buyer.mjs'),import('./journal.mjs'),import('@402signal/route-guard/client'),
    import('@402signal/route-guard/file-store'),import('@402signal/route-guard')]);
  let account={address:config.policy.buyerAddress,signTypedData:async()=>{throw new Error('read_only_operation');}};
  if(command==='observe') {
    check(typeof env.REFERENCE_BUYER_ACCOUNT_MODULE==='string','caller_owned_account_module_required');
    account=(await import(pathToFileURL(resolve(env.REFERENCE_BUYER_ACCOUNT_MODULE)).href)).account;
  }
  const allowed=new Set([config.policy.routerUrl,config.policy.rpcUrl]);
  const transport=(url,init)=>{check(allowed.has(String(url)),'merchant_transport_disabled');return globalThis.fetch(url,{...init,redirect:'error'});};
  const journal=new BuyerJournal(resolve(config.directory),config.policy);
  try {
    const buyer=new BaseBuyer({account,journal,policy:config.policy,routingOnly:true,fetch:transport});
    const client=new RouteClient({store:new FileAttemptStore(join(resolve(config.directory),'route-attempts')),
      recoveryProfile:'http-route-v1',routerUrl:config.policy.routerUrl,customerKey:env.REFERENCE_BUYER_CUSTOMER_KEY,fetch:transport});
    const report=await observeOnce({id,config,buyer,client,journal,verifyReceipt,trustedLogVkey,recover:command==='recover'});
    console.log(JSON.stringify(report));
  }finally{journal.close();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{
 console.error(JSON.stringify({state:'stopped',newPaymentAllowed:false,sellerExecution:'disabled',code:'observation_stopped'}));process.exitCode=1;
});
