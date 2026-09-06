import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { PaymentRequired } from '@x402/core/types';
import { type BuyerConfig, type Signer, validateBuyer, challenge, selectTerms } from './buyer.js';
import { Ledger } from './ledger.js';
import { type Rail, RAILS, railInfo } from './config.js';
import { type Utility, UTILITIES, example, utility } from './utilities.js';
import { assert, canonical, decode64, digest, encode64, parseJson, LabError } from './json.js';
import { http, safeReceipt, type Transport } from './transport.js';
import { paymentIntent } from './mainnet-policy.js';
import { type Confirmation, type Confirmer } from './confirmation.js';

export type BindingVerifier = (options: any) => Promise<any> | any;
export async function verifyProductionBinding(options: any) {
  const modulePath = '../../sdk/route-guard/index.mjs';
  const { verifyRoute } = await import(modulePath);
  return verifyRoute({...options, trustedLogVkey: readFileSync('/labdata/trusted-pq-vkey.txt','utf8').trim()});
}
export const ROUTE_PROTOCOL = '402signal-lab-route-v2';
type Phase = {state: 'not_attempted'|'prepared'|'submitted'|'receipt_observed'|'confirmed'|'not_settled'; receipt?: ReturnType<typeof safeReceipt>; confirmation?: Confirmation};
export interface RouteReport {
  run_id: string; rail: Rail; capability: Utility; mode: 'mainnet'; workflow: 'route_and_execute';
  traffic_class: 'self_test'; organic_demand: false; reserved_atomic: string;
  router: Phase; seller: Phase; delivery: 'not_attempted'|'unknown'|'validated';
  scenario: 'purchase'|'price_miss';
  route_status?: number; miss_reason?: string; selected_payment?: Record<string,unknown>;
  pq_evidence: 'not_checked'|'receipt_observed_unverified'|'signature_and_inclusion_verified'|'unavailable'|'verification_failed';
  timings_ms?: Record<string,number>;
  router_timings_ms?: Record<string,number>;
  proof_status?: {receipt:string; seller_quote:string; anchor:string};
  recovery?: {payments_reconciled:boolean; workflow_complete:boolean; receipt_verification:string};
  pq_trust?: {transparency: Record<string,unknown>};
  result_sha256?: string; stopped_because?: string;
}
const misses = new Set(['no_candidates','constraints_unmet','no_402_envelope','probe_timeout','upstream_5xx','quote_expired',
  'reachable_200','no_payto','ssrf','no_input_schema','probe_budget_exhausted','probe_limit_reached','unsafe_to_probe','invalid_need']);
const phaseId = (id: string, phase: 'router'|'seller') => `${id}:${phase}`;
function checkId(id: string) {assert(/^[a-zA-Z0-9_-]{1,64}$/.test(id),'invalid_run_id');}
export function routeBody(c: BuyerConfig, rail: Rail, name: Utility, scenario: 'purchase'|'price_miss' = 'purchase') {
  return {url:`${c.sellerOrigin}/${rail}/${name}`, need:`operator self-test ${name}`, objective:'best',
    networks:[rail], max_price_usd:scenario==='price_miss'?0:Number(c.sellerMaxAtomic)/1000000, lab_test:ROUTE_PROTOCOL, require_transparency:true, require_route_binding:true};
}
export function checkAdvertisement(c: BuyerConfig, ch: PaymentRequired) {
  const a = (ch as any).lab_testing;
  assert(a?.protocol === ROUTE_PROTOCOL && Array.isArray(a.origins) && a.origins.includes(c.sellerOrigin) &&
    a.processing === 'production', 'router_production_processing_not_deployed');
  const b = (ch as any).billing;
  assert(b?.model === 'success_only_v1' && b.amount_atomic === '3000' && b.asset === 'USDC' &&
    b.typed_misses_settled === false && b.seller_payment_separate === true, 'router_billing_contract_mismatch');
}
function checkClassification(v:any) {
  assert(v?.protocol === ROUTE_PROTOCOL && v.traffic_class === 'self_test' && v.organic_demand === false &&
    v.processing === 'production', 'router_lab_classification_missing');
}
export async function inspectRoute(c: BuyerConfig, rail: Rail, name: Utility, send: Transport = http) {
  validateBuyer(c);assert(c.mode === 'mainnet' && c.routePilot?.protocol === ROUTE_PROTOCOL,'route_policy_required');
  assert(RAILS.includes(rail) && UTILITIES.includes(name),'invalid_run');
  const ch = challenge(await send(c.routerUrl,'POST',routeBody(c,rail,name)),c.routerUrl);
  checkAdvertisement(c,ch);const terms=selectTerms(c,rail,ch,'router');
  return {mode:'mainnet', signs_or_sends_payments:false, router:c.routerUrl, seller:c.sellerOrigin,
    rail, router_amount_atomic:terms.amount, router_pay_to:terms.payTo,
    max_seller_amount_atomic:c.sellerMaxAtomic, cap_atomic:c.capAtomicPerRail[rail], production_processing_advertised:true};
}
export class RoutePilot {
  constructor(private c: BuyerConfig, private ledger: Ledger, private routerSigner: Signer,
    private sellerSigner: Signer, private confirm: Confirmer, private send: Transport = http,
    private verifyBinding: BindingVerifier = verifyProductionBinding) {}
  async run(id: string, rail: Rail, name: Utility, scenario: 'purchase'|'price_miss' = 'purchase'): Promise<RouteReport> {
    checkId(id);assert(['purchase','price_miss'].includes(scenario),'invalid_scenario');const c=this.c;validateBuyer(c);
    assert(c.mode === 'mainnet' && c.routePilot?.protocol === ROUTE_PROTOCOL && RAILS.includes(rail) && UTILITIES.includes(name),'route_policy_required');
    // Preserve the existing seller campaign and all reservations. Adding routing
    // binds a second policy instead of silently changing/resetting that ledger.
    this.ledger.bindCampaign(digest(canonical({mode:c.mode,policy:c.mainnet,origin:c.sellerOrigin,recipients:c.sellerPayTo,feePayers:c.feePayers})));
    this.ledger.bindRoutePolicy(digest(canonical({router:c.routerUrl,recipients:c.routerPayTo,policy:c.routePilot})));
    const r:RouteReport={run_id:id,rail,capability:name,scenario,mode:'mainnet',workflow:'route_and_execute',traffic_class:'self_test',organic_demand:false,
      reserved_atomic:(3000n+BigInt(c.sellerMaxAtomic)).toString(),router:{state:'not_attempted'},seller:{state:'not_attempted'},delivery:'not_attempted',pq_evidence:'not_checked'};
    this.ledger.reserveSpend(id,rail,r.reserved_atomic,c.capAtomicPerRail[rail],true);
    const started=performance.now();r.timings_ms={};
    const measured=async<T>(name:string,operation:()=>Promise<T>):Promise<T>=>{
      const start=performance.now();
      try{return await operation();}finally{r.timings_ms![name]=(r.timings_ms![name]??0)+Math.max(0,Math.round(performance.now()-start));}
    };
    const send:Transport=async(url,method,body,headers)=>measured(
      `${url===c.routerUrl?'router':'seller'}_${headers?.['PAYMENT-SIGNATURE']?'execution':'challenge'}`,
      ()=>this.send(url,method,body,headers));
    const save=()=>this.ledger.saveRoute(id,r);
    const confirmPhase=async(phase:'router'|'seller')=>{
      const p=r[phase], saved=this.ledger.getIntent(phaseId(id,phase));
      assert(p.receipt,'receipt_required');
      const evidence=await measured(phase+'_confirmation',()=>this.confirm(saved.intent,p.receipt!.transaction));
      this.ledger.recordConfirmation(phaseId(id,phase),evidence);p.confirmation=evidence;save();
      assert(evidence.state==='confirmed',`${phase}_chain_confirmation_unknown`);p.state='confirmed';save();
    };
    try {
      save();const body=routeBody(c,rail,name,scenario),url=body.url;
      const initial=challenge(await send(c.routerUrl,'POST',body),c.routerUrl);
      checkAdvertisement(c,initial);const req=selectTerms(c,rail,initial,'router');
      const signed=await measured('router_signing',()=>this.routerSigner(rail,{...initial,accepts:[req]}));
      assert(canonical(signed.accepted)===canonical(req),'signer_changed_terms');
      this.ledger.recordIntent(phaseId(id,'router'),paymentIntent(rail,req,signed,c.mainnet!.buyerAddresses[rail]));
      r.router.state='prepared';save();
      this.ledger.spendState(id,'router_attempted');r.router.state='submitted';save();
      const replayKey=randomBytes(32).toString('hex');
      const response=await send(c.routerUrl,'POST',body,{'PAYMENT-SIGNATURE':encode64(signed),'Replay-Key':replayKey});
      r.route_status=response.status;const b=response.body?.billing;
      if(response.body?.timings_ms){
        r.router_timings_ms={};
        for(const key of ['verification','routing_probe','binding_validation','settlement','history','pq_receipt','replay_lookup','discovery','hydration','candidate_probing','total']) {
          const value=response.body.timings_ms[key];
          if(typeof value==='number' && Number.isFinite(value) && value>=0 && value<=300000)r.router_timings_ms[key]=value;
        }
      }
      // Store safe receipts before validating route/classification: even a bad
      // response may represent money spent and must remain reconcilable.
      const raw=response.headers.get('PAYMENT-RESPONSE');
      if(raw) {
        r.router.receipt=safeReceipt(rail,parseJson(decode64(raw).toString('utf8')),req);
        this.ledger.recordReceipt(phaseId(id,'router'),r.router.receipt.transaction);
        r.router.state='receipt_observed';save();
      }
      assert(b?.model==='success_only_v1' && b.amount_atomic==='3000' && b.asset==='USDC' && b.rail===rail,'router_billing_mismatch');
      checkClassification(response.body.lab_testing);
      // Retain private proof material separately from facilitator receipts. A
      // returned checkpoint is not independent signature/anchor verification.
      const tr=response.body.pq_trust?.transparency;
      if(tr && typeof tr==='object' && !Array.isArray(tr)) {
        const kept:Record<string,unknown>={};
        for(const key of ['status','state','log_origin','leaf_type','index','checkpoint_size','receipt','reveal'])
          if(Object.hasOwn(tr,key))kept[key]=tr[key];
        assert(Buffer.byteLength(JSON.stringify(kept))<=131072,'pq_evidence_too_large');
        r.pq_trust={transparency:kept};
        r.pq_evidence=tr.receipt?.checkpoint?'receipt_observed_unverified':'unavailable';save();
      }
      if(response.status===503 && b.settled===false && b.settlement_attempted===false && b.settlement_state==='not_attempted' &&
          response.body.live===false && response.body.selected_payment===null && misses.has(response.body.miss_reason) && !raw) {
        r.router.state='not_settled';r.miss_reason=response.body.miss_reason;save();
        this.ledger.spendState(id,'route_free_miss');return r;
      }
      assert(b.settled===true && b.settlement_attempted===true && b.settlement_state==='settled','router_settlement_unknown');
      await confirmPhase('router');
      assert(scenario==='purchase','expected_free_miss_was_billed');
      assert(response.status===200 && response.body.live===true && response.body.payable===true && response.body.status===402 &&
        response.body.url===url,'route_not_executable');
      assert(tr?.state==='checkpoint_signed' && tr.status==='pending' &&
        typeof tr.receipt?.checkpoint==='string' && tr.receipt.checkpoint.length>0 &&
        Number.isSafeInteger(tr.receipt.index) && tr.receipt.index>=0 &&
        Array.isArray(tr.receipt.inclusion_path) && tr.reveal?.event_version==='402signal.route_decision.v4',
        'router_transparency_unavailable');
      const p=response.body.selected_payment,info=railInfo(rail,'mainnet');
      assert(p && p.rail===rail && p.network===info.network && p.asset===info.asset && p.payTo===c.sellerPayTo[rail] &&
        Number.isSafeInteger(p.amount_atomic) && p.amount_atomic>0 && BigInt(p.amount_atomic)<=BigInt(c.sellerMaxAtomic),'selected_option_mismatch');
      r.selected_payment={rail,network:p.network,asset:p.asset,payTo:p.payTo,amount_atomic:p.amount_atomic};save();
      const input=example(name), sellerChallenge=await send(url,'GET');
      const sch=challenge(sellerChallenge,url);
      const sreq=selectTerms(c,rail,sch,'seller');assert(sreq.amount===String(p.amount_atomic),'seller_terms_changed');
      const verify = async () => {
        const action = await this.verifyBinding({
          routeResponseJson: response.rawBody ?? JSON.stringify(response.body),
          routeRequestJson: JSON.stringify(body),
          request: {url, method:'GET'},
          challenge: {status:sellerChallenge.status,
            bodyText:sellerChallenge.rawBody ?? JSON.stringify(sellerChallenge.body),
            paymentRequired:sellerChallenge.headers.get('PAYMENT-REQUIRED') ?? undefined,
            xPaymentRequired:sellerChallenge.headers.get('X-PAYMENT-REQUIRED') ?? undefined}
        });
        assert(canonical(action.accepted)===canonical(sreq),'bound_seller_terms_changed');
        r.pq_evidence='signature_and_inclusion_verified';
        r.proof_status={receipt:r.pq_evidence,seller_quote:'matched_before_submission',anchor:'not_checked'};save();
      };
      await measured('proof_and_quote_verification',verify);
      const sp=await measured('seller_signing',()=>this.sellerSigner(rail,{...sch,accepts:[sreq]}));
      await measured('proof_and_quote_verification',verify); // Expiration is checked again after signing, before submission.
      assert(canonical(sp.accepted)===canonical(sreq),'signer_changed_terms');
      this.ledger.recordIntent(phaseId(id,'seller'),paymentIntent(rail,sreq,sp,c.mainnet!.buyerAddresses[rail]));
      r.seller.state='prepared';save();this.ledger.spendState(id,'seller_attempted');
      r.seller.state='submitted';r.delivery='unknown';save();
      const result=await send(url,'GET',undefined,{'PAYMENT-SIGNATURE':encode64(sp)});
      const receipt=result.headers.get('PAYMENT-RESPONSE');assert(receipt,'seller_receipt_missing');
      r.seller.receipt=safeReceipt(rail,parseJson(decode64(receipt).toString('utf8')),sreq);
      this.ledger.recordReceipt(phaseId(id,'seller'),r.seller.receipt.transaction);r.seller.state='receipt_observed';save();
      assert(result.status===200 && canonical(result.body?.result)===canonical(utility(name,input)),'seller_delivery_mismatch');
      r.delivery='validated';r.result_sha256=digest(canonical(result.body.result));save();
      await confirmPhase('seller');this.ledger.spendState(id,'complete');return r;
    } catch(e) {
      r.stopped_because=e instanceof LabError ? e.code : 'route_execution_stopped';
      // A persisted submitted phase is never downgraded to not-submitted.
      try {save();this.ledger.spendState(id,r.router.state==='not_attempted'||r.router.state==='prepared'?'not_submitted':'halted');} catch { /* keep durable pending reservation */ }
      return r;
    } finally {
      r.timings_ms!.total=Math.max(0,Math.round(performance.now()-started));
      try{save();}catch{/* Preserve the previous durable payment state. */}
    }
  }
}
export async function recheckRoute(c:BuyerConfig, ledger:Ledger, id:string, confirm:Confirmer) {
  checkId(id);validateBuyer(c);const r=ledger.getRoute(id) as RouteReport;
  assert(r.mode==='mainnet' && r.workflow==='route_and_execute','route_report_required');
  let resolved=true;
  for(const phase of ['router','seller'] as const) {
    const p=r[phase];if(p.state==='not_attempted'||p.state==='prepared'||p.state==='not_settled')continue;
    const saved=ledger.getIntent(phaseId(id,phase));
    assert(saved.intent.buyer===c.mainnet!.buyerAddresses[r.rail] && saved.intent.payTo===(phase==='router'?c.routerPayTo[r.rail]:c.sellerPayTo[r.rail]),'recheck_scope_mismatch');
    const tx=saved.transaction??saved.intent.transaction;
    if(!tx){resolved=false;continue;}
    const evidence=await confirm(saved.intent,tx);ledger.recordConfirmation(phaseId(id,phase),evidence);p.confirmation=evidence;
    if(evidence.state==='confirmed')p.state='confirmed';else {p.state=p.receipt?'receipt_observed':'submitted';resolved=false;}
  }
  let receiptVerification='not_available';
  if(r.pq_trust) {
    try {
      const modulePath='../../sdk/route-guard/index.mjs';
      const {verifyReceipt}=await import(modulePath);
      verifyReceipt({routeResponseJson:JSON.stringify(r),routeRequestJson:JSON.stringify(routeBody(c,r.rail,r.capability,r.scenario)),
        trustedLogVkey:readFileSync('/labdata/trusted-pq-vkey.txt','utf8').trim()});
      receiptVerification='signature_and_inclusion_verified';r.pq_evidence='signature_and_inclusion_verified';
      r.proof_status={receipt:receiptVerification,seller_quote:r.proof_status?.seller_quote??'not_checked',anchor:'not_checked'};
    }catch{
      receiptVerification='verification_failed';r.pq_evidence='verification_failed';
      r.proof_status={receipt:receiptVerification,seller_quote:r.proof_status?.seller_quote??'not_checked',anchor:'not_checked'};
    }
  }
  const complete=r.router.state==='confirmed' && r.seller.state==='confirmed' && r.delivery==='validated';
  r.recovery={payments_reconciled:resolved,workflow_complete:complete,receipt_verification:receiptVerification};
  ledger.saveRoute(id,r);if(resolved)ledger.spendState(id,complete?'complete':'reconciled');
  return {run_id:id,router:r.router,seller:r.seller,resolved,payment_resubmitted:false,budget_released:false,
    delivery:r.delivery,seller_execution_resumed:false,workflow_complete:complete,proof_status:r.proof_status,recovery:r.recovery};
}
