import {parseAbi,decodeFunctionData,decodeEventLog,encodeFunctionData,decodeFunctionResult,getAddress,keccak256,encodeAbiParameters,type Hex} from 'viem';
import {BATCH_SETTLEMENT_ADDRESS,ERC3009_DEPOSIT_COLLECTOR_ADDRESS} from '@x402/evm';
import {computeChannelId} from '@x402/evm/batch-settlement/client';
import {digest} from './base-batch-ledger.js';
export const BASE_BATCH=BATCH_SETTLEMENT_ADDRESS;
export const BASE_COLLECTOR=ERC3009_DEPOSIT_COLLECTOR_ADDRESS;
export const BASE_USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const BASE_BATCH_ABI=parseAbi([
 'struct ChannelConfig {address payer;address payerAuthorizer;address receiver;address receiverAuthorizer;address token;uint40 withdrawDelay;bytes32 salt;}',
 'struct Voucher {ChannelConfig channel;uint128 maxClaimableAmount;}',
 'struct VoucherClaim {Voucher voucher;bytes signature;uint128 totalClaimed;}',
 'function deposit(ChannelConfig config,uint128 amount,address collector,bytes collectorData)',
 'function claimWithSignature(VoucherClaim[] voucherClaims,bytes authorizerSignature)',
 'function settle(address receiver,address token)',
 'function refundWithSignature(ChannelConfig config,uint128 amount,uint256 nonce,bytes receiverAuthorizerSignature)',
 'function channels(bytes32 channelId) view returns(uint128 balance,uint128 totalClaimed)',
 'function receivers(address receiver,address token) view returns(uint128 totalClaimed,uint128 totalSettled)',
 'function pendingWithdrawals(bytes32 channelId) view returns(uint128 amount,uint40 initiatedAt)',
 'function refundNonce(bytes32 channelId) view returns(uint256 nonce)',
 'event Settled(address indexed receiver,address indexed token,address indexed sender,uint128 amount)',
]);
const TOKEN_ABI=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)','event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)']);
export type ReadRpc=(method:string,params:any[])=>Promise<any>;
export interface BatchConfig {payer:Hex;payerAuthorizer:Hex;receiver:Hex;receiverAuthorizer:Hex;token:Hex;withdrawDelay:number;salt:Hex}
export interface BatchEffect {kind:'deposit'|'claim'|'settle'|'refund';config:BatchConfig;amount:string;transactionHash:Hex;payload:any;baseline:{balance:string;claimed:string;receiverClaimed:string;receiverSettled:string;refundNonce:string};maxBuyerGasWei:string}
const eq=(a:unknown,b:unknown)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const must=(yes:unknown)=>{if(!yes)throw Error('unconfirmed effect');};
const hash=(s:any)=>typeof s==='string'&&/^0x[0-9a-fA-F]{64}$/.test(s);
export async function readBatchState(rpc:ReadRpc,config:BatchConfig,block:Hex){
 const id=computeChannelId(config,'eip155:8453');
 const read=async(functionName:any,args:any[])=>{const data=encodeFunctionData({abi:BASE_BATCH_ABI,functionName,args} as any);const raw=await rpc('eth_call',[{to:BASE_BATCH,data},block]);return decodeFunctionResult({abi:BASE_BATCH_ABI,functionName,data:raw} as any) as any;};
 const [channel,receiver,withdraw,nonce]=await Promise.all([read('channels',[id]),read('receivers',[config.receiver,config.token]),read('pendingWithdrawals',[id]),read('refundNonce',[id])]);
 return {balance:String(channel[0]),claimed:String(channel[1]),receiverClaimed:String(receiver[0]),receiverSettled:String(receiver[1]),withdrawAmount:String(withdraw[0]),withdrawAt:String(withdraw[1]),refundNonce:String(nonce)};
}
/** A trusted read-only RPC is required. Fail closed on provider lag, reorg,
 * concurrent unrelated receiver activity, multicalls or unfamiliar calldata.
 * Only canonical finalized block observations qualify; no writes are exposed.
 */
export async function observeBaseBatch(rpc:ReadRpc,e:BatchEffect):Promise<any>{
 try{
  must(hash(e.transactionHash)&&eq(e.config.token,BASE_USDC));
  must(await rpc('eth_chainId',[])==='0x2105');
  const [receipt,tx,finalized]=await Promise.all([rpc('eth_getTransactionReceipt',[e.transactionHash]),rpc('eth_getTransactionByHash',[e.transactionHash]),rpc('eth_getBlockByNumber',['finalized',false])]);
  must(receipt&&tx&&receipt.status==='0x1'&&hash(receipt.blockHash)&&eq(receipt.transactionHash,e.transactionHash)&&eq(tx.hash,e.transactionHash)&&eq(tx.blockHash,receipt.blockHash)&&tx.blockNumber===receipt.blockNumber&&eq(tx.to,BASE_BATCH)&&eq(receipt.to,BASE_BATCH));
  const height=BigInt(receipt.blockNumber);must(height>0n&&BigInt(finalized.number)>=height&&hash(finalized.hash));
  const block=await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);must(eq(block.hash,receipt.blockHash));
  must(BigInt(tx.value??'0x0')===0n&&eq(tx.from,receipt.from)&&height<=BigInt(Number.MAX_SAFE_INTEGER));
  if(eq(tx.from,e.config.payer))must(BigInt(receipt.gasUsed)*BigInt(receipt.effectiveGasPrice)<=BigInt(e.maxBuyerGasWei));
  const decoded=decodeFunctionData({abi:BASE_BATCH_ABI,data:tx.input}),args=decoded.args as any;
  const cfg=(c:any)=>computeChannelId(c,'eip155:8453')===computeChannelId(e.config,'eip155:8453');
  const n=BigInt(e.amount),p=e.payload;
  if(e.kind==='deposit')must(decoded.functionName==='deposit'&&cfg(args[0])&&args[1]===n&&eq(args[2],BASE_COLLECTOR));
  if(e.kind==='claim')must(decoded.functionName==='claimWithSignature'&&args[0].length===1&&cfg(args[0][0].voucher.channel)&&args[0][0].totalClaimed===n&&args[0][0].voucher.maxClaimableAmount===BigInt(p.claims[0].voucher.maxClaimableAmount)&&eq(args[0][0].signature,p.claims[0].signature));
  if(e.kind==='settle')must(decoded.functionName==='settle'&&eq(args[0],e.config.receiver)&&eq(args[1],e.config.token));
  if(e.kind==='refund')must(decoded.functionName==='refundWithSignature'&&cfg(args[0])&&args[1]===n&&args[2]===BigInt(e.baseline.refundNonce));
  must(n>0n&&n<2n**128n);
  const before=await readBatchState(rpc,e.config,('0x'+(height-1n).toString(16)) as Hex),after=await readBatchState(rpc,e.config,receipt.blockNumber);
  for(const key of ['balance','claimed','receiverClaimed','receiverSettled','refundNonce'] as const)must(before[key]===e.baseline[key]);
  must(before.withdrawAmount==='0'&&after.withdrawAmount==='0');
  const delta=(key:keyof typeof before)=>BigInt(after[key])-BigInt(before[key]);
  must(delta('balance')===(e.kind==='deposit'?n:e.kind==='refund'?-n:0n));
  must(delta('claimed')===(e.kind==='claim'?n-BigInt(before.claimed):0n));
  must(delta('receiverClaimed')===(e.kind==='claim'?n-BigInt(before.claimed):0n));
  must(delta('receiverSettled')===(e.kind==='settle'?n:0n));
  must(delta('refundNonce')===(e.kind==='refund'?1n:0n));
  const net=new Map<string,bigint>();let used=false,settled=false;
  must(Array.isArray(receipt.logs)&&receipt.logs.length<=128);
  for(const log of receipt.logs){
   if(eq(log.address,BASE_USDC)){
    try{const event=decodeEventLog({abi:TOKEN_ABI,data:log.data,topics:log.topics});const a=event.args as any;
     if(event.eventName==='Transfer'){const f=a.from.toLowerCase(),t=a.to.toLowerCase();net.set(f,(net.get(f)??0n)-a.value);net.set(t,(net.get(t)??0n)+a.value);}
     if(event.eventName==='AuthorizationUsed'&&e.kind==='deposit'){
      const auth=p.deposit.authorization.erc3009Authorization;const nonce=keccak256(encodeAbiParameters([{type:'bytes32'},{type:'uint256'}],[computeChannelId(e.config,'eip155:8453'),BigInt(auth.salt)]));
      if(eq(a.authorizer,e.config.payer)&&eq(a.nonce,nonce))used=true;
     }
    }catch{/* Other token events cannot substitute for required effects. */}
   }
   if(eq(log.address,BASE_BATCH)&&e.kind==='settle')try{const event=decodeEventLog({abi:BASE_BATCH_ABI,data:log.data,topics:log.topics});const a=event.args as any;if(event.eventName==='Settled'&&eq(a.receiver,e.config.receiver)&&eq(a.token,e.config.token)&&a.amount===n)settled=true;}catch{}
  }
  const value=(addr:string)=>net.get(addr.toLowerCase())??0n;
  must(value(e.config.payer)===(e.kind==='deposit'?-n:e.kind==='refund'?n:0n));
  must(value(e.config.receiver)===(e.kind==='settle'?n:0n));
  must(value(BASE_BATCH)===(e.kind==='deposit'?n:e.kind==='refund'||e.kind==='settle'?-n:0n));
  if(e.kind==='deposit')must(used);if(e.kind==='settle')must(settled);
  const canonicalBlock=await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);must(eq(canonicalBlock.hash,receipt.blockHash));
  return {state:'chain_confirmed',transactionHash:e.transactionHash,blockHash:receipt.blockHash,blockNumber:Number(height),after,evidenceDigest:digest({effect:e,receipt,tx,before,after})};
 }catch{return {state:'unknown',newPaymentAllowed:false};}
}
