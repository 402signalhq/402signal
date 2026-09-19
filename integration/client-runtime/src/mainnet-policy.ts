import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { address, getAddressEncoder, getProgramDerivedAddress, getCompiledTransactionMessageDecoder,
  getTransactionDecoder, getTransactionEncoder } from '@solana/kit';
import { decodeTransaction, encodeTransactionRaw, groupTransactions, Transaction } from '@algorandfoundation/algokit-utils/transact';
import { decodeSignedTransaction } from '@x402/avm';
import { type Rail, railInfo, safeUrl } from './config.js';
import { assert, canonical, decode64, digest } from './json.js';

export const ALGO_GENESIS = 'wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';
// RPC returns the full genesis hash; CAIP-2 uses only its first 32 characters.
export const SOL_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const COMPUTE = 'ComputeBudget111111111111111111111111111111';
export const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export interface MainnetPolicy {
  workflow: 'seller_only'; buyerAddresses: Record<Rail, string>; rpcUrls: Record<Rail, string>;
  buyerNativeFeeAtomic: '0'; // Sponsored payments only. Setup transactions are separate.
}
export function validateMainnetPolicy(p: MainnetPolicy | undefined) {
  assert(p && p.workflow === 'seller_only' && p.buyerNativeFeeAtomic === '0', 'mainnet_sponsored_seller_only_required');
  for (const rail of ['base', 'solana', 'algorand'] as const) {
    assert(typeof p.buyerAddresses?.[rail] === 'string', 'buyer_address_required');
    safeUrl(p.rpcUrls?.[rail]);
  }
  return p;
}
export function mainnetTerms(r: PaymentRequirements, rail: Rail) {
  const info = railInfo(rail, 'mainnet');
  assert(r.network === info.network && r.asset === info.asset && r.scheme === 'exact', 'mainnet_terms_mismatch');
  if (rail === 'base') assert(r.extra?.name === 'USD Coin' && r.extra?.version === '2', 'usdc_domain_required');
}
export function checkBaseTypedData(data: any, req: PaymentRequirements, buyer: string, now = Math.floor(Date.now()/1000)) {
  const fields = [ ['from','address'], ['to','address'], ['value','uint256'], ['validAfter','uint256'], ['validBefore','uint256'], ['nonce','bytes32'] ];
  assert(data.primaryType === 'TransferWithAuthorization' && canonical(data.types) === canonical({ TransferWithAuthorization: fields.map(([name,type])=>({name,type})) }), 'typed_data_type_refused');
  assert(data.domain?.chainId === 8453 && data.domain.name === 'USD Coin' && data.domain.version === '2' &&
    data.domain.verifyingContract?.toLowerCase() === req.asset.toLowerCase(), 'typed_data_domain_refused');
  const m = data.message;
  assert(m?.from?.toLowerCase() === buyer.toLowerCase() && m.to?.toLowerCase() === req.payTo.toLowerCase() &&
    BigInt(m.value) === BigInt(req.amount) && BigInt(m.validAfter) === 0n &&
    BigInt(m.validBefore) > BigInt(now) && BigInt(m.validBefore) <= BigInt(now + req.maxTimeoutSeconds) &&
    /^0x[0-9a-fA-F]{64}$/.test(m.nonce), 'typed_data_authorization_refused');
}
export async function tokenAccount(owner: string, mint: string): Promise<string> {
  const e = getAddressEncoder();
  return (await getProgramDerivedAddress({ programAddress: address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
    seeds: [e.encode(address(owner)), e.encode(address(TOKEN)), e.encode(address(mint))] }))[0];
}
// Inspect the exact compiled bytes the SDK asks the buyer to sign. No lookup
// tables, ATA creation, delegate, close, native transfers or token-2022 programs.
export async function checkSolanaMessage(bytes: Uint8Array, req: PaymentRequirements, buyer: string) {
  const m = getCompiledTransactionMessageDecoder().decode(bytes);
  assert(m.version === 0 && !m.addressTableLookups?.length, 'solana_message_profile_refused');
  const keys = m.staticAccounts.map(String), h = m.header;
  assert(h.numSignerAccounts === 2 && keys[0] === req.extra?.feePayer && keys[0] !== buyer && keys[1] === buyer,
    'solana_buyer_fee_or_signers_refused');
  const source = await tokenAccount(buyer, req.asset), dest = await tokenAccount(req.payTo, req.asset);
  const seen = new Set<string>();
  assert(m.instructions.length === 4, 'solana_instruction_count_refused');
  for (const ix of m.instructions) {
    const program = keys[ix.programAddressIndex], data = Buffer.from(ix.data ?? []);
    const accounts = (ix.accountIndices ?? []).map(i => keys[i]); let kind = '';
    if (program === COMPUTE && accounts.length === 0) {
      if (data.length === 5 && data[0] === 2 && data.readUInt32LE(1) === 20000) kind = 'limit';
      if (data.length === 9 && data[0] === 3 && data.readBigUInt64LE(1) <= 1n) kind = 'price';
    } else if (program === TOKEN) {
      assert(canonical(accounts) === canonical([source, req.asset, dest, buyer]) && data.length === 10 && data[0] === 12 &&
        data.readBigUInt64LE(1) === BigInt(req.amount) && data[9] === 6, 'solana_transfer_refused'); kind = 'transfer';
    } else if (program === MEMO && accounts.length === 0 && data.length === 32 && /^[0-9a-f]{32}$/.test(data.toString())) kind = 'memo';
    assert(kind && !seen.has(kind), 'solana_instruction_refused'); seen.add(kind);
  }
}
export function checkAlgorandGroup(raw: Uint8Array[], indexes: number[], req: PaymentRequirements, buyer: string) {
  assert(raw.length === 2 && canonical(indexes) === '[1]', 'algorand_group_profile_refused');
  const txs = raw.map(b => { const t = decodeTransaction(b); assert(Buffer.from(encodeTransactionRaw(t)).equals(Buffer.from(b)), 'noncanonical_transaction'); return t; });
  for (const t of txs) {
    assert(Buffer.from(t.genesisHash ?? []).toString('base64') === ALGO_GENESIS && (!t.genesisId || t.genesisId === 'mainnet-v1.0'), 'algorand_genesis_refused');
    assert(!t.rekeyTo && !t.lease, 'algorand_rekey_or_lease_refused');
    assert(t.group?.length === 32, 'algorand_missing_group');
    assert(t.firstValid > 0n && t.lastValid >= t.firstValid && t.lastValid - t.firstValid <= 1000n, 'algorand_validity_refused');
    assert((t.note?.length ?? 0) <= 80, 'algorand_note_refused');
  }
  const [f, p] = txs as [Transaction, Transaction];
  assert(f.type === 'pay' && f.sender.toString() === req.extra?.feePayer && f.sender.toString() !== buyer &&
    f.payment?.receiver.toString() === f.sender.toString() && f.payment.amount === 0n && !f.payment.closeRemainderTo &&
    (f.fee ?? 0n) >= 2000n && (f.fee ?? 0n) <= 10000n, 'algorand_fee_payer_refused');
  assert(p.type === 'axfer' && p.sender.toString() === buyer && (p.fee ?? 0n) === 0n &&
    p.assetTransfer?.receiver.toString() === req.payTo && p.assetTransfer.assetId === BigInt(req.asset) &&
    p.assetTransfer.amount === BigInt(req.amount) && !p.assetTransfer.closeRemainderTo && !p.assetTransfer.assetSender,
    'algorand_transfer_refused');
  assert(p.firstValid === f.firstValid && p.lastValid === f.lastValid, 'algorand_validity_refused');
  const grouped = groupTransactions(txs.map(t => new Transaction({...t, group: undefined})));
  txs.forEach((t,i) => assert(Buffer.from(t.group!).equals(Buffer.from(grouped[i]!.group!)), 'algorand_group_id_refused'));
}
export interface PaymentIntent {
  rail: Rail; network: string; asset: string; buyer: string; payTo: string; amount: string;
  nonce?: string; messageHash?: string; transaction?: string; feePayer?: string;
}
export function paymentIntent(rail: Rail, req: PaymentRequirements, p: PaymentPayload, buyer: string): PaymentIntent {
  const intent: PaymentIntent = {rail, network: req.network, asset: req.asset, buyer, payTo: req.payTo, amount: req.amount};
  if (rail === 'base') intent.nonce = String((p.payload as any).authorization.nonce);
  if (rail === 'solana') {
    const bytes = decode64((p.payload as any).transaction,1232), tx = getTransactionDecoder().decode(bytes);
    assert(Buffer.from(getTransactionEncoder().encode(tx)).equals(bytes), 'noncanonical_transaction');
    intent.messageHash = digest(new Uint8Array(tx.messageBytes)); intent.feePayer = String(req.extra?.feePayer);
  }
  if (rail === 'algorand') intent.transaction = decodeSignedTransaction((p.payload as any).paymentGroup[1]).txn.txId();
  return intent;
}
