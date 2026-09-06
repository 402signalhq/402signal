# x402 compatibility review — 2026-09-06

This review distinguishes protocol support, facilitator support and 402Signal
support. A provider announcement is not evidence that our configured facilitator
can verify or settle the same scheme on every network.

## Current primary-source findings

| Rail | Verified change | 402Signal consequence |
| --- | --- | --- |
| Base | CDP lists exact, upto and batch-settlement; its upto and batch implementations are EVM-only. | Keep fixed-price exact routing; retain variable offers distinctly and qualify the actual facilitator before any new payment model. |
| Solana | The September 3 announcement distinguishes upto for one metered call, batch-settlement for multiple deliveries, and MPP sessions with cumulative vouchers. | A spending ceiling is not a fixed price. MPP session is a separate protocol model, not an x402 exact alias. |
| Algorand | The canonical x402 exact specification uses ASA transfers and supports an optional fee-payer atomic group. | Preserve current exact AVM validation, network/genesis identity and buyer/fee-payer constraints. Do not infer channel support from another rail. |

Sources:
- [CDP payment schemes](https://docs.cdp.coinbase.com/sdks/cdp-sdks-v2/typescript/x402/type-aliases/CdpPaymentScheme)
- [Solana payment channels announcement, September 3, 2026](https://solana.com/news/payment-channels-1-million-payments-per-second)
- [Solana Foundation implementation](https://github.com/solana-foundation/payment-channels)
- [Canonical Algorand exact specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_algo.md)

The Solana publication's throughput benchmark describes its payment-channel
template. It is not measured 402Signal routing, seller probing, facilitator,
database, history, or PQ capacity.

## Scope of this compatibility patch

Discovery previously deduplicated offers by rail, asset, recipient and amount.
That could erase an exact or metered offer when both advertised the same amount.
It also collapsed different exact network IDs or other terms. Deduplication now
retains distinct JSON offers. Payment-option deduplication also retains different
recipients, facilitators, schemes and versions.

Display conversion no longer publishes a variable scheme's authorization amount
as a normalized fixed USD price. Upto amounts are labelled "Up to"; other
non-exact schemes report variable terms. They do not compare equal to fixed
prices, including through the atomic-amount fallback.

This does not authorize a tab, sign vouchers, spend a ceiling, charge a new fee,
or add a scheme to the payable allowlist. The current seller-selection and V4
binding contract still accept reviewed exact offers only. A mixed envelope can
retain its valid exact option; an envelope containing only variable schemes
remains unpayable through this release. Normal route misses remain free.

Missing-scheme legacy catalog display remains compatible. Catalog claims are
still separate from current observed payment authority; display data never
makes an offer payable.

## Requirements for a future metered or session guard

Before opening a buyer-owned tab, a reviewed guard needs to bind:

- The exact chain/network, token, seller recipient, facilitator and audited
  escrow/program/contract identity, including upgrade and delegation authority.
- Resource and permitted methods, service description, unit price and unit of
  measure, cumulative ceiling, expiry, inactivity close and refund/withdraw rules.
- Buyer wallet identity, channel identity, nonce/sequence and monotonically
  increasing cumulative spend; concurrent calls cannot allocate the same budget.
- The difference between a signed authorization, delivered usage, a settlement
  attempt and confirmed settlement. Unknown outcomes require reconciliation.
- Current seller checks, constraints, DNS/SSRF protection and evidence freshness.
  A valid initial quote must not grant unrestricted future access or spending.
- A new explicitly versioned binding/evidence contract for the new semantics.
  Never reinterpret an existing V4 exact receipt as approval of a running tab.

402Signal should verify the seller and terms before a buyer authorizes spending.
Buyer keys and funds remain with the buyer. The $0.003 success-only routing fee
remains separate from seller metering and facilitator COGS.

The existing replay ledger is not a channel balance ledger. Any future channel
state requires its own atomic sequence/budget contracts, durable unknown states,
restart and concurrent-voucher tests, expiration/refund reconciliation, and
independent security and functional review. PostgreSQL alone does not supply
those guarantees.

## Verification and rollout limits

The added contracts exercise mixed-offer ordering, non-exact fixed-price
suppression, recipient preservation, network/extension distinctions and variable
offer rejection across Base, Solana and Algorand. Existing exact selection,
success-only billing, V4/PQ, SDK and lab integration contracts remain required.

The checked-in lab seller already limits its top-level challenge to the V2
binding allowlist and Bazaar extension. Existing cross-component CI exercises
nine real synthetic seller challenges through Python routing/PQ and the Node
buyer guard. This does not establish what image the live lab seller runs:
fresh unpaid challenges must pass the same binding checks before any live test.

Merge and deployment require review of the exact final patch. PostgreSQL
activation, one-router verification, off-host recovery, provider durability,
budget evidence and bounded MainNet authorization remain separate release gates.
