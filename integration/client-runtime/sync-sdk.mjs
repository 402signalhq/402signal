import {mkdirSync,copyFileSync,readFileSync} from 'node:fs';
const source=new URL('../../sdk/route-guard/',import.meta.url);
const target=new URL('./sdk/route-guard/',import.meta.url);
const manifest=JSON.parse(readFileSync(new URL('package.json',source),'utf8'));
// Keep the local fixture copy identical to the published package file set,
// including internal imports and every declared public entrypoint.
for(const name of ['package.json',...manifest.files]) {
  if(typeof name!=='string')throw new Error('invalid SDK package file');
  const from=new URL(name,source),to=new URL(name,target);
  if(!from.href.startsWith(source.href)||!to.href.startsWith(target.href))
    throw new Error('SDK package file leaves package directory');
  mkdirSync(new URL('.',to),{recursive:true});
  copyFileSync(from,to);
}
