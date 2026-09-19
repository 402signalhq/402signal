import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
const source=import.meta.dirname,root=path.resolve(source,'../..'),target=path.resolve(process.argv[2]??'');
if(!process.argv[2]||fs.existsSync(target))throw new Error('Provide a new empty output directory path.');
fs.mkdirSync(target,{recursive:true});const files=[];
function copy(from,to,transform=x=>x){const raw=fs.readFileSync(from),data=transform(raw);fs.mkdirSync(path.dirname(to),{recursive:true});fs.writeFileSync(to,data);files.push({source:path.relative(root,from),path:path.relative(target,to),sourceSha256:createHash('sha256').update(raw).digest('hex'),sha256:createHash('sha256').update(data).digest('hex')});}
for(const file of ['index.mjs','native-base.mjs','native-base.d.ts'])copy(path.join(source,file),path.join(target,file),b=>b.toString().replaceAll('../../sdk/route-guard/','./_guard/'));
const guard=path.join(root,'sdk/route-guard');const spec=JSON.parse(fs.readFileSync(path.join(guard,'package.json')));
for(const file of spec.files)if(file.endsWith('.mjs')||file.endsWith('.d.ts'))copy(path.join(guard,file),path.join(target,'_guard',file));
copy(path.join(root,'LICENSE'),path.join(target,'LICENSE'));copy(path.join(source,'NATIVE.md'),path.join(target,'README.md'));
const deps=JSON.parse(fs.readFileSync(path.join(source,'package.json'))).dependencies;
const lock=JSON.parse(fs.readFileSync(path.join(source,'package-lock.json')));lock.name='@402signal/mpp-client';lock.version='0.1.0';lock.packages[''].name=lock.name;lock.packages[''].version=lock.version;fs.writeFileSync(path.join(target,'npm-shrinkwrap.json'),JSON.stringify(lock,null,2)+'\n');
fs.writeFileSync(path.join(target,'package.json'),JSON.stringify({name:'@402signal/mpp-client',version:'0.1.0',type:'module',license:'MIT',engines:{node:'>=22'},exports:{'./base':{types:'./native-base.d.ts',import:'./native-base.mjs'},'./base-x402':'./index.mjs'},dependencies:deps,files:['*.mjs','*.d.ts','_guard','LICENSE','README.md','provenance.json','npm-shrinkwrap.json']},null,2)+'\n');
fs.writeFileSync(path.join(target,'provenance.json'),JSON.stringify({files},null,2)+'\n');console.log(JSON.stringify({output:target,sourceFiles:files.length}));
