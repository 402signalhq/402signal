import { decodeEventLog, parseAbi } from 'viem';
import { getTransactionDecoder, getBase58Decoder, getCompiledTransactionMessageDecoder } from '@solana/kit';
import { transactionCodec } from '@algorandfoundation/algokit-utils/transact';
import type { Rail } from './config.js';
import { assert, digest, decode64 } from './json.js';
import { http, type Transport } from './transport.js';
import { ALGO_GENESIS, SOL_GENESIS, type MainnetPolicy, type PaymentIntent } from './mainnet-policy.js';

const READ_METHODS = new Set(['eth_chainId', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getBlockByNumber',
  'eth_blockNumber', 'eth_call', 'getGenesisHash', 'getTransaction', 'getAccountInfo', 'getBalance']);
export async function rpc(url: string, method: string, params: unknown[], send: Transport = http): Promise<any> {
  assert(READ_METHODS.has(method), 'rpc_write_method_refused');
  const r = await send(url, 'POST', {jsonrpc:'2.0', id:1, method, params});
  assert(r.status === 200 && r.body?.jsonrpc === '2.0' && r.body.id === 1 && !r.body.error && 'result' in r.body, 'rpc_read_unavailable');
  return r.body.result;
}
export async function checkNetwork(rail: Rail, policy: MainnetPolicy, send: Transport = http) {
  const url = policy.rpcUrls[rail];
  if (rail === 'base') assert(await rpc(url,'eth_chainId',[],send) === '0x2105', 'base_mainnet_required');
  if (rail === 'solana') assert(await rpc(url,'getGenesisHash',[],send) === SOL_GENESIS, 'solana_mainnet_required');
  if (rail === 'algorand') {
    const r = await send(url.replace(/\/$/,'')+'/v2/transactions/params','GET');
    assert(r.status === 200 && r.body?.['genesis-hash'] === ALGO_GENESIS && r.body['genesis-id'] === 'mainnet-v1.0', 'algorand_mainnet_required');
  }
}
export interface Confirmation { state: 'confirmed' | 'unknown'; transaction?: string; level?: string; buyer_native_fee_atomic?: '0'; }
export type Confirmer = (intent: PaymentIntent, transaction: string) => Promise<Confirmation>;
const abi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)']);
function hexInt(v: any) { assert(typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v), 'invalid_rpc_integer'); return BigInt(v); }
function natural(v: any) { assert(Number.isSafeInteger(v) && v >= 0, 'invalid_rpc_integer'); return v as number; }
// Single read-only observation. No polling loop, fresh authorization, signing,
// sendRawTransaction or reconstruction of a submitted action occurs here.
export async function confirmOnce(p: MainnetPolicy, i: PaymentIntent, id: string, send: Transport = http): Promise<Confirmation> {
  try {
    await checkNetwork(i.rail,p,send);
    const url = p.rpcUrls[i.rail]; let level: string;
    if (i.rail === 'base') {
      assert(/^0x[0-9a-fA-F]{64}$/.test(id), 'invalid_transaction_id');
      const r = await rpc(url,'eth_getTransactionReceipt',[id],send);
      assert(r?.transactionHash?.toLowerCase() === id.toLowerCase() && r.status === '0x1' && Array.isArray(r.logs), 'transaction_not_confirmed');
      const block = await rpc(url,'eth_getBlockByNumber',[r.blockNumber,false],send);
      assert(block?.hash === r.blockHash && hexInt(await rpc(url,'eth_blockNumber',[],send)) >= hexInt(r.blockNumber)+1n, 'insufficient_confirmations');
      const t = await rpc(url,'eth_getTransactionByHash',[id],send);
      assert(t?.hash?.toLowerCase() === id.toLowerCase() && typeof t.from === 'string' &&
        t.from.toLowerCase() !== i.buyer.toLowerCase(), 'buyer_native_fee_refused');
      let transfer = false, authorization = false;
      for (const log of r.logs) {
        if (log.address?.toLowerCase() !== i.asset.toLowerCase()) continue;
        try {
          const event = decodeEventLog({abi, data:log.data, topics:log.topics});
          if (event.eventName === 'Transfer') transfer ||= event.args.from.toLowerCase() === i.buyer.toLowerCase() &&
            event.args.to.toLowerCase() === i.payTo.toLowerCase() && event.args.value === BigInt(i.amount);
          if (event.eventName === 'AuthorizationUsed') authorization ||= event.args.authorizer.toLowerCase() === i.buyer.toLowerCase() &&
            event.args.nonce.toLowerCase() === i.nonce?.toLowerCase();
        } catch { /* unrelated event */ }
      }
      assert(transfer && authorization, 'authorization_receipt_mismatch'); level = 'base_two_blocks_not_finality';
    } else if (i.rail === 'solana') {
      assert(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(id), 'invalid_transaction_id');
      const r = await rpc(url,'getTransaction',[id,{encoding:'base64', commitment:'finalized',maxSupportedTransactionVersion:0}],send);
      assert(r?.meta?.err === null && Array.isArray(r.transaction) && r.transaction[1] === 'base64', 'transaction_not_finalized');
      const tx = getTransactionDecoder().decode(decode64(r.transaction[0],1232));
      assert(digest(new Uint8Array(tx.messageBytes)) === i.messageHash, 'signed_message_mismatch');
      const m = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
      const payer = String(m.staticAccounts[0]);
      assert(payer === i.feePayer && payer !== i.buyer && tx.signatures[payer as keyof typeof tx.signatures] &&
        getBase58Decoder().decode(tx.signatures[payer as keyof typeof tx.signatures]!) === id, 'receipt_signature_mismatch');
      const index = m.staticAccounts.map(String).indexOf(i.buyer); assert(index >= 0, 'buyer_missing');
      assert(natural(r.meta.postBalances?.[index]) >= natural(r.meta.preBalances?.[index]) && natural(r.meta.fee) <= 20000,
        'buyer_native_fee_refused'); level = 'solana_finalized';
    } else {
      assert(/^[A-Z2-7]{52}$/.test(id) && id === i.transaction, 'transaction_id_mismatch');
      const r = await send(url.replace(/\/$/,'')+'/v2/transactions/pending/'+id,'GET');
      assert(r.status === 200 && natural(r.body?.['confirmed-round']) > 0 && !r.body['pool-error'], 'transaction_not_confirmed');
      const t = transactionCodec.decode(r.body.txn?.txn,'json');
      assert(t.txId() === id && Buffer.from(t.genesisHash ?? []).toString('base64') === ALGO_GENESIS &&
        t.sender.toString() === i.buyer && t.assetTransfer?.receiver.toString() === i.payTo &&
        t.assetTransfer.assetId === BigInt(i.asset) && t.assetTransfer.amount === BigInt(i.amount) &&
        (t.fee ?? 0n) === 0n && !t.rekeyTo && !t.assetTransfer.closeRemainderTo && !t.assetTransfer.assetSender, 'confirmed_transfer_mismatch');
      level = 'algorand_confirmed_round';
    }
    return {state:'confirmed', transaction:id, level, buyer_native_fee_atomic:'0'};
  } catch { return {state:'unknown'}; }
}

// Allow finalization to catch up using reads of the same transaction only.
// This does not re-sign, resubmit, release a reservation, or resume an old run.
export async function confirmForRoute(rail: Rail, observe: () => Promise<Confirmation>,
  pause: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<Confirmation> {
  const attempts = rail === 'solana' ? 30 : 8;
  const delayMs = rail === 'solana' ? 2000 : 1000;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await observe();
    if (result.state === 'confirmed' || attempt === attempts - 1) return result;
    await pause(delayMs);
  }
  return {state: 'unknown'};
}
