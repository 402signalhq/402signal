import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { configuredBatchHttpMerchants } from "../src/batch-http-config.js";
import { ALGORAND_NATIVE_CHARGE_OPT_IN } from "../src/algorand-native-charge-config.js";
const recipient="N2JSJZCSORMYGYO2NSIYRUEMBFRHEOMYODVXV2MXYYHB5H2JVUGG6NJ4NQ";
const buyer="ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA";
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),"native-algo-config-")),file=join(dir,"config.json");
  const c={version:1,campaignId:"synthetic-"+randomUUID(),url:"https://merchant.example/algorand/mpp/sha256",
    rpcUrl:"https://rpc.example",buyer,recipient,network:"algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    asset:"31566704",amountAtomic:"1000",maxNetworkFeeMicroAlgo:"2000",createdAt:Date.now()-1000,expiresAt:Date.now()+600000};
  writeFileSync(file,JSON.stringify(c));
  const seller={ready:true,config:{mode:"mainnet",origin:"https://merchant.example",ledgerPath:join(dir,"seller.sqlite"),
    rails:{algorand:{payTo:recipient}}}} as any;
  return {dir,file,c,seller,env:{LAB_ALGORAND_MPP_CHARGE:ALGORAND_NATIVE_CHARGE_OPT_IN,LAB_ALGORAND_MPP_CHARGE_CONFIG:file}};
}
test("native charge defaults off and rejects malformed gates or non-MainNet deployment",async()=>{
  const f=fixture();
  try{
    assert.equal((await configuredBatchHttpMerchants(f.seller,{})).merchants.length,0);
    await assert.rejects(configuredBatchHttpMerchants(f.seller,{...f.env,LAB_ALGORAND_MPP_CHARGE:"yes"}));
    await assert.rejects(configuredBatchHttpMerchants({...f.seller,ready:false},f.env));
    await assert.rejects(configuredBatchHttpMerchants({...f.seller,config:{...f.seller.config,mode:"testnet"}},f.env));
    assert.deepEqual(readdirSync(f.dir),["config.json"]);
  }finally{rmSync(f.dir,{recursive:true,force:true});}
});
test("native registration is no-network, one-path, isolated and immutable across reopen",async()=>{
  const f=fixture();let fetches=0;
  const fetch=mock.method(globalThis,"fetch",async()=>{fetches++;throw Error("unexpected network");});
  try{
    let loaded=await configuredBatchHttpMerchants(f.seller,f.env);
    assert.equal(loaded.merchants.length,1);
    assert.equal(loaded.merchants[0]!.path,"/algorand/mpp/sha256");
    assert.equal(loaded.merchants[0]!.authorizationHeader,"authorization");
    const recovery=await loaded.merchants[0]!.request(f.c.url,undefined,true);
    assert.equal(recovery.status,409);await loaded.close();
    loaded=await configuredBatchHttpMerchants(f.seller,f.env);await loaded.close();
    writeFileSync(f.file,JSON.stringify({...f.c,maxNetworkFeeMicroAlgo:"3000"}));
    await assert.rejects(configuredBatchHttpMerchants(f.seller,f.env));
    assert.equal(fetches,0);
    assert.equal(readdirSync(join(f.dir,"algorand-native-charge")).length,1);
  }finally{fetch.mock.restore();rmSync(f.dir,{recursive:true,force:true});}
});
test("native config refuses foreign recipient/origin/RPC, secret fields, duplicates and symlinks before store",async()=>{
  const f=fixture();
  try{
    for(const change of [{recipient:buyer},{url:"https://other.example/algorand/mpp/sha256"},
      {rpcUrl:"http://127.0.0.1:1234"},{rpcUrl:"https://secret@rpc.example"},
      {rpcUrl:"https://rpc.example/path"},{signer:"never-a-key"},{feePayer:buyer},
      {expiresAt:f.c.createdAt+3600001}]) {
      writeFileSync(f.file,JSON.stringify({...f.c,...change}));
      await assert.rejects(configuredBatchHttpMerchants(f.seller,f.env));
    }
    writeFileSync(f.file,'{"version":1,"version":1}');
    await assert.rejects(configuredBatchHttpMerchants(f.seller,f.env));
    writeFileSync(f.file,JSON.stringify(f.c));
    const link=join(f.dir,"alias.json");symlinkSync(f.file,link);
    await assert.rejects(configuredBatchHttpMerchants(f.seller,{...f.env,LAB_ALGORAND_MPP_CHARGE_CONFIG:link}));
    assert(!readdirSync(f.dir).includes("algorand-native-charge"));
  }finally{rmSync(f.dir,{recursive:true,force:true});}
});
