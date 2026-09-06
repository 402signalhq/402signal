import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Address } from '@algorandfoundation/algokit-utils';
import { Transaction, TransactionType, groupTransactions, encodeTransactionRaw as encodeTransaction, encodeSignedTransaction, transactionCodec } from '@algorandfoundation/algokit-utils/transact';
import { address, getAddressEncoder, getBase58Decoder, createTransactionMessage, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions, compileTransaction,
  getTransactionEncoder } from '@solana/kit';
import { encodeEventTopics, encodeAbiParameters, parseAbi } from 'viem';
import { checkBaseTypedData, checkSolanaMessage, checkAlgorandGroup, paymentIntent, tokenAccount,
  ALGO_GENESIS, SOL_GENESIS, COMPUTE, TOKEN, MEMO, type MainnetPolicy, type PaymentIntent } from '../src/mainnet-policy.js';
import { paymentIdentity } from '../src/identity.js';
import { confirmOnce, rpc } from '../src/confirmation.js';
import { RAILS, railInfo, type Rail } from '../src/config.js';
import { Buyer, validateBuyer, type BuyerConfig } from '../src/buyer.js';
import { Ledger } from '../src/ledger.js';
import { createWallets } from '../src/wallets.js';
import { canonical, encode64 } from '../src/json.js';
import { utility, example } from '../src/utilities.js';
import type { PaymentRequirements, PaymentPayload } from '@x402/core/types';
import type { Transport } from '../src/transport.js';

const solAddress = (n:number) => getBase58Decoder().decode(new Uint8Array(32).fill(n));
const buyers = {base:'0x2222222222222222222222222222222222222222',solana:solAddress(2),algorand:new Address(new Uint8Array(32).fill(2)).toString()};
const sellers = {base:'0x3333333333333333333333333333333333333333',solana:solAddress(3),algorand:new Address(new Uint8Array(32).fill(3)).toString()};
const fees = {base:'',solana:solAddress(4),algorand:new Address(new Uint8Array(32).fill(4)).toString()};
const policy: MainnetPolicy = {workflow:'seller_only',buyerAddresses:buyers,rpcUrls:{base:'https://base.example',solana:'https://sol.example',algorand:'https://algo.example'},buyerNativeFeeAtomic:'0'};
function config(): BuyerConfig {return {mode:'mainnet', routerUrl:'https://staging.example/route',sellerOrigin:'https://seller.example',ledgerPath:':memory:',
  sellerMaxAtomic:'1000',sellerPayTo:sellers,routerPayTo:sellers,feePayers:{base:[],solana:[fees.solana],algorand:[fees.algorand]},
  capAtomicPerRail:{base:'10000',solana:'10000',algorand:'10000'},mainnet:structuredClone(policy)};}
function req(rail:Rail): PaymentRequirements { const info = railInfo(rail,'mainnet'); return {scheme:'exact',network:info.network,asset:info.asset,amount:'1000',payTo:sellers[rail],maxTimeoutSeconds:60,
  extra:rail === 'base' ? {name:'USD Coin',version:'2'} : {feePayer:fees[rail]}}; }
function algoTransactions() {
  const shared = {genesisHash:Buffer.from(ALGO_GENESIS,'base64'),genesisId:'mainnet-v1.0',firstValid:1000n,lastValid:2000n,note:Buffer.from('x402-offline-mainnet-test')};
  return groupTransactions([new Transaction({...shared,type:TransactionType.Payment,sender:Address.fromString(fees.algorand),fee:2000n,
    payment:{receiver:Address.fromString(fees.algorand),amount:0n}}), new Transaction({...shared,type:TransactionType.AssetTransfer,sender:Address.fromString(buyers.algorand),fee:0n,
    assetTransfer:{receiver:Address.fromString(sellers.algorand),assetId:31566704n,amount:1000n}})]);
}
async function solTransaction(mutate?:(instructions:any[])=>void) {
  const r = req('solana'), source = await tokenAccount(buyers.solana,r.asset), destination = await tokenAccount(sellers.solana,r.asset);
  const limit = Buffer.alloc(5); limit[0]=2; limit.writeUInt32LE(20000,1);
  const price = Buffer.alloc(9); price[0]=3; price.writeBigUInt64LE(1n,1);
  const transfer = Buffer.alloc(10); transfer[0]=12;transfer.writeBigUInt64LE(1000n,1);transfer[9]=6;
  const instructions:any[] = [{programAddress:address(COMPUTE),accounts:[],data:limit},{programAddress:address(COMPUTE),accounts:[],data:price},
    {programAddress:address(TOKEN),accounts:[{address:address(source),role:1},{address:address(r.asset),role:0},{address:address(destination),role:1},{address:address(buyers.solana),role:2}],data:transfer},
    {programAddress:address(MEMO),accounts:[],data:Buffer.from('a'.repeat(32))}];
  mutate?.(instructions);
  const m = appendTransactionMessageInstructions(instructions,setTransactionMessageLifetimeUsingBlockhash({blockhash:address(solAddress(9)) as any,lastValidBlockHeight:2000n},
    setTransactionMessageFeePayer(address(fees.solana),createTransactionMessage({version:0}))));
  return compileTransaction(m);
}
async function payment(rail:Rail):Promise<PaymentPayload> {
  let payload:any;
  if(rail==='base') payload={authorization:{nonce:'0x'+'ab'.repeat(32)},signature:'INVALID_FIXTURE'};
  else if(rail==='solana') payload={transaction:Buffer.from(getTransactionEncoder().encode(await solTransaction())).toString('base64')};
  else {const tx=algoTransactions();payload={paymentIndex:1,paymentGroup:[Buffer.from(encodeTransaction(tx[0]!)).toString('base64'),Buffer.from(encodeSignedTransaction({txn:tx[1]!,sig:new Uint8Array(64).fill(1)})).toString('base64')]};}
  return {x402Version:2,accepted:req(rail),payload};
}

test('mainnet policy refuses native fee allowance and production router',()=>{
  const c=config();assert.equal(validateBuyer(c).mode,'mainnet');
  assert.throws(()=>validateBuyer({...c,mainnet:{...policy,buyerNativeFeeAtomic:'1'} as any}),/sponsored/);
  assert.throws(()=>validateBuyer({...c,routerUrl:'https://402signal.com/route'}),/production_router/);
});
test('Base guard permits only exact USDC EIP-3009 and bounded expiry',()=>{
  const r=req('base');const d:any={primaryType:'TransferWithAuthorization',domain:{name:'USD Coin',version:'2',chainId:8453,verifyingContract:r.asset},
    types:{TransferWithAuthorization:[['from','address'],['to','address'],['value','uint256'],['validAfter','uint256'],['validBefore','uint256'],['nonce','bytes32']].map(([name,type])=>({name,type}))},
    message:{from:buyers.base,to:r.payTo,value:1000n,validAfter:0n,validBefore:1060n,nonce:'0x'+'ab'.repeat(32)}};
  checkBaseTypedData(d,r,buyers.base,1000);
  for(const mutate of [(x:any)=>x.domain.chainId=1,(x:any)=>x.domain.verifyingContract=buyers.base,(x:any)=>x.domain.name='FAKE',
    (x:any)=>x.message.to=buyers.base,(x:any)=>x.message.value=1001n,(x:any)=>x.message.validBefore=1061n,(x:any)=>x.primaryType='Permit',
    (x:any)=>x.types.TransferWithAuthorization[0].type='bytes32']) {
    const bad=structuredClone(d);mutate(bad);assert.throws(()=>checkBaseTypedData(bad,r,buyers.base,1000));
  }
});
test('Solana guard rejects transfers, delegates, fee changes and extra instructions before signing',async()=>{
  await checkSolanaMessage(new Uint8Array((await solTransaction()).messageBytes),req('solana'),buyers.solana);
  for(const change of [(ix:any[])=>ix[2].data.writeBigUInt64LE(1001n,1),(ix:any[])=>ix[2].data[0]=4,
    (ix:any[])=>ix[2].accounts[2].address=address(solAddress(8)),(ix:any[])=>ix.push(ix[2]),
    (ix:any[])=>ix[1].data.writeBigUInt64LE(2n,1),(ix:any[])=>ix[0].data.writeUInt32LE(20001,1),
    (ix:any[])=>ix[3].programAddress=address('11111111111111111111111111111111')]) {
    const tx=await solTransaction(change);await assert.rejects(checkSolanaMessage(new Uint8Array(tx.messageBytes),req('solana'),buyers.solana));
  }
  await assert.rejects(checkSolanaMessage(new Uint8Array((await solTransaction()).messageBytes),{...req('solana'),extra:{feePayer:buyers.solana}},buyers.solana));
});
test('Algorand guard rejects buyer fees, rekey, close, clawback, wrong chain and group mutation',()=>{
  const good=algoTransactions();checkAlgorandGroup(good.map(t=>encodeTransaction(t)),[1],req('algorand'),buyers.algorand);
  for(const mutate of [(p:Transaction)=>p.fee=1n,(p:Transaction)=>p.rekeyTo=Address.fromString(sellers.algorand),
    (p:Transaction)=>p.assetTransfer!.closeRemainderTo=Address.fromString(sellers.algorand),
    (p:Transaction)=>p.assetTransfer!.assetSender=Address.fromString(sellers.algorand),
    (p:Transaction)=>p.assetTransfer!.amount=1001n,(p:Transaction)=>p.genesisHash=new Uint8Array(32),
    (p:Transaction)=>p.group=new Uint8Array(32),(p:Transaction)=>p.lastValid=2001n]) {
    const txs=algoTransactions();mutate(txs[1]!);assert.throws(()=>checkAlgorandGroup(txs.map(t=>encodeTransaction(t)),[1],req('algorand'),buyers.algorand));
  }
  assert.throws(()=>checkAlgorandGroup(good.map(t=>encodeTransaction(t)),[0,1],req('algorand'),buyers.algorand));
});

async function confirmedFixture(rail:Rail) {
  const signed=await payment(rail), intent=paymentIntent(rail,req(rail),signed,buyers[rail]);
  const id=rail==='base'?'0x'+'12'.repeat(32):rail==='algorand'?intent.transaction!:getBase58Decoder().decode(new Uint8Array(64).fill(7));
  const tx = rail==='solana'?await solTransaction():undefined;
  const logs = rail==='base'?[
    {address:req('base').asset,topics:encodeEventTopics({abi:parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']),eventName:'Transfer',args:{from:buyers.base as any,to:sellers.base as any}}),data:encodeAbiParameters([{type:'uint256'}],[1000n])},
    {address:req('base').asset,topics:encodeEventTopics({abi:parseAbi(['event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)']),eventName:'AuthorizationUsed',args:{authorizer:buyers.base as any,nonce:intent.nonce as any}}),data:'0x'}]:[];
  const responses:any={eth_chainId:'0x2105',getGenesisHash:SOL_GENESIS,
    eth_getTransactionReceipt:{transactionHash:id,status:'0x1',blockHash:'0xabc',blockNumber:'0x10',logs},
    eth_getBlockByNumber:{hash:'0xabc'},eth_blockNumber:'0x11',eth_getTransactionByHash:{hash:id,from:sellers.base},
    getTransaction:tx?{meta:{err:null,fee:10001,preBalances:[1000000,0,0,0,0,0,0,0,0],postBalances:[989999,0,0,0,0,0,0,0,0]},transaction:[Buffer.from(getTransactionEncoder().encode({...tx,signatures:{...tx.signatures,[fees.solana]:new Uint8Array(64).fill(7)}})).toString('base64'),'base64']}:null};
  const algo=rail==='algorand'?{'confirmed-round':2010,txn:{txn:transactionCodec.encode(algoTransactions()[1]!,'json')}}:null;
  const send:Transport=async(_u,m,b:any)=>({status:200,headers:new Headers(),body:m==='POST'?{jsonrpc:'2.0',id:1,result:responses[b.method]}:
    _u.endsWith('/params')?{'genesis-hash':ALGO_GENESIS,'genesis-id':'mainnet-v1.0'}:algo});
  return {intent,id,responses,algo,send};
}
for(const rail of RAILS) {
 test(`${rail}: confirmation binds current authorization and rejects bad receipt or unavailable RPC`,async()=>{
  const f=await confirmedFixture(rail);
  assert.equal((await confirmOnce(policy,f.intent,f.id,f.send)).state,'confirmed');
  const altered={...f.intent};if(rail==='base')altered.nonce='0x'+'cd'.repeat(32);if(rail==='solana')altered.messageHash='bad';if(rail==='algorand')altered.transaction='A'.repeat(52);
  assert.equal((await confirmOnce(policy,altered,f.id,f.send)).state,'unknown');
  assert.equal((await confirmOnce(policy,f.intent,f.id,async()=>{throw new Error('SECRET_RPC_ERROR');})).state,'unknown');
  if(rail==='base')f.responses.eth_getTransactionReceipt.status='0x0';
  if(rail==='solana')f.responses.getTransaction.meta.err={InstructionError:[0,'error']};
  if(rail==='algorand')f.algo!['confirmed-round']=0;
  assert.equal((await confirmOnce(policy,f.intent,f.id,f.send)).state,'unknown');
 });
 test(`${rail}: mainnet intent durable before POST; unknown freezes rail across restart`,async()=>{
  const root=mkdtempSync(join(tmpdir(),'mainnet-ledger-')),path=join(root,'buyer.sqlite');let ledger=new Ledger(path);
  const c=config();const p=await payment(rail);const id=rail==='base'?'0x'+'12'.repeat(32):rail==='solana'?'2'.repeat(88):paymentIntent(rail,req(rail),p,buyers[rail]).transaction!;
  let posts=0;
  const send:Transport=async(u,_m,_b,h)=>{
    assert(u.startsWith(c.sellerOrigin));
    if(h?.['PAYMENT-SIGNATURE']) {posts++;assert.equal(ledger.getIntent('pilot').intent.buyer,buyers[rail]);return {status:200,headers:new Headers({'PAYMENT-RESPONSE':encode64({success:true,transaction:id,network:req(rail).network})}),body:{result:utility('payload/sha256',example('payload/sha256'))}};}
    const body={x402Version:2,resource:{url:u},accepts:[req(rail)]};return {status:402,headers:new Headers({'PAYMENT-REQUIRED':encode64(body)}),body};
  };
  try {
   const report=await new Buyer(c,ledger,async()=>p,send,async()=>({state:'unknown'})).run('pilot',rail,'payload/sha256',true);
   assert.equal(report.delivery,'validated');assert.equal(report.chain_confirmation?.state,'unknown');assert.equal(posts,1);
   ledger.close();ledger=new Ledger(path);
   await assert.rejects(new Buyer(c,ledger,async()=>p,send,async()=>({state:'confirmed'})).run('next',rail,'payload/sha256',true),/unresolved/);
   assert.equal(posts,1);assert(!JSON.stringify(ledger.db.prepare('SELECT * FROM intents').all()).includes('INVALID_FIXTURE'));
  } finally {ledger.close();rmSync(root,{recursive:true});}
 });
}
test('mainnet routing, missing confirmer and changed campaign fail before signatures or HTTP',async()=>{
 const l=new Ledger(':memory:');const c=config();let calls=0;
 try {const buyer=new Buyer(c,l,async()=>{calls++;throw new Error();},async()=>{calls++;throw new Error();});
  await assert.rejects(buyer.run('x','base','payload/sha256',false),/seller_only/);
  await assert.rejects(buyer.run('y','base','payload/sha256',true),/confirmation/);assert.equal(calls,0);
  l.bindCampaign('first');assert.throws(()=>l.bindCampaign('second'),/scope_changed/);
 } finally {l.close();}
});
test('RPC helper never admits broadcast methods',async()=>{
 let calls=0;await assert.rejects(rpc('https://rpc.example','sendTransaction',[],async()=>{calls++;throw new Error();}),/write_method_refused/);assert.equal(calls,0);
});
test('wallet setup uses exclusive private storage, different roles, and public-only output',async()=>{
 const root=mkdtempSync(join(tmpdir(),'wallet-test-')),dir=join(root,'mainnet');
 try {const result=await createWallets(dir);assert.equal(statSync(dir).mode & 0o777,0o700);
  const secret=readFileSync(join(dir,'buyer-mainnet.env'),'utf8');assert.equal(statSync(join(dir,'buyer-mainnet.env')).mode & 0o777,0o600);
  for(const r of RAILS)assert.notEqual(result.public_addresses.buyer![r],result.public_addresses.seller![r]);
  for(const line of secret.trim().split('\n'))assert(!JSON.stringify(result).includes(line.slice(line.indexOf('=')+1)));
  await assert.rejects(createWallets(dir));assert.equal(readFileSync(join(dir,'buyer-mainnet.env'),'utf8'),secret);
 } finally {rmSync(root,{recursive:true});}
});

test('actual pinned SDKs construct all three mainnet payloads through guarded signers using fake RPC only',async()=>{
 const {sdkSigner}=await import('../src/signer-sdk.js');
 const {privateKeyToAccount,generatePrivateKey}=await import('viem/accounts');
 const {ed25519Generator}=await import('@algorandfoundation/algokit-utils/crypto');
 const {createKeyPairSignerFromBytes}=await import('@solana/kit');
 const {toClientAvmSigner}=await import('@x402/avm');
 const c=config(),baseKey=generatePrivateKey(),sol=ed25519Generator(),algo=ed25519Generator();
 const solKey=Buffer.concat([sol.ed25519SecretKey,sol.ed25519Pubkey]),algoKey=Buffer.concat([algo.ed25519SecretKey,algo.ed25519Pubkey]);
 c.mainnet!.buyerAddresses={base:privateKeyToAccount(baseKey).address,solana:(await createKeyPairSignerFromBytes(solKey)).address,algorand:toClientAvmSigner(algoKey.toString('base64')).address};
 const env={LAB_ALLOW_NETWORK:'1',LAB_MAINNET_ACK:'reviewed-separate-self-test-lab',LAB_BUYER_ACK:'mainnet-sponsored-seller-pilot',
  LAB_BUYER_BASE_PRIVATE_KEY:baseKey,LAB_BUYER_SOLANA_KEY_B64:solKey.toString('base64'),LAB_BUYER_ALGORAND_KEY_B64:algoKey.toString('base64')};
 const original=globalThis.fetch;let writes=0;const methods:string[]=[];
 globalThis.fetch=async(input:any,init?:RequestInit)=>{
  const url=String(input),body=init?.body?JSON.parse(String(init.body)):null;
  assert(['https://base.example','https://sol.example','https://algo.example'].some(h=>url.startsWith(h)),'unexpected RPC host');
  if(body){methods.push(body.method);let result:any;
   if(body.method==='eth_chainId') result='0x2105';
   else if(body.method==='getGenesisHash')result=SOL_GENESIS;
   else if(body.method==='getLatestBlockhash')result={context:{slot:1000},value:{blockhash:solAddress(9),lastValidBlockHeight:2000}};
   else if(body.method==='getAccountInfo') {const mint=Buffer.alloc(82);mint[44]=6;mint[45]=1;
    result={context:{slot:1000},value:{data:[mint.toString('base64'),'base64'],executable:false,lamports:1000000,owner:TOKEN,rentEpoch:0,space:82}};
   } else {writes++;throw new Error('UNEXPECTED_RPC_METHOD');}
   return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result}),{status:200});
  }
  assert(url==='https://algo.example/v2/transactions/params','unexpected Algod read');
  return new Response(JSON.stringify({'genesis-hash':ALGO_GENESIS,'genesis-id':'mainnet-v1.0','last-round':1000,'min-fee':1000,fee:0,'consensus-version':'test'}),{status:200,headers:{'Content-Type':'application/json'}});
 };
 try {
  const signer=sdkSigner(c,env);
  for(const rail of RAILS) {
   const r=req(rail),ch:any={x402Version:2,resource:{url:c.sellerOrigin+'/'+rail+'/payload/sha256'},accepts:[r],extensions:{UNTRUSTED:'ignored'}};
   const signed=await signer(rail,ch);assert.equal(canonical(signed.accepted),canonical(r));
   const intent=paymentIntent(rail,r,signed,c.mainnet!.buyerAddresses[rail]);assert.equal(intent.buyer,c.mainnet!.buyerAddresses[rail]);
   const identity=paymentIdentity(rail,signed,r);assert.equal(paymentIdentity(rail,{...signed,resource:{url:'https://metadata.example'}} as any,r),identity);
   if(rail==='algorand') {const changed=structuredClone(signed); const group=(changed.payload as any).paymentGroup; group[0]=Buffer.concat([Buffer.from('TX'),Buffer.from(group[0],'base64')]).toString('base64'); assert.equal(paymentIdentity(rail,changed,r),identity);}
  }
  const routed=structuredClone(c);routed.routerUrl='https://402signal.com/route';
  routed.routerPayTo={base:'0x'+'66'.repeat(20),solana:solAddress(6),algorand:new Address(new Uint8Array(32).fill(6)).toString()};
  routed.routePilot={protocol:'402signal-lab-route-v2',routerFeePayers:structuredClone(c.feePayers)};
  const routeEnv={...env,LAB_BUYER_ACK:'mainnet-sponsored-route-pilot'};
  const routerSign=sdkSigner(routed,routeEnv,'router');
  for(const rail of RAILS) {
    const r={...req(rail),amount:'3000',payTo:routed.routerPayTo[rail]};
    const ch:any={x402Version:2,resource:{url:routed.routerUrl},accepts:[r]};
    const signed=await routerSign(rail,ch);assert.equal(canonical(signed.accepted),canonical(r));
    assert.equal(paymentIntent(rail,r,signed,routed.mainnet!.buyerAddresses[rail]).amount,'3000');
    await assert.rejects(routerSign(rail,{...ch,accepts:[{...r,amount:'1000'}]}),/recipient_or_price/);
    await assert.rejects(routerSign(rail,{...ch,resource:{url:'https://untrusted.example/route'}}),/resource_mismatch/);
    await assert.rejects(sdkSigner(routed,routeEnv,'seller')(rail,ch),/recipient_or_price/);
  }
  assert.equal(writes,0);assert(methods.includes('getLatestBlockhash'));
  const wrong=structuredClone(c);wrong.mainnet!.buyerAddresses.base=sellers.base;
  await assert.rejects(sdkSigner(wrong,env)('base',{x402Version:2,resource:{url:c.sellerOrigin},accepts:[req('base')]}),/distinct_buyer|buyer_address_mismatch/);
 } finally {globalThis.fetch=original;}
});

for (const rail of RAILS) test(`${rail}: confirmed mainnet delivery completes, cap and disk boundaries prevent another economic action`,async()=>{
 const c=config();c.capAtomicPerRail[rail]='1000'; const p=await payment(rail),f=await confirmedFixture(rail);let posts=0;
 const ledger=new Ledger(':memory:');
 const send:Transport=async(u,_m,_b,h)=>{
  if(h?.['PAYMENT-SIGNATURE']) {posts++;return {status:200,body:{result:utility('payload/sha256',example('payload/sha256'))},headers:new Headers({'PAYMENT-RESPONSE':encode64({success:true,network:req(rail).network,transaction:f.id})})};}
  const body={x402Version:2,resource:{url:u},accepts:[req(rail)]};return {status:402,body,headers:new Headers({'PAYMENT-REQUIRED':encode64(body)})};
 };
 try {
  const b=new Buyer(c,ledger,async()=>p,send,async(i,id)=>confirmOnce(policy,i,id,f.send));
  const report=await b.run('confirmed',rail,'payload/sha256',true);
  assert.equal(report.error,undefined);assert.equal(report.delivery,'validated');assert.equal(report.seller_settlement,'chain_confirmed');
  assert.equal(report.chain_confirmation?.state,'confirmed');assert.equal(posts,1);
  await assert.rejects(b.run('next',rail,'payload/sha256',true),/cap_exceeded/);assert.equal(posts,1);
 } finally {ledger.close();}
 const broken=new Ledger(':memory:');
 try {
  broken.recordIntent=()=>{throw new Error('DISK_ERROR_CANARY');};posts=0;
  const report=await new Buyer(c,broken,async()=>p,send,async()=>({state:'confirmed'})).run('disk',rail,'payload/sha256',true);
  assert.equal(posts,0);assert.equal(report.seller_settlement,'not_attempted');assert(!JSON.stringify(report).includes('CANARY'));
 } finally {broken.close();}
});
test('mainnet campaign binding refuses existing offline data and concurrent pending reservations',()=>{
 const root=mkdtempSync(join(tmpdir(),'mainnet-concurrency-')),path=join(root,'spend.sqlite');const a=new Ledger(path),b=new Ledger(path);
 try {a.bindCampaign('scope');b.bindCampaign('scope');a.reserveSpend('first','base','1000','10000',true);
  assert.throws(()=>b.reserveSpend('second','base','1000','10000',true),/unresolved/);
  a.spendState('first','not_submitted');b.reserveSpend('second','base','1000','10000',true);
  assert.equal((a.db.prepare('SELECT sum(amount) as n FROM spend').get() as any).n,2000);
 } finally {a.close();b.close();rmSync(root,{recursive:true});}
 const old=new Ledger(':memory:');try{old.reserveSpend('offline','base','1000','1000');assert.throws(()=>old.bindCampaign('scope'),/fresh_mainnet/);}finally{old.close();}
});
test('confirmation refuses native debits and insufficient Base depth',async()=>{
 const base=await confirmedFixture('base');base.responses.eth_blockNumber='0x10';
 assert.equal((await confirmOnce(policy,base.intent,base.id,base.send)).state,'unknown');
 base.responses.eth_blockNumber='0x11';base.responses.eth_getTransactionByHash.from=buyers.base;
 assert.equal((await confirmOnce(policy,base.intent,base.id,base.send)).state,'unknown');
 const sol=await confirmedFixture('solana');sol.responses.getTransaction.meta.preBalances[1]=100;sol.responses.getTransaction.meta.postBalances[1]=99;
 assert.equal((await confirmOnce(policy,sol.intent,sol.id,sol.send)).state,'unknown');
});
test('mainnet setup only copies public addresses, starts zero caps, and refuses overwrite',async()=>{
 const {configureMainnet}=await import('../src/setup.js');const root=mkdtempSync(join(tmpdir(),'setup-test-'));
 try{await createWallets(join(root,'wallets'));const result=configureMainnet(join(root,'config'),join(root,'wallets','addresses.json'));
  assert.equal(canonical(result.cap_atomic_per_rail),canonical({base:'0',solana:'0',algorand:'0'}));
  const buyer=JSON.parse(readFileSync(join(root,'config','buyer-mainnet.json'),'utf8'));
  assert.equal(buyer.mode,'mainnet');assert.equal(buyer.mainnet.buyerNativeFeeAtomic,'0');
  assert(!JSON.stringify(buyer).includes('PRIVATE_KEY'));
  assert.throws(()=>configureMainnet(join(root,'config'),join(root,'wallets','addresses.json')));
 }finally{rmSync(root,{recursive:true});}
});
test('all mainnet server requirements match advertised GoPlausible exact kinds, including full Algorand ID',async()=>{
 const {x402ResourceServer}=await import('@x402/core/server');
 const {ExactEvmScheme}=await import('@x402/evm/exact/server');const {ExactSvmScheme}=await import('@x402/svm/exact/server');const {ExactAvmScheme}=await import('@x402/avm/exact/server');
 const f:any={getSupported:async()=>({kinds:RAILS.map(rail=>({x402Version:2,scheme:'exact',network:railInfo(rail,'mainnet').network,extra:rail==='base'?{}:{feePayer:fees[rail]}})),extensions:[],signers:{}}),
  verify:async()=>{throw new Error('NO_VERIFY');},settle:async()=>{throw new Error('NO_SETTLE');}};
 const server=new x402ResourceServer(f);server.register(railInfo('base','mainnet').network,new ExactEvmScheme());server.register(railInfo('solana','mainnet').network,new ExactSvmScheme());server.register(railInfo('algorand','mainnet').network,new ExactAvmScheme());await server.initialize();
 for(const rail of RAILS){const requirements=await server.buildPaymentRequirements({scheme:'exact',network:railInfo(rail,'mainnet').network,payTo:sellers[rail],price:'$0.001',maxTimeoutSeconds:60});
  assert.equal(requirements.length,1);assert.equal(requirements[0]!.network,req(rail).network);assert.equal(requirements[0]!.amount,'1000');
  const {selectTerms}=await import('../src/buyer.js');selectTerms(config(),rail,{x402Version:2,resource:{url:'https://seller.example'},accepts:requirements},'seller');
 }
});

test('read-only mainnet preflight checks all token accounts and rejects missing opt-in or altered Solana ownership',async()=>{
 const {preflight}=await import('../src/preflight.js');const c=config();let corrupt='',calls=0;
 const ataOwners=new Map(await Promise.all([buyers.solana,sellers.solana].map(async owner=>[await tokenAccount(owner,req('solana').asset),owner] as const)));
 const send:Transport=async(url,method,body:any)=>{
  calls++;let result:any;
  if(method==='GET') {
   if(url.endsWith('/params')) return {status:200,headers:new Headers(),body:{'genesis-id':'mainnet-v1.0','genesis-hash':ALGO_GENESIS}};
   const owner=decodeURIComponent(url.split('/').at(-1)!);
   assert([buyers.algorand,sellers.algorand].includes(owner));
   return {status:200,headers:new Headers(),body:{address:owner,assets:corrupt==='optin'?[]:[{'asset-id':31566704,'is-frozen':false,amount:10000}]}};
  }
  if(body.method==='eth_chainId')result=corrupt==='chain'?'0x1':'0x2105';
  else if(body.method==='eth_call')result='0x'+(10000).toString(16).padStart(64,'0');
  else if(body.method==='getGenesisHash')result=SOL_GENESIS;
  else if(body.method==='getAccountInfo') {
   const owner=ataOwners.get(body.params[0]);assert(owner);const data=Buffer.alloc(165);
   Buffer.from(getAddressEncoder().encode(address(req('solana').asset))).copy(data,0);
   Buffer.from(getAddressEncoder().encode(address(owner))).copy(data,32);
   data.writeBigUInt64LE(10000n,64);data[108]=1;
   if(corrupt==='owner')data[32]=data[32]! ^ 1;
   if(corrupt==='delegate')data.writeUInt32LE(1,72);
   result={value:{owner:TOKEN,data:[data.toString('base64'),'base64']}};
  }else assert.fail('unexpected RPC method');
  return {status:200,headers:new Headers(),body:{jsonrpc:'2.0',id:1,result}};
 };
 const good=await preflight(c,send);assert(good.results.every(r=>r.accounts_ready));assert(calls>0);assert.equal(good.signs_or_sends_payments,false);
 for(const [problem,rail] of [['owner','solana'],['delegate','solana'],['optin','algorand'],['chain','base']]) {
  corrupt=problem!;const bad=await preflight(c,send);assert.equal(bad.results.find(r=>r.rail===rail)!.accounts_ready,false);
 }
});

test('a lost confirmation journal write freezes a submitted rail across restart',async()=>{
 const root=mkdtempSync(join(tmpdir(),'mainnet-late-disk-')),path=join(root,'ledger.sqlite');const c=config(),p=await payment('base'),f=await confirmedFixture('base');let posts=0;
 const send:Transport=async(u,_m,_b,h)=>{
  if(h?.['PAYMENT-SIGNATURE']){posts++;return {status:200,body:{result:utility('payload/sha256',example('payload/sha256'))},headers:new Headers({'PAYMENT-RESPONSE':encode64({success:true,network:req('base').network,transaction:f.id})})};}
  const body={x402Version:2,resource:{url:u},accepts:[req('base')]};return {status:402,body,headers:new Headers({'PAYMENT-REQUIRED':encode64(body)})};
 };
 let ledger=new Ledger(path);
 try{
  ledger.recordConfirmation=()=>{throw new Error('SENSITIVE_DISK_DETAIL');};
  const report=await new Buyer(c,ledger,async()=>p,send,async()=>({state:'confirmed'})).run('disk-after-post','base','payload/sha256',true);
  assert(report.error);assert.equal(posts,1);assert(!JSON.stringify(report).includes('SENSITIVE'));
  ledger.close();ledger=new Ledger(path);
  await assert.rejects(new Buyer(c,ledger,async()=>p,send,async()=>({state:'confirmed'})).run('new-id','base','payload/sha256',true),/unresolved/);
  assert.equal(posts,1);assert.equal(ledger.getIntent('disk-after-post')?.transaction,f.id);
 }finally{ledger.close();rmSync(root,{recursive:true});}
});
