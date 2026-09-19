/** Relocatable free-test entry point. No install, network setup or paid mode. */
import {spawnSync} from 'node:child_process';
import {resolve,isAbsolute} from 'node:path';
import {existsSync} from 'node:fs';
const a=process.argv.slice(2);
if(a.length!==2 || a[0]!=='--repo' || !isAbsolute(a[1])) {
 console.error('Supply --repo with the absolute path to an operator-reviewed 402Signal checkout.');process.exitCode=1;
}else{
 const root=resolve(a[1]),runner=resolve(root,'integration/buyer-checks/run.mjs');
 if(!existsSync(runner)){console.error('Reviewed checkout is unavailable; no test ran.');process.exitCode=1;}
 else{const p=spawnSync(process.execPath,[runner],{cwd:root,env:{PATH:process.env.PATH},timeout:15000,maxBuffer:100000,encoding:'utf8'});
  if(p.status!==0){console.error('Offline checks incomplete; inspect the reviewed harness locally.');process.exitCode=1;}
  else process.stdout.write(p.stdout);
 }
}
