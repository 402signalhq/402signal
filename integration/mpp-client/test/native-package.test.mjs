import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {execFileSync} from 'node:child_process';
test('installable archive has locked dependencies and works without repository imports',()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'native-mpp-package-'));try{
  const output=path.join(tmp,'package'),consumer=path.join(tmp,'consumer');fs.mkdirSync(consumer);
  execFileSync(process.execPath,[new URL('../build-package.mjs',import.meta.url).pathname,output],{stdio:'pipe'});
  const result=JSON.parse(execFileSync('npm',['pack','--json','--ignore-scripts'],{cwd:output,encoding:'utf8'}))[0];
  fs.writeFileSync(path.join(consumer,'package.json'),JSON.stringify({private:true,type:'module'}));
  execFileSync('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund',path.join(output,result.filename)],{cwd:consumer,stdio:'pipe'});
  fs.copyFileSync(new URL('../../../tests/fixtures/base-native-mpp-v5.json',import.meta.url),path.join(consumer,'fixture.json'));
  const code=`import fs from 'node:fs';import {prepareVerifiedNativeBaseMpp} from '@402signal/mpp-client/base';import {privateKeyToAccount} from 'viem/accounts';const v=JSON.parse(fs.readFileSync('fixture.json'));const account=privateKeyToAccount('0x'+'01'.repeat(32));const prepared=prepareVerifiedNativeBaseMpp({request:{url:v.request.url,method:'GET',body:new Uint8Array()},challenge:v.challenge,policy:{network:v.request.buyer_limits.network,asset:v.request.buyer_limits.asset,recipient:v.request.buyer_limits.recipient,payer:account.address,maxAmountAtomic:'1000'},now:()=>v.now*1000,routeEvidence:{routeResponseJson:JSON.stringify(v.response),routeRequestJson:JSON.stringify(v.request),trustedLogVkey:v.trusted_vkey,challenge:v.challenge}});const result=await prepared.createCredential({authorize:async()=>account});if(!result.headerValue.startsWith('Payment '))throw new Error('credential missing');console.log('installed guarded credential pass');`;
  const stdout=execFileSync(process.execPath,['--input-type=module','-e',code],{cwd:consumer,encoding:'utf8'});assert.match(stdout,/installed guarded credential pass/);
  const shrink=JSON.parse(fs.readFileSync(path.join(output,'npm-shrinkwrap.json')));assert.equal(shrink.packages['node_modules/mppx'].version,'0.9.2');
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
