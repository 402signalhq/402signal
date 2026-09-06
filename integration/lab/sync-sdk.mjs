import {mkdirSync,copyFileSync} from 'node:fs';
const source=new URL('../../sdk/route-guard/',import.meta.url);
const target=new URL('./sdk/route-guard/',import.meta.url);
mkdirSync(target,{recursive:true});
for(const name of ['index.mjs','index.d.ts','recovery.mjs','recovery.d.ts','package.json'])
  copyFileSync(new URL(name,source),new URL(name,target));
