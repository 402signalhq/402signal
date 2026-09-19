import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {approvedKey,observationPlan} from '../observe.mjs';
const cli=fileURLToPath(new URL('../observe.mjs',import.meta.url));
function config(){return {version:1,directory:'/private/observe',policy:{buyerAddress:'0x'+'1'.repeat(40),routerPayTo:'0x'+'2'.repeat(40),routerUrl:'https://402signal.com/route',rpcUrl:'https://rpc.example/',campaignMaximumAtomic:'3000',buyerNativeFeeAtomic:'0',sellers:[]},routeRequestJson:JSON.stringify({url:'https://merchant.example?contact=a@b',networks:['base'],max_price_usd:0.02,require_route_binding:true}),trust:{approvedKeyFile:'/does-not-exist',approvedFingerprint:'a'.repeat(64),provenance:'operator-reviewed synthetic fixture'}};}
test('plan and offline run outside repository root without loading the configured signer',()=>{
 const dir=mkdtempSync(join(tmpdir(),'observe-plan-'));
 try {
  const file=join(dir,'config.json'),module=join(dir,'account.mjs');writeFileSync(file,JSON.stringify(config()));writeFileSync(module,'throw new Error("PRIVATE_EXCEPTION_MUST_NOT_APPEAR")');
  const env={PATH:process.env.PATH,REFERENCE_BUYER_ACCOUNT_MODULE:module};
  const p=spawnSync(process.execPath,[cli,'plan',file],{cwd:dir,env,encoding:'utf8',timeout:20000});assert.equal(p.status,0,p.stderr);
  const plan=JSON.parse(p.stdout);assert.equal(plan.networkRequests,0);assert.equal(plan.signerLoaded,false);assert.equal(plan.endpoint,'https://merchant.example?contact=a@b');
  const offline=spawnSync(process.execPath,[cli,'offline'],{cwd:dir,env,encoding:'utf8',timeout:20000});assert.equal(offline.status,0,offline.stderr);assert.equal(JSON.parse(offline.stdout).report_version,'2');
  writeFileSync(file,JSON.stringify({...config(),purpose:'operator-approved-observation'}));
  const missingPin=spawnSync(process.execPath,[cli,'observe',file,'job'],{cwd:dir,env:{...env,REFERENCE_OBSERVE_ACK:'one-check-0.003-no-seller'},encoding:'utf8',timeout:10000});assert.equal(missingPin.status,1);assert.ok(!missingPin.stderr.includes('PRIVATE_EXCEPTION'));assert.equal(JSON.parse(missingPin.stderr).newPaymentAllowed,false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('independent key fingerprint refuses substituted keys without consulting a response',()=>{
 const dir=mkdtempSync(join(tmpdir(),'observe-pin-'));try{
  const file=join(dir,'key.txt');writeFileSync(file,'synthetic public key\n');const c=config();c.trust.approvedKeyFile=file;
  assert.throws(()=>approvedKey(c),/fingerprint_mismatch/);
  c.trust.approvedFingerprint=createHash('sha256').update('synthetic public key').digest('hex');assert.equal(approvedKey(c),'synthetic public key');
  writeFileSync(file,'changed key');assert.throws(()=>approvedKey(c),/fingerprint_mismatch/);
  writeFileSync(file,'synthetic public key');
  c.response={vkey:'offered-from-route',pq_trust:{transparency:{vkey:'offered-from-route'}}};
  c.trustedLogVkey='offered-from-route';
  assert.equal(approvedKey(c),'synthetic public key');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('plan refuses payment authority expansion and preserves exact supported request bytes',()=>{
 const c=config();assert.equal(observationPlan(c).sellerExecution,'disabled');
 for(const patch of [{networks:['solana']},{require_route_binding:false},{authorization:'secret'},{probe_request:{method:'POST'}}]){
  assert.throws(()=>observationPlan({...c,routeRequestJson:JSON.stringify({...JSON.parse(c.routeRequestJson),...patch})}));
 }
 assert.throws(()=>observationPlan({...c,policy:{...c.policy,routerUrl:'https://elsewhere.example/route'}}));
});
