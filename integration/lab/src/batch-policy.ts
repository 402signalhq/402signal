// Pure lab policy checks. No signing, RPC, funding or payment submission.
import type { PaymentRequirements } from '@x402/core/types';
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

export {checkAlgorandBatchGroup} from './algorand-batch-policy.js';
