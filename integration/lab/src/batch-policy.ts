// Pure lab policy checks. No signing, RPC, funding or payment submission.
import type { PaymentRequirements } from '@x402/core/types';
import { decodeTransaction, encodeTransactionRaw, groupTransactions, Transaction } from '@algorandfoundation/algokit-utils/transact';
import { ALGO_GENESIS, mainnetTerms } from './mainnet-policy.js';
import { assert, canonical, digest } from './json.js';

const atomic = (s: string) => {
  assert(typeof s === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(s), 'batch_invalid_atomic');
  return BigInt(s);
};
export interface ValidationScope {
  resource: string; requestHash: string; network: string; asset: string;
  payTo: string; merchantMaxAtomic: string; expiresAt: number;
}
export interface ValidationBatchQuote {
  version: 1; id: string; scopes: ReadonlyArray<Readonly<ValidationScope & {id: string}>>;
  unitPriceAtomic: string; maximumRouterAtomic: string; expiresAt: number;
}
export function quoteValidationBatch(scopes: ValidationScope[], unitPriceAtomic: string,
    maxRouterAtomic: string, now: number, maxItems = 64): ValidationBatchQuote {
  assert(Number.isSafeInteger(now) && now >= 0 && Number.isSafeInteger(maxItems) && maxItems > 0 && maxItems <= 1024, 'batch_invalid_bound');
  assert(Array.isArray(scopes) && scopes.length > 0 && scopes.length <= maxItems, 'batch_size_refused');
  assert(atomic(unitPriceAtomic) > 0n, 'batch_invalid_price');
  const unique = new Map<string, Readonly<ValidationScope & {id: string}>>();
  for (const s of scopes) {
    assert(s && Object.keys(s).sort().join(',') === 'asset,expiresAt,merchantMaxAtomic,network,payTo,requestHash,resource', 'batch_scope_shape');
    const url = new URL(s.resource);
    assert(url.protocol === 'https:' && !url.username && !url.password && !url.hash && s.resource.length <= 4096, 'batch_resource_refused');
    assert(/^[0-9a-f]{64}$/.test(s.requestHash) && typeof s.network === 'string' && s.network.length <= 128 &&
      typeof s.asset === 'string' && s.asset.length > 0 && s.asset.length <= 128 &&
      typeof s.payTo === 'string' && s.payTo.length > 0 && s.payTo.length <= 128, 'batch_scope_refused');
    assert(Number.isSafeInteger(s.expiresAt) && s.expiresAt > now, 'batch_quote_expired');
    atomic(s.merchantMaxAtomic);
    const id = digest(canonical(s));
    unique.set(id, Object.freeze({...s,id}));
  }
  const entries = [...unique.values()].sort((a,b) => a.id.localeCompare(b.id));
  const maximumRouterAtomic = (atomic(unitPriceAtomic) * BigInt(entries.length)).toString();
  assert(BigInt(maximumRouterAtomic) <= atomic(maxRouterAtomic), 'batch_spend_cap');
  const quote = {version:1 as const, scopes:Object.freeze(entries), unitPriceAtomic, maximumRouterAtomic,
    expiresAt: Math.min(...entries.map(s=>s.expiresAt))};
  return Object.freeze({...quote,id:digest(canonical(quote))});
}
export function earnedValidationFee(quote: ValidationBatchQuote, successfulScopeIds: string[], now: number): string {
  assert(Number.isSafeInteger(now) && now < quote.expiresAt, 'batch_quote_expired');
  const allowed = new Set(quote.scopes.map(s=>s.id));
  assert(successfulScopeIds.every(id=>allowed.has(id)) && new Set(successfulScopeIds).size === successfulScopeIds.length, 'batch_outcome_scope_refused');
  return (atomic(quote.unitPriceAtomic) * BigInt(successfulScopeIds.length)).toString();
}

// A deliberately narrow buyer-reviewed profile: one sponsor plus 1–15 USDC
// transfers. It does not claim that a facilitator accepts this profile, nor
// that all seller HTTP responses will succeed atomically with the transfers.
export function checkAlgorandBatchGroup(raw: Uint8Array[], signerIndexes: number[],
    requirements: PaymentRequirements[], buyer: string, maxSpendAtomic: string, maxSponsorFeeMicroAlgo: bigint) {
  assert(requirements.length >= 1 && requirements.length <= 15 && raw.length === requirements.length + 1, 'algorand_batch_size_refused');
  assert(canonical(signerIndexes) === canonical(requirements.map((_,i)=>i+1)), 'algorand_batch_signers_refused');
  const spend = requirements.reduce((sum,r)=>sum+atomic(r.amount),0n);
  assert(spend > 0n && spend <= atomic(maxSpendAtomic), 'algorand_batch_spend_cap');
  const sponsor = requirements[0]!.extra?.feePayer;
  assert(typeof sponsor === 'string' && sponsor !== buyer && maxSponsorFeeMicroAlgo > 0n, 'algorand_batch_sponsor_refused');
  for (const r of requirements) {
    mainnetTerms(r,'algorand');
    assert(atomic(r.amount)>0n && r.extra?.feePayer === sponsor && r.payTo !== buyer && r.payTo !== sponsor, 'algorand_batch_terms_refused');
  }
  const txs = raw.map(bytes=>{
    assert(bytes.length <= 4096, 'algorand_batch_encoding_refused');
    const t=decodeTransaction(bytes);
    assert(Buffer.from(encodeTransactionRaw(t)).equals(Buffer.from(bytes)), 'algorand_batch_encoding_refused');
    return t;
  });
  const f=txs[0]!;
  for (const t of txs) {
    assert(Buffer.from(t.genesisHash ?? []).toString('base64') === ALGO_GENESIS && (!t.genesisId || t.genesisId === 'mainnet-v1.0'), 'algorand_batch_network_refused');
    assert(!t.rekeyTo && !t.lease && (t.note?.length ?? 0)<=80 && t.group?.length===32, 'algorand_batch_side_effect_refused');
    assert(t.firstValid>0n && t.lastValid>=t.firstValid && t.lastValid-t.firstValid<=1000n &&
      t.firstValid===f.firstValid && t.lastValid===f.lastValid, 'algorand_batch_validity_refused');
  }
  assert(f.type==='pay' && f.sender.toString()===sponsor && f.payment?.receiver.toString()===sponsor &&
    f.payment.amount===0n && !f.payment.closeRemainderTo && (f.fee ?? 0n)>=BigInt(txs.length)*1000n &&
    (f.fee ?? 0n)<=maxSponsorFeeMicroAlgo, 'algorand_batch_fee_refused');
  requirements.forEach((r,i)=>{
    const t=txs[i+1]!;
    assert(t.type==='axfer' && t.sender.toString()===buyer && (t.fee ?? 0n)===0n &&
      t.assetTransfer?.receiver.toString()===r.payTo && t.assetTransfer.assetId===BigInt(r.asset) &&
      t.assetTransfer.amount===atomic(r.amount) && !t.assetTransfer.closeRemainderTo && !t.assetTransfer.assetSender,
      'algorand_batch_transfer_refused');
  });
  const expected = groupTransactions(txs.map(t=>new Transaction({...t,group:undefined})));
  txs.forEach((t,i)=>assert(Buffer.from(t.group!).equals(Buffer.from(expected[i]!.group!)), 'algorand_batch_group_id_refused'));
  return Object.freeze({groupId:Buffer.from(f.group!).toString('base64'),totalAtomic:spend.toString(),
    transfers:Object.freeze(requirements.map((r,i)=>Object.freeze({paymentIndex:i+1,transaction:txs[i+1]!.txId(),payTo:r.payTo,amountAtomic:r.amount})))});
}
