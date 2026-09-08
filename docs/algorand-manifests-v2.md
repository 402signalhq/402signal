# Algorand job manifests and payment counts

These opt-in HTTP profiles observe a merchant's explicit offer before a buyer signs. They do not settle customer funds, select a sponsor, verify fulfillment, or attest that a facilitator will accept the group. Existing two-item profiles remain unchanged.

| Profile                         | Jobs | USDC payments                 | Native sponsor transaction | Price meaning                                       |
| ------------------------------- | ---- | ----------------------------- | -------------------------- | --------------------------------------------------- |
| `algorand-atomic-multi-item-v1` | 2–15 | One per ordered job           | One                        | The merchant's equal per-job amount and exact total |
| `algorand-aggregate-invoice-v1` | 2–64 | One aggregate invoice payment | One                        | Exact invoice total; per-job allocation unknown     |

The invoice limit of 64 is an initial manifest/header/proof budget, not a chain limit. An atomic group can contain at most 16 transactions; the sponsored profile reserves one for the sponsor. Do not turn an existing one-payment offer into multiple transfers. A merchant must explicitly describe its invoice and ordered job hashes. An invoice buyer cannot supply `max_item_amount_atomic` unless a future profile defines verifiable allocation; this version rejects it.

## Economics and fees

402Signal's routing fee remains 0.003 USDC per fresh supported offer that qualifies for billing. It is not a per-job surcharge or an unlimited lifetime/API subscription. Reusing the retained attempt's completed response is recovery, not another purchase. A new observation is a new operation with its own explicit fee authorization.

Grouping does not eliminate the underlying chain transaction fees. With an independently checked 1000 microALGO minimum and no per-byte congestion charge,3 merchant payments plus a sponsor require 4000 microALGO total;15 plus a sponsor require 16000. An invoice's one payment plus sponsor requires 2000. These are example native transaction fees, not a facilitator's commercial price. Provider group policies and commercial charges remain independently negotiated/unverified.402Signal never automatically sponsors production customer payments with its own wallet.

## Version 2 manifest contract

Both profiles use the explicit `402signal-atomic-batch` extension with `version:2`, profile, exact resource/request hash, network/asset/recipient, ordered job hashes, independent job/payment counts, exact payment/total amounts, payment indexes, sponsor address and an immutable fee quote. Every transaction note commits the entire manifest and its index. The invoice's `perJobAmount` is null. Atomic `perJobAmount` is the exact equal payment amount.

The fee quote pins the Algorand mainnet genesis, transaction count, first/last valid rounds, minimum fee, per-byte fee, sponsor total, observation time and expiry. The initial profile accepts a 1000–5000 microALGO minimum and exactly zero per-byte fee; congestion or changed parameters is an explicit refusal. The buyer independently reads current suggested parameters before signing and again before sending. It does not blindly trust a seller's quote or automatically raise a fee. Sponsor total is exactly the quoted minimum times transaction count, within the buyer's separate cap.

The quote lasts at most 60 seconds and can shorten the existing routing observation expiry. GET URL bytes/order/encoding remain exact. No new POST or arbitrary body forwarding is introduced. Payment headers are capped at 16 KiB. The synthetic largest 15-payment credential was 13564 bytes; the 64-job invoice was 8800 bytes. The largest signed routing response was 47415 bytes within the 64 KiB client limit.

## Buyer and merchant integration

The public Algorand buyer package exports `./manifest` and `./manifest-store`; `examples/manifest.ts` composes the actual offline v5 guard, independently confirmed retained router payment, idempotent full-budget reservation and explicit signer. Authorization is checked again immediately before transport. Callbacks must not pay, retry or change offers. The application supplies a bounded redirect-free transport; no global fetch or wallet is installed.

`executeAlgorandManifest` persists attempt, sign permission, complete credential and send permission before its one ordinary merchant request. A lost wallet/provider/HTTP acknowledgment remains fenced after restart. `recoverAlgorandManifest` sends only non-executable request/group/authorization digests to an explicitly read-only lookup, validates the exact receipt accounting and never forwards a signed credential or resubmits an ordinary request. Recovery after quote expiry grants no new payment authority. `confirmAlgorandManifestOnce` independently checks every exact transaction and common confirmed round. Provider acknowledgment alone is not independent chain confirmation.

The lab exports `AlgorandManifestSeller` and `algorandManifestHttpHandler` as an operator-enabled integration hook; it is not enabled by default. A seller verifies every signed payment itself, even if its facilitator checks a single indexed requirement. It must use an independently chosen supported provider and provider-owned sponsor keys. The included receipt is a synthetic indexed job acknowledgment, not a production fulfillment service. The bounded SQLite store is an owner/lab reference journal, not the hosted route service's throughput design.

## Small live qualification plan (not executed)

Use new explicitly capped campaigns after separate operator/provider approval: first 3 equal 1000-atomic USDC payments, then one explicit 3000-atomic invoice for 3 jobs. Each campaign permits one 3000-atomic routing fee and one merchant submission. Thus the planned USDC cap is 6000 atomic per campaign,12000 combined; native sponsor examples are 4000+2000 microALGO if a fresh independent quote confirms 1000 minimum/zero per-byte fee. Provider commercial fees must be quoted separately before any purchase or sponsorship.

Confirm the actual provider supports each complete group and exact sponsor policy, verify current asset opt-ins/balances, pin source/challenge/request/ordered hashes/addresses/quote/budgets, then use buyer-owned signing. Drop one merchant response deliberately, recover only through the credential-free lookup and independently observe all group transactions in the same round. Never retry an ambiguous signed operation. A 15-payment live campaign is a separate optional qualification, not implied by the three-payment test. No new profile is live-qualified by these synthetic tests.

Sources: [Algorand atomic groups](https://dev.algorand.co/concepts/transactions/atomic-txn-groups/), [Algorand transaction fees](https://dev.algorand.co/concepts/transactions/fees/). The provider tests use the repository-pinned `@x402/avm`2.25.0 implementation and public synthetic keys only.

## Credential-free recovery

`recoverAlgorandManifest` passes only an explicit `recoveryOnly` request containing the exact URL, group ID, full prepared-scope digest and authorization digest. It never passes a signed payment, signer, or request body to a recovery callback. The callback must return `recoveryOnly:true`; an ordinary endpoint response is insufficient. The optional merchant implements a durable lookup using the same identifiers and no provider/RPC calls. Its HTTP recovery request uses `Replay-Only:1` plus `Manifest-Group-Id`, `Manifest-Request-Digest` and `Manifest-Authorization-Digest`; a `Payment-Signature` is rejected in recovery mode. An endpoint ignoring those hints receives no executable payment authority. Missing, mismatched or lost replies remain unknown and cannot authorize another ordinary submission. The original operation ID also binds the complete saved attempt scope, not merely the group total.
