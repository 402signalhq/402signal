# Algorand atomic batch reference buyer

An explicit two-item USDC batch adapter for a merchant implementing the
`402signal-atomic-batch` version 1 manifest. Ordinary single-payment x402 sellers
are incompatible with this contract. This reference has synthetic qualification;
check the release evidence for any separately completed live qualification.

The buyer owns its wallet, signing callback, durable ledger, campaign budget,
HTTP transport and independently pinned route-proof verifier. No wallet keys go
to 402Signal. This package does not open a wallet, contact a service or pay on import.

A manifest declares two 1,000-atomic-USDC merchant transfers (2,000 total), exact
GET request and job hashes, recipient, asset, sponsor and transaction indices.
The ordinary exact amount describes the nominated payment index. Always inspect
the batch manifest's total. A separately purchased 402Signal observation may cost
3,000 atomic USDC; it is not included in the merchant payment group.

Use `prepareAlgorandBatch` to validate the manifest and full group. Reserve the
full campaign amount and preserve the plan privately before `executeAlgorandBatch`.
Its mandatory `authorize` callback must authenticate the independent batch route
proof and enforce buyer pins, freshness and budget. Pass a durable atomic ledger,
a buyer-owned signer and a bounded no-redirect, no-retry HTTP send callback.
The ledger must preserve group claims across processes and restarts. An incomplete
or ambiguous group cannot acquire another signing/submission attempt.

`signAlgorandBatch` is a low-level signing primitive; it does not reserve spending
or verify a route proof. Applications should normally use `executeAlgorandBatch`.
Preserve returned payment material only in buyer-controlled private storage.

`confirmAlgorandBatchOnce` uses the supplied read-only transport to check the
network and every exact transaction in one confirmed round. Provider success
alone is not independent chain confirmation. Group settlement does not guarantee
HTTP delivery, output quality, refunds or simultaneous delivery of both results.

Build from the repository with `npm run build` in this directory, then `npm pack`.
Distribution is a release tarball unless a release explicitly says otherwise;
this source directory is not a claim of npm-registry publication.


## General two-item merchant profile

For a compatible outside merchant, explicitly select `algorand-atomic-two-item-v1`. This profile accepts an exact HTTPS GET URL and two equal USDC transfers to one pinned merchant. The item price comes from the reviewed quote; it is not fixed at the lab price. Set independent `buyerLimits` including `max_item_amount_atomic`, `max_total_amount_atomic`, `job_hashes` (two SHA256 commitments to the buyer's intended item descriptors), network, asset, recipient, fee payer and sponsor-fee ceiling. The merchant must implement the explicit `402signal-atomic-batch` manifest and indexed delivery contract. Ordinary exact-payment APIs are not automatically batch compatible.

Pass the verified observation's manifest and the original independent limits to `prepareAlgorandBatch({...input, profile:'algorand-atomic-two-item-v1', buyerLimits})`. Use `withVerifiedBatchRoute` from the separately installed route guard before the signing callback; check its request and challenge against the actual invocation. The adapter independently revalidates the generic manifest and keeps the profile/limits attached throughout signing, send and read-only recovery. It rejects an absent or changed item cap, total cap, job hash, recipient, sponsor or resource. Job hashes describe the intended items; they do not certify that work was delivered.

The existing `algorandBatchManifest` helper and campaign CLI describe the fixed-price SHA256 lab example only. They do not derive arbitrary merchant job semantics or select a customer's spending limits.

## Larger groups and explicit invoices

The optional `./manifest` and `./manifest-store` exports add two versioned profiles: 2–15 ordered equal-price USDC payments plus one sponsor, or a merchant-declared 2–64-job invoice paid in one transfer plus a sponsor. The original two-item API remains unchanged. The invoice limit is a payload budget, not a chain limit; unknown per-job allocation remains unknown.

See [the exact profiles and economics](../../../docs/algorand-manifests-v2.md) and [the buyer-owned guard example](examples/manifest.ts). Install the locally packed route-guard package alongside this package to compile the example. New profiles have synthetic SDK/HTTP/restart qualification; live provider campaigns remain separately gated.
