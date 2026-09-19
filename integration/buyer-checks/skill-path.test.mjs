import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
test('copied skill runner locates an approved checkout outside repository cwd',()=>{
 const dir=mkdtempSync(join(tmpdir(),'skill-path-'));
 try{
  const cli=join(dir,'run.mjs'),root=fileURLToPath(new URL('../../',import.meta.url));
  copyFileSync(new URL('../../skills/402signal-buyer-checks/run.mjs',import.meta.url),cli);
  const p=spawnSync(process.execPath,[cli,'--repo',root],{cwd:dir,env:{PATH:process.env.PATH},encoding:'utf8',timeout:20000});
  assert.equal(p.status,0,p.stderr);assert.equal(JSON.parse(p.stdout).report_version,'2');
  const bad=spawnSync(process.execPath,[cli,'--repo','.'],{cwd:dir,env:{PATH:process.env.PATH},encoding:'utf8'});
  assert.equal(bad.status,1);assert.equal(bad.stdout,'');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
