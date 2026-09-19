import {test} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {Challenge} from 'mppx';import {privateKeyToAccount} from 'viem/accounts';import {prepareNativeBaseMpp} from '../native-base.mjs';
const account=privateKeyToAccount('0x'+'01'.repeat(32)),asset='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',recipient='0x1111111111111111111111111111111111111111';
const fixture=()=>({request:{url:'https://merchant.example/paid',method:'GET',body:new Uint8Array()},challenge:{status:402,wwwAuthenticate:Challenge.serialize({id:'durable-test-only',realm:'merchant.example',method:'evm',intent:'charge',expires:'2026-09-08T17:01:00Z',request:{amount:'1000',currency:asset,recipient,methodDetails:{chainId:8453,credentialTypes:['authorization']}}})},policy:{network:'eip155:8453',asset,recipient,payer:account.address,maxAmountAtomic:'1000'},now:()=>Date.parse('2026-09-08T17:00:00Z')});
function ledger(file){const db=new DatabaseSync(file);db.exec('PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, state TEXT NOT NULL, amount TEXT NOT NULL)');return db;}
test('independent durable claim connections fence reconstructed competing preparations',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'native-mpp-claim-'));let a,b,signs=0;
 try{a=ledger(path.join(dir,'ledger.sqlite'));b=ledger(path.join(dir,'ledger.sqlite'));
 const authorize=db=>async({authorizationId,inspection})=>{db.prepare('INSERT INTO attempts VALUES(?,?,?)').run(authorizationId,'signing_unknown',inspection.amountAtomic);return {...account,signTypedData:async d=>{signs++;return account.signTypedData(d);}};};
 const results=await Promise.allSettled([prepareNativeBaseMpp(fixture()).createCredential({authorize:authorize(a)}),prepareNativeBaseMpp(fixture()).createCredential({authorize:authorize(b)})]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(signs,1);a.close();a=ledger(path.join(dir,'ledger.sqlite'));
 await assert.rejects(prepareNativeBaseMpp(fixture()).createCredential({authorize:authorize(a)}));assert.equal(signs,1);assert.equal(a.prepare('SELECT state FROM attempts').get().state,'signing_unknown');
 }finally{a?.close();b?.close();rmSync(dir,{recursive:true,force:true});}
});
test('signer uncertainty survives a reconstructed adapter and leaves no transport authority',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'native-mpp-unknown-'));let db,signs=0;
 try{const file=path.join(dir,'ledger.sqlite');db=ledger(file);const authorize=async({authorizationId,inspection})=>{db.prepare('INSERT INTO attempts VALUES(?,?,?)').run(authorizationId,'signing_unknown',inspection.amountAtomic);return {...account,signTypedData:async()=>{signs++;throw new Error('lost signer response');}};};
 await assert.rejects(prepareNativeBaseMpp(fixture()).createCredential({authorize}),/lost signer response/);db.close();db=ledger(file);
 await assert.rejects(prepareNativeBaseMpp(fixture()).createCredential({authorize}));assert.equal(signs,1);
 }finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});

test('presentation and changed terms for one economic nonce retain one durable claim after uncertainty',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'native-mpp-nonce-'));let db,signs=0;
 try{const file=path.join(dir,'ledger.sqlite');db=ledger(file);const original=fixture();
 const first=prepareNativeBaseMpp(original);
 const formatted=fixture();formatted.challenge.wwwAuthenticate=formatted.challenge.wwwAuthenticate.replaceAll(', ', ',  ');
 const second=prepareNativeBaseMpp(formatted);
 assert.notEqual(first.inspection.challengeSha256,second.inspection.challengeSha256);
 assert.equal(first.authorizationId,second.authorizationId);
 const changed=fixture();const c=Challenge.deserialize(changed.challenge.wwwAuthenticate);c.request.amount='999';changed.challenge.wwwAuthenticate=Challenge.serialize(c);
 assert.equal(first.authorizationId,prepareNativeBaseMpp(changed).authorizationId);
 const authorize=async({authorizationId,inspection})=>{db.prepare('INSERT INTO attempts VALUES(?,?,?)').run(authorizationId,'signing_unknown',inspection.amountAtomic);return {...account,signTypedData:async()=>{signs++;throw new Error('lost signer response');}};};
 await assert.rejects(first.createCredential({authorize}),/lost signer response/);db.close();db=ledger(file);
 await assert.rejects(second.createCredential({authorize}));await assert.rejects(prepareNativeBaseMpp(changed).createCredential({authorize}));assert.equal(signs,1);
 const other=fixture();const oc=Challenge.deserialize(other.challenge.wwwAuthenticate);oc.id+='-new';other.challenge.wwwAuthenticate=Challenge.serialize(oc);assert.notEqual(first.authorizationId,prepareNativeBaseMpp(other).authorizationId);
 }finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});
