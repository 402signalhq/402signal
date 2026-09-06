import { assert } from './json.js';
import { RAILS } from './config.js';
import type { RunReport } from './buyer.js';
export function summarize(runs: RunReport[]) {
  assert(runs.length <= 10000, 'too_many_reports');
  const ids = new Set<string>();
  for (const r of runs) {
    assert(r.traffic_class === 'self_test' && r.organic_demand === false && RAILS.includes(r.rail) && !ids.has(r.run_id), 'mixed_or_duplicate_reports');
    ids.add(r.run_id);
  }
  const median = (a: number[]) => { a.sort((a, b) => a - b); const i = Math.floor(a.length / 2);
    return !a.length ? null : a.length % 2 ? a[i]! : (a[i - 1]! + a[i]!) / 2; };
  return { traffic_class: 'self_test', organic_demand: false, sample_size: runs.length,
    warning: 'Operator-controlled observations, not organic usage or a production benchmark. Chain evidence uses configured RPCs and the recorded confirmation level.',
    groups: ['offline', 'testnet', 'mainnet'].flatMap(mode => RAILS.map(rail => {
      const items = runs.filter(r => r.rail === rail && r.mode === mode);
      return { mode, rail, runs: items.length, validated_deliveries: items.filter(r => r.delivery === 'validated').length,
        seller_only_runs: items.filter(r => r.workflow === 'seller_only').length,
        seller_chain_confirmed: items.filter(r => r.chain_confirmation?.state === 'confirmed').length,
        seller_chain_unknown: items.filter(r => r.chain_confirmation?.state === 'unknown').length,
        free_misses: items.filter(r => r.routing === 'free_miss').length,
        unknown_payments: items.filter(r => r.routing === 'unknown' || r.seller_settlement === 'unknown').length,
        routing_median_ms: median(items.map(r => r.routing_ms).filter((n): n is number => typeof n === 'number' && Number.isFinite(n))),
        execution_median_ms: median(items.map(r => r.execution_ms).filter((n): n is number => typeof n === 'number' && Number.isFinite(n))) };
    })).filter(g => g.runs) };
}
