# Organic operator metrics

Private operator rollup. Not a public scoreboard, not marketing, and never a
ranking input. No buyer wallets, payer addresses, authorizations, request
bodies, client IPs or observed payTo values are recorded or printed.

## Definitions

Organic means `traffic_class = organic`: hosted `/route` traffic labelled by
the writer, excluding sponsored trial credits, internal and lab self-tests.

| Metric | Definition | Source |
|---|---|---|
| North star: receipts issued | Settled qualifying checks (`route.qualified.organic`) in the window; each one returned a receipt to a buyer | `metric_counters` |
| North star: distinct payers | Distinct SHA-256 hashes of verified payers that settled an organic check in the window; the address itself is never stored | session DB `payer_days` |
| Session opens | Paid `session=open` windows created (`sku = session`) | session DB `windows` |
| Hops/open | Sum of `hop_count` over those windows divided by opens | session DB `windows` |
| Cache hit rate | `obs_cache.hit` / (`hit` + `miss`) on `/route` observation reuse | `metric_counters` |
| Qualify rate | settled qualifying routes / (qualified + completed normal misses) | `metric_counters` |
| 429 reason mix | 429 responses by coarse endpoint and reason | `metric_counters` |
| Top flip URLs | Seller URLs with the most payTo or price changes between consecutive organic observations | history DB `probes` |
| Discovery cache hit rate | shared upstream discovery reuse (operational, all traffic) | `metric_counters` |

Counters are process-local, flushed every 5 minutes by the writer into the
session database table `metric_counters(day, name, n)` and logged as one
`organic_metrics {...}` line. Rows older than 400 days are pruned.

The north star is one number pair, read weekly: signed receipts issued to
distinct non-lab payers. The writer logs it hourly as `north_star days=7
receipts_organic=… distinct_payers_organic=…` and the rollup prints it first.
It answers "are real buyers coming back for the record" without a scoreboard,
a wallet list or any public surface.

## Weekly rollup

On the writer:

```sh
PYTHONPATH=/app python3 /app/scripts/organic_rollup.py --days 7
```

Store the output in the private `402signal-internal` repository under
`metrics/weekly/`. Do not publish it.

## Session price rule

- If hops/open is at least 3 and cache hit rate is at least 50%: keep $0.005.
- If hops/open is below 3: keep $0.005. Consider a $0.003 open (same as the
  check) only if a named partner refuses $0.005. No third SKU.
- Do not implement $0.02 or tiers.

The rollup prints the decision the data supports. It never changes price.
