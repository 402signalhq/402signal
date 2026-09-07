# Reference Base buyer

This optional buyer-side integration uses an existing caller-owned signing account. 402Signal receives an API payment authorization, never the wallet private key. It supports Base USDC exact authorizations, a durable private campaign budget, a saved authorization before transmission, and independent on-chain confirmation. It creates no wallet, custody account, approval transaction, escrow, bridge or refund.

Use Node 24 on a private POSIX filesystem. Run `npm ci --ignore-scripts` in this directory. This package is private application example code, not a hosted wallet service. Its `node:sqlite` journal is a local single-buyer operational store; production 402Signal storage is separate.

`BaseBuyer` takes a caller-owned viem-compatible account, a `BuyerJournal`, explicit policy and a plain non-payment-aware Fetch. Do not use global payment polyfills or retry middleware. Each campaign fixes buyer, router, seller recipients, accepted Base USDC, sponsored fees and total USDC cap. Never share a journal directory with the lab or production databases. Reservations survive process restarts and are not automatically credited back; an unresolved earlier job blocks a new one.

The examples search AgentsTools using an exact GET URL or Parallel using the opt-in `parallel-search-json-v1` POST profile with a bounded query and `mode: "one-shot"`. Choose `sellerId: "agentstools"` or `"parallel"` in the operator configuration. They preserve query encoding and exact POST body bytes and compares the full seller challenge with the signed route before seller signing. `runSearch` is for a new job only. A validated normal unpaid miss completes the job without returning its reserved budget. Failed confirmation or an ambiguous outcome stops with the reservation held. Do not rerun it with a new ID. Use the RouteClient's explicit recovery for the existing routing attempt; seller ambiguity can be reconciled only by observing the original authorization's chain effects. A matching payment receipt does not establish result quality.

## Operator entry point

The operator reads a private local JSON configuration containing `directory`, `trustedLogVkey`, and `policy`. Optional `sellerPaymentClient: "mppx"` uses the separately pinned MPP-client x402 adapter for the seller payment; the default is `"x402"`. Neither option enables native MPP settlement. Install dependencies in `../mpp-client` as well before testing or using that adapter. Policy fields are `buyerAddress`, `routerUrl`, `routerPayTo`, `rpcUrl`, `campaignMaximumAtomic`, `buyerNativeFeeAtomic: "0"`, and `sellers`. Each seller declares `id`, exact base `url`, `method`, `payTo`, `maximumAtomic` and `maxLifetimeSeconds`. Obtain the log verification key independently. Pin recipients from the actual inspected seller offers, not from a language model.

`node operator.mjs plan /private/config.json` lists maximum costs without loading a signer or sending requests. The `run /private/config.json JOB_ID QUERY` operation requires `REFERENCE_BUYER_ACK=base-exact-only-once` and `REFERENCE_BUYER_ACCOUNT_MODULE` pointing to your own module exporting `account`. A typical account module imports `privateKeyToAccount` from viem and reads your own protected secret store. Keep that module and secret outside the repository. `REFERENCE_BUYER_CUSTOMER_KEY` is an optional 402Signal API access key, unrelated to the wallet key.

Read-only follow-up commands are `recover-router /private/config.json JOB_ID` and `confirm-seller /private/config.json JOB_ID [EXISTING_TX_HASH]`. They never load the wallet module or sign, and never retry the seller call. Preserve the private journal and RouteClient attempt directory for review. Standard output reports status only; response contents, authorization, nonce and request data remain in the private journal.

## Limits

No automatic protocol fallback, new authorization after ambiguity, native gas payment, Permit2, token approval, custom headers, arbitrary seller origins or session top-up. Configuration and injected account/transport/factory are trusted operator code. The reference enforces exact transfer effects before delegating signing, but cannot make a malicious caller-supplied module safe. Read-only reconciliation makes at most six observations within 15 seconds and never resubmits. Base confirmation checks the intended USDC Transfer and AuthorizationUsed nonce, canonical receipt block and a second block, and rejects any additional USDC debit from this buyer; this is not a finality guarantee. Never describe a synthetic test or an unpaid 402 challenge as a completed external purchase.

## Verification

`npm test` uses ephemeral synthetic test accounts, mocked HTTP/RPC and a public synthetic route proof. It does not access existing wallets or send transactions.

The inspected September 7 seller offers were 0.001 USDC for AgentsTools and 0.01 USDC for Parallel, each with a 300-second authorization maximum. Adding the separate 0.003 router payment gives maximums of 0.004 and 0.013 USDC. These are observations, not permanent prices or claims of completed fulfillment. Reinspect each challenge and retain the configured cap; a price or recipient change requires a new reviewed campaign rather than silent policy expansion.

## Live compatibility observation

On September 7, 2026 the AgentsTools GET workflow completed independently confirmed routing and seller payments and returned a response. The Parallel gateway produced a different payment recipient on successive unsigned challenges; the current fixed-offer guard therefore refused seller signing. The Parallel example is a bounded protocol integration example, not a qualified live purchase path for rotating recipients. Do not replace a recipient pin or bypass a changed-offer refusal to make it pass. Check compatibility before committing a routing budget. These observations do not assess response quality or promise future availability.
