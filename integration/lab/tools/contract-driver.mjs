// Offline protocol fixture. Uses real seller/SDK code and fake facilitators.
// No wallet keys, public RPC calls, external HTTP, or valid payment signatures.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {once} from 'node:events';
import {x402ResourceServer} from '@x402/core/server';
import {ExactEvmScheme} from '@x402/evm/exact/server';
import {ExactSvmScheme} from '@x402/svm/exact/server';
import {ExactAvmScheme} from '@x402/avm/exact/server';
import {Seller} from '../dist/src/seller.js';
import {server} from '../dist/src/http-server.js';
import {Ledger} from '../dist/src/ledger.js';
import {loadConfig,RAILS,railInfo,OFFLINE_ADDRESSES} from '../dist/src/config.js';
import {FixtureFacilitator} from '../dist/src/transport.js';
import {fixturePayment} from '../dist/src/fixtures.js';
import {UTILITIES,example,utility} from '../dist/src/utilities.js';
import {encode64} from '../dist/src/json.js';
import {verifyReceipt,withVerifiedRoute} from '../../../sdk/route-guard/index.mjs';

const input=JSON.parse(readFileSync(0,'utf8'));
const config=loadConfig('config/offline.json');
config.origin='https://seller.example';config.ledgerPath=':memory:';
const ledger=new Ledger(':memory:');
const facilitators=Object.fromEntries(RAILS.map(rail=>[rail,new FixtureFacilitator(rail,config)]));
const seller=new Seller(config,ledger,facilitators);
// Construct mainnet wire terms with the official schemes while keeping the
// fixture's execution mode offline and its signatures deliberately invalid.
for(const rail of RAILS){
  const info=railInfo(rail,'mainnet'),fac=facilitators[rail];
  fac.getSupported=async()=>({kinds:[{x402Version:2,scheme:'exact',network:info.network,extra:{feePayer:OFFLINE_ADDRESSES[rail]}}],extensions:[],signers:{}});
  const srv=new x402ResourceServer(fac);
  srv.register(info.network,rail==='base'?new ExactEvmScheme():rail==='solana'?new ExactSvmScheme():new ExactAvmScheme());
  await srv.initialize();
  const [req]=await srv.buildPaymentRequirements({scheme:'exact',network:info.network,payTo:OFFLINE_ADDRESSES[rail],price:'$0.001',maxTimeoutSeconds:60});
  seller.servers.set(rail,srv);seller.requirements.set(rail,req);
}
seller.ready=true;
if(input.mode==='prepare'){
  console.log(JSON.stringify(RAILS.flatMap(rail=>UTILITIES.map(name=>({rail,name,challenge:seller.challenge(rail,name)})))));
  ledger.close();
}else{
  const {rail,name}=input.case;
  assert.ok(RAILS.includes(rail)&&UTILITIES.includes(name));
  const expected=config.origin+'/'+rail+'/'+name;
  assert.equal(input.response.url,expected);
  const app=server(seller);app.listen(0,'127.0.0.1');await once(app,'listening');
  const local='http://127.0.0.1:'+app.address().port+'/'+rail+'/'+name;
  try{
    const observed=await fetch(local,{redirect:'error'});assert.equal(observed.status,402);
    let raw=await observed.text();
    if(input.variant==='unsupported_schema'){const ch=JSON.parse(raw);ch.inputSchema={type:'object'};raw=JSON.stringify(ch);}
    const options={routeResponseJson:JSON.stringify(input.response),routeRequestJson:JSON.stringify(input.request),trustedLogVkey:input.vkey};
    const proof=verifyReceipt(options);
    let callbacks=0,result;
    try{
      await withVerifiedRoute({...options,request:{url:expected,method:input.variant==='different_method'?'POST':'GET'},
        challenge:{status:402,bodyText:raw},now:input.variant==='expired'?input.response.decision_binding.expires_at:undefined},async action=>{
        callbacks++;
        const header=encode64(fixturePayment(rail,action.accepted,'contract-'+rail+'-'+name));
        const paid=await fetch(local,{headers:{'PAYMENT-SIGNATURE':header},redirect:'error'});
        assert.equal(paid.status,200);const body=await paid.json();assert.deepEqual(body.result,utility(name,example(name)));
        const replay=await fetch(local,{headers:{'PAYMENT-SIGNATURE':header},redirect:'error'});
        assert.equal(replay.status,200);assert.deepEqual(await replay.json(),body);
        result={guard:'verified',delivery:'validated',replay:'same_result'};
      });
    }catch(error){
      if(callbacks)throw error;
      result={guard:'rejected',reason:error.code??'guard_failed'};
    }
    console.log(JSON.stringify({...result,callbacks,seller_settlements:facilitators[rail].settles,proof:proof.proof,external_payments:0}));
  }finally{await new Promise(resolve=>{app.close(resolve);app.closeAllConnections();});ledger.close();}
}
