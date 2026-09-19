/** Existing reference regressions, reported separately from customer adapter checks. */
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
const definitions={
 routing:{files:['sdk/route-guard/test/client.test.mjs','sdk/route-guard/test/recovery.test.mjs'],covers:'Original attempt, lost response, restart, immutable authorization, bounded read-only recovery'},
 seller:{files:['integration/reference-buyer/test/buyer.test.mjs','integration/reference-buyer/test/observe.test.mjs'],covers:'Seller ambiguity, repeat/new-job fencing, reopened journal, independent confirmation, observation-only onboarding'},
 mpp:{files:['integration/mpp-client/test/native-base.test.mjs','integration/mpp-client/test/native-base-durable.test.mjs'],covers:'Native Base MPP offer selection and durable one-shot authorization, not session continuation'},
};
const args=process.argv.slice(2),choice=args[0]??'routing';
if(args.length>1 || !(choice in definitions || choice==='all')){
 console.log(JSON.stringify({report_version:'1',state:'harness-error',reason_code:'choose_routing_seller_mpp_or_all'}));process.exitCode=1;
}else{
 const suites=[];
 for(const name of choice==='all'?Object.keys(definitions):[choice]){
  const d=definitions[name],result=spawnSync(process.execPath,['--test','--test-reporter=tap',...d.files.map(f=>resolve(root,f))],{
   cwd:root,env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR||'/tmp',LIVE402_FIXTURE:'1',PYTHONPATH:root},
   timeout:90000,maxBuffer:2000000,encoding:'utf8'});
  const count=key=>Number([...String(result.stdout||'').matchAll(new RegExp('^# '+key+' (\\d+)$','gm'))].at(-1)?.[1]??NaN);
  const passed=count('pass'),failed=count('fail'),skipped=count('skipped');
  const completed=result.status!==null && Number.isFinite(passed) && Number.isFinite(failed) && passed+failed>0;
  const state=completed ? (result.status===0 && failed===0 && skipped===0?'passed':'failed') : 'incomplete';
  suites.push({suite:name,state,passed:completed?passed:0,failed:completed?failed:0,skipped:Number.isFinite(skipped)?skipped:0,
   covers:d.covers,subject:'repository reference implementations',customerAdapterTested:false,
   next_action:state==='passed'?'none':'check_reviewed_source_Node24_and_locked_dependencies; do_not_export_raw_error_logs'});
 }
 const report={report_version:'1',mode:'synthetic-reference-lifecycles',suites,
  not_tested:['customer production signing integration','live merchant settlement','session continuation','Falcon anchors'],payments:0};
 console.log(JSON.stringify(report,null,2));if(suites.some(s=>s.state!=='passed'))process.exitCode=1;
}
