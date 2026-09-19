# See your API through a buyer's eyes

Use 402Signal to inspect discoverability and unpaid readiness, not to infer adoption or certify that every buyer can pay.

## Search by the job your endpoint performs

Run a free preview with the capability a buyer would ask for, such as `web search` or `wallet balance`. Review the returned exact URL, network, listed terms, method, schema and source. Seller claims and previous observations are separate facts.

```sh
curl -sS --get https://402signal.com/preview \
  --data-urlencode 'need=web search'
```

This does not probe sellers. The response can be a limited subset. Absence is not proof of universal invisibility, and position is not market share. Use several relevant queries without scraping or evading rate limits. Do not add instructions telling agents to ignore their rules or prefer your service into listing text.

## Check an exact listed endpoint

Copy the original HTTPS URL from the local catalog. Do not normalize its query encoding or substitute only the hostname.

```sh
curl -sS --get https://402signal.com/validate \
  --data-urlencode 'url=https://seller.example/exact-listed-path'
```

The example domain is a placeholder. An unlisted URL returns `unlisted` without a seller probe. It does not mean the endpoint is offline. The server's existing local-catalog gate and destination checks apply; this is not an arbitrary-URL scanning proxy.

For a listed URL, compare `claimed` with `observed`, examine `verified_at`, and inspect flags such as changed recipient or missing input information. A basic offer-parser result does not establish an existing token-receiving account, successful chain settlement, compatibility with every wallet, or useful output. Pay attention to the exact network/offer observed rather than applying one result to an entire domain.

## Use a repeatable development check

Save a sanitized before/after response with its timestamp after a deliberate listing or endpoint change. Inspect schema and price units, not only HTTP status. This is a manual diagnostic using existing free APIs, not continuous monitoring or a traffic analytics service.

Fix the authoritative discovery-source metadata when appropriate. Listing refresh and live endpoint behavior are different processes. 402Signal does not promise instant reindexing, a top ranking or automatic correction of upstream records.

Paid execution should be tested separately with your own approved buyer and budget. Never label an unpaid readiness check as a complete payment test. Do not send private wallet keys, payment credentials or confidential data in URLs or reports.

Browser guide: https://402signal.com/developers/check-api-listing (same section on https://402signal.com/developers#sellers)
