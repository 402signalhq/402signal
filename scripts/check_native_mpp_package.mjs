import {installLockedNativeMppConsumer} from "./native_mpp_consumer.mjs";
/** Strict consumer compilation runs after the pinned lab TypeScript dependency is installed. */
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'native-mpp-types-'));
try{
 const output=path.join(tmp,'package'),consumer=path.join(tmp,'consumer');fs.mkdirSync(consumer);
 execFileSync(process.execPath,[path.join(root,'integration/mpp-client/build-package.mjs'),output],{stdio:'pipe'});
 const packed=JSON.parse(execFileSync('npm',['pack','--json','--ignore-scripts'],{cwd:output,encoding:'utf8'}))[0];
 installLockedNativeMppConsumer(consumer,output,packed.filename);
 fs.writeFileSync(path.join(consumer,'consumer.mts'),`import {prepareNativeBaseMpp,prepareVerifiedNativeBaseMpp,type NativeOptions,type NativeSigner} from '@402signal/mpp-client/base';
import {privateKeyToAccount} from 'viem/accounts';
const account=privateKeyToAccount('0x'+'01'.repeat(32) as \`0x\${string}\`);
const signer:NativeSigner={address:account.address,signTypedData:data=>account.signTypedData(data)};
const options:NativeOptions={request:{url:'https://merchant.example',method:'GET',body:new Uint8Array()},challenge:{status:402,wwwAuthenticate:'synthetic compilation only'},policy:{network:'eip155:8453',asset:'0x1',recipient:'0x2',payer:account.address,maxAmountAtomic:'1000'}};
const a=prepareNativeBaseMpp(options);await a.createCredential({authorize:async claim=>{const id:string=claim.authorizationId;const amount:string=claim.inspection.amountAtomic;return signer;}});
prepareVerifiedNativeBaseMpp({...options,routeEvidence:{routeResponseJson:'{}',routeRequestJson:'{}',trustedLogVkey:'00',challenge:{status:402,bodyText:'',paymentRequired:null,wwwAuthenticate:options.challenge.wwwAuthenticate}}});
// @ts-expect-error The client does not accept another network implicitly.
const wrong:NativeOptions['policy']['network']='eip155:1';
`);
 execFileSync(process.execPath,[path.join(root,'integration/lab/node_modules/typescript/bin/tsc'),'--noEmit','--strict','--skipLibCheck','false','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2022','--typeRoots',path.join(root,'integration/lab/node_modules/@types'),'--types','node','consumer.mts'],{cwd:consumer,stdio:'inherit'});
 console.log('Native MPP installed TypeScript consumer passed.');
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
