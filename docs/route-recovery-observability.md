# Route recovery and observability

The router, local route guard and reference buyer report separate facts: server
settlement, independently checked chain effects, signed receipt inclusion,
current seller terms, delivery, and later anchoring. One does not imply another.

## Safe diagnostics and timing

Non-challenge route responses add `timings_ms`. Named phases include verification,
routing_probe, discovery, hydration, candidate_probing, binding_validation,
settlement, history, pq_receipt and total when measured. Values are bounded
milliseconds; nested phases overlap and must not be summed as a total. These are
unsigned operational measurements, not proof of service. Response serialization
and client network time are outside server total. No secrets, payment signatures,
seller response text or arbitrary exception messages are included.

A terminal binding failure — no remaining already-probed selectable candidate
could bind — retains `binding_error: route_binding_unavailable` and adds an
allowlisted `binding_error_reason`, such as unsupported_challenge,
redirected_quote, quote_expired, unproven_observation or invalid_evidence.
Unknown exceptions become invalid_evidence. Earlier bindable-failed losers in
the same paid request appear in `compared[]` as
`excluded_reason: binding_unavailable`. `wrapExactAuthorize` reports the
terminal 503 as `state=binding_unavailable` with `keep_calling_route: true`.
Inspect this
reason before correcting the seller challenge or request; do not relax
verification to make a route succeed.

Non-challenge responses with billing add `route_outcome` version 1. Its code and next_action
separate free_miss, binding_failed, session_hop, route_settled,
route_settled_receipt_unavailable, payment_rejected and settlement_unknown.
A hosted hop that restored the bound winner with no new settle uses
`session_hop` and `next_action=none`. That is snapshot reuse, not a miss.
All outcomes explicitly set automatic_payment_retry to false. Contradictory
billing remains unknown. This advice is not independent chain confirmation.

`binding_remaining_seconds_at_issue` is an unsigned issuance-time snapshot,
never authority to extend the signed expiry. During the private recovery window,
eligible replay outcomes preserve their original JSON, timings and snapshot.
See [private response recovery](replay-recovery.md) for the 120-second lifetime.
Unpaid x402 challenge bodies and their encoded headers are unchanged.

## Read-only recovery

The route-guard source package exports `./recovery`. `reconcilePayment` accepts
an existing rail/transaction and a trusted, read-only `observe` callback. That
callback must independently validate recipient, asset, amount, payer, network,
transaction and native fee against the durable payment intent. The helper checks
transaction/confirmation-level/zero-buyer-fee consistency; it is not itself an
RPC verifier. It accepts no signer, releases no budget, and never invokes the
seller. Integrators must not supply callbacks with payment side effects.

Default polling is at most 30 observations, two seconds apart on Solana (finalized),
and eight observations one second apart on Base/Algorand, within 60 seconds.
Base uses the existing two-block confirmation policy, not consensus finality;
Algorand uses confirmed-round evidence. A caller may tighten bounds; maxima are
60 observations, 5-second intervals and 120 seconds. Aborting or exceeding the
deadline returns unknown. The observer receives AbortSignal and must stop further
reads when canceled; a JavaScript callback cannot be forcibly preempted. There is
no overlapping retry after a hung observation.

`verifyReceipt` authenticates a saved v4 salted commitment, inclusion proof,
Ed25519 checkpoint and exact original route request using the separately pinned
public key. It can verify historical receipts after quote expiry. It returns no
accepted terms or payment authority and does not check a current quote, chain
payment, delivery or Falcon anchor. `verifyRoute` remains required immediately
before seller authorization and retains all expiry and quote checks.
