import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, sign, verify, createPublicKey } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Address } from "@algorandfoundation/algokit-utils";
import { decodeTransaction, decodeSignedTransaction, encodeSignedTransaction, bytesForSigning, transactionCodec } from "@algorandfoundation/algokit-utils/transact";
import { algorand } from "@goplausible/algorand-mpp-sdk/client";
import { Challenge, Credential } from "mppx";
import { AlgorandManifestStore } from "../../batch-buyer/algorand/manifest-store.mjs";
import { createNativeAlgorandLabMerchant, validateNativeAlgorandLabConfig } from "../lab-merchant.mjs";
process.env.LIVE402_FIXTURE="1";
const NOW=1800000000000, NETWORK="algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const key=()=>{
  const p=generateKeyPairSync("ed25519");
  return {...p,address:new Address(p.publicKey.export({type:"spki",format:"der"}).subarray(-32)).toString()};
};
const buyer=key(),seller=key(),other=key();
async function fixture(mode="normal") {
  const dir=mkdtempSync(join(tmpdir(),"native-algo-lab-"));
  let clock=NOW, posts=0, gets=0, signed, pendingMode=mode, readsAfterPost=0;
  const app=createServer(async(req,res)=>{
    const reply=(body,status=200)=>{res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(body,(_k,v)=>typeof v==="bigint"?Number(v):v));};
    if(req.method==="POST") {
      posts++;assert.equal(req.url,"/v2/transactions");
      const chunks=[];for await(const b of req)chunks.push(b);
      signed=decodeSignedTransaction(Buffer.concat(chunks));
      const publicKey=createPublicKey({key:Buffer.concat([Buffer.from("302a300506032b6570032100","hex"),signed.txn.sender.publicKey]),format:"der",type:"spki"});
      assert(verify(null,bytesForSigning.transaction(signed.txn),publicKey,signed.sig));
      if(mode==="lost-post"){req.socket.destroy();return;}
      return reply({txId:mode==="wrong-id" ? "WRONG" : signed.txn.txId()});
    }
    gets++;
    if(req.url==="/v2/transactions/params")
      return reply({fee:0,"min-fee":1000,"last-round":1000,"genesis-hash":NETWORK.slice(9),"genesis-id":"mainnet-v1.0"});
    readsAfterPost++;
    assert.equal(req.url,"/v2/transactions/pending/"+signed.txn.txId());
    if(pendingMode==="unavailable" && readsAfterPost>1) return reply({},503);
    // Decode signed bytes separately: transactionCodec models public RPC effects.
    const transaction=decodeSignedTransaction(Buffer.from(Credential.deserialize(await credential).payload.paymentGroup[0],"base64")).txn;
    if(pendingMode==="wrong-effects") transaction.assetTransfer.amount=999n;
    return reply({"confirmed-round":1001,txn:{txn:transactionCodec.encode(transaction,"json")}});
  });
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  const config={version:1,campaignId:"synthetic-campaign-one",url:"https://merchant.example/algorand/mpp/sha256",
    rpcUrl:"http://127.0.0.1:"+app.address().port,buyer:buyer.address,recipient:seller.address,
    network:NETWORK,asset:"31566704",amountAtomic:"1000",maxNetworkFeeMicroAlgo:"2000",
    createdAt:NOW-1000,expiresAt:NOW+600000};
  let store=new AlgorandManifestStore(join(dir,"merchant.sqlite"));
  let merchant=createNativeAlgorandLabMerchant({config,journal:store,now:()=>clock});
  let credential;
  async function authorize() {
    const challenge=await merchant.request(config.url);
    assert.equal(challenge.status,402);
    const decoded=Challenge.deserialize(challenge.headers["WWW-Authenticate"]);
    assert.equal(decoded.request.methodDetails.feePayer,undefined);
    const client=algorand.charge({senderAddress:buyer.address,algodUrl:"https://unused.invalid",
      signer:async(raw,indexes)=>raw.map((b,i)=>indexes.includes(i)?
        encodeSignedTransaction({txn:decodeTransaction(b),sig:sign(null,bytesForSigning.transaction(decodeTransaction(b)),buyer.privateKey)}):null)});
    credential=await client.createCredential({challenge:decoded});
    return credential;
  }
  return {config,authorize,get merchant(){return merchant;},get posts(){return posts;},get gets(){return gets;},
    advance:n=>clock+=n,setMode:m=>pendingMode=m,
    reopen:()=>{store.close();store=new AlgorandManifestStore(join(dir,"merchant.sqlite"));
      merchant=createNativeAlgorandLabMerchant({config,journal:store,now:()=>clock});},
    second:()=>{const s=new AlgorandManifestStore(join(dir,"merchant.sqlite"));return {
      merchant:createNativeAlgorandLabMerchant({config,journal:s,now:()=>clock}),close:()=>s.close()};},
    close:async()=>{store.close();await new Promise(r=>app.close(r));rmSync(dir,{recursive:true,force:true});}};
}
test("actual SDK buyer-paid one-charge HTTP broadcast, full readback and restart preserve original receipt",async()=>{
  const f=await fixture();
  try {
    const h=await f.authorize(), other=f.second();
    let results;
    try {results=await Promise.all([f.merchant.request(f.config.url,h),other.merchant.request(f.config.url,h)]);}
    finally {other.close();}
    assert.equal(results.filter(r=>r.status===200).length,1);
    assert.equal(results.filter(r=>r.status===409).length,1);
    const success=results.find(r=>r.status===200);
    assert(success.headers["Payment-Receipt"]);
    assert.equal(success.body.payment.confirmedRound,1001);
    assert.equal(f.posts,1);
    f.reopen();f.advance(1000000);
    assert.deepEqual(await f.merchant.request(f.config.url,h),success);
    assert.deepEqual(await f.merchant.request(f.config.url,undefined,true),success);
    assert.equal((await f.merchant.request(f.config.url,h,true)).status,400);
    assert.equal(f.posts,1);
  } finally {await f.close();}
});
test("lost broadcast acknowledgment is permanently fenced across restart, concurrency and read-only reconciliation",async()=>{
  const f=await fixture("lost-post");
  try {
    const h=await f.authorize();
    assert.equal((await f.merchant.request(f.config.url,h)).status,409);
    f.reopen();
    const before=f.gets;
    assert.equal((await f.merchant.request(f.config.url,h)).status,409);
    assert.equal(f.gets,before);
    assert.equal((await f.merchant.reconcile()).status,409);
    assert.equal((await f.merchant.request(f.config.url)).status,409);
    assert.equal(f.posts,1);
  } finally {await f.close();}
});
test("SDK acknowledgment without matching full transaction cannot claim fulfillment; read-only repair preserves receipt",async()=>{
  for(const mode of ["wrong-effects","unavailable","wrong-id"]) {
    const f=await fixture(mode);
    try {
      const h=await f.authorize();
      assert.equal((await f.merchant.request(f.config.url,h)).status,409);
      assert.equal(f.posts,1);f.reopen();f.setMode("normal");
      const recovered=await f.merchant.reconcile();
      assert.equal(recovered.status,mode==="wrong-id"?409:200);
      assert.equal(f.posts,1);
    } finally {await f.close();}
  }
});
test("changed challenge, buyer, request, signature, effects and expired issued offer cannot broadcast",async()=>{
  const f=await fixture();
  try {
    const h=await f.authorize(), c=Credential.deserialize(h);
    for(const mutate of [
      x=>x.challenge.id+="x",x=>x.challenge.realm="other.example",
      x=>x.challenge.request.amount="1001",x=>x.challenge.request.recipient=other.address,
      x=>x.source=other.address,x=>x.payload.paymentIndex=1,
      x=>x.payload.paymentGroup.push(x.payload.paymentGroup[0]),
      x=>{const s=decodeSignedTransaction(Buffer.from(x.payload.paymentGroup[0],"base64"));s.sig[0]^=1;x.payload.paymentGroup[0]=Buffer.from(encodeSignedTransaction(s)).toString("base64");},
      x=>{const s=decodeSignedTransaction(Buffer.from(x.payload.paymentGroup[0],"base64"));s.txn.rekeyTo=Address.fromString(other.address);s.sig=sign(null,bytesForSigning.transaction(s.txn),buyer.privateKey);x.payload.paymentGroup[0]=Buffer.from(encodeSignedTransaction(s)).toString("base64");},
    ]) {
      const bad=structuredClone(c);mutate(bad);
      assert.equal((await f.merchant.request(f.config.url,Credential.serialize(bad))).status,400);
    }
    assert.equal((await f.merchant.request(f.config.url+"?extra=1",h)).status,400);
    f.advance(61000);
    assert.equal((await f.merchant.request(f.config.url,h)).status,400);
    assert.equal((await f.merchant.request(f.config.url)).status,409);
    assert.equal(f.posts,0);
  } finally {await f.close();}
});
test("campaign/chain/recipient/deadline/price/fee bounds and durable scope refuse substitutions",async()=>{
  const f=await fixture();
  try {
    for(const change of [{network:"algorand:testnet"},{asset:"0"},{amountAtomic:"2000"},
      {buyer:seller.address},{recipient:buyer.address},{campaignId:"../escape"},{campaignId:undefined},
      {maxNetworkFeeMicroAlgo:"999"},{maxNetworkFeeMicroAlgo:"20001"},
      {expiresAt:NOW+3600001},{url:f.config.url+"?x=1"},{extra:true}])
      assert.throws(()=>validateNativeAlgorandLabConfig({...f.config,...change},NOW));
    assert.equal(f.posts,0);assert.equal(f.gets,0);
  } finally {await f.close();}
});
test("durability failure at the send boundary never starts SDK broadcasting",async()=>{
  const f=await fixture();
  try {
    const h=await f.authorize();
    // A second instance with a real store, failing only the send commit.
    // Retain the real issued offer; inject failure through the store method itself.
    const prototype=AlgorandManifestStore.prototype, original=prototype.once;
    prototype.once=function(key,value){
      if(value?.authorizationDigest && value?.credential) throw Error("synthetic disk failure");
      return original.call(this,key,value);
    };
    try {assert.equal((await f.merchant.request(f.config.url,h)).status,409);}
    finally {prototype.once=original;}
    assert.equal(f.posts,0);
  } finally {await f.close();}
});
test("one fresh challenge is retained; concurrent issuance and expired challenge never refresh terms",async()=>{
  const f=await fixture(), second=f.second();
  try {
    const responses=await Promise.all([f.merchant.request(f.config.url),second.merchant.request(f.config.url)]);
    assert.equal(responses.filter(x=>x.status===402).length,1);
    assert.equal(responses.filter(x=>x.status===409).length,1);
    const good=responses.find(x=>x.status===402);
    assert.deepEqual(await f.merchant.request(f.config.url),good);
    assert.equal(f.gets,1);
    f.reopen();f.advance(61000);
    assert.equal((await f.merchant.request(f.config.url)).status,409);
    assert.equal(f.gets,1);
  } finally {second.close();await f.close();}
});
