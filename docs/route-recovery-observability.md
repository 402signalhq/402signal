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

A binding failure retains `binding_error: route_binding_unavailable` and adds an
allowlisted `binding_error_reason`, such as unsupported_challenge,
redirected_quote, quote_expired, unproven_observation or invalid_evidence. Unknown
exceptions become invalid_evidence. Inspect this reason before correcting the
seller challenge or request; do not relax verification to make a route succeed.

Non-challenge responses with billing add `route_outcome` version 1. Its code and next_action
separate free_miss, binding_failed, route_settled,
route_settled_receipt_unavailable, payment_rejected and settlement_unknown.
All outcomes explicitly set automatic_payment_retry to false. Contradictory
billing remains unknown. This advice is not independent chain confirmation.

`binding_remaining_seconds_at_issue` is an unsigned issuance-time snapshot,
never authority to extend the signed expiry. Replayed outcomes preserve their
original JSON, timings and snapshot exactly. Cached legacy outcomes are not
rewritten. Unpaid x402 challenge bodies and their encoded headers are unchanged.

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

The reference buyer in integration/lab stores its own phase timings and the
allowlisted router timings. Successful proof verification updates pq_evidence
and proof_status; merely receiving a checkpoint never means verified. A later
verification failure is reported as verification_failed. `recheck-route` uses
existing durable intents, performs chain reads and receipt verification, and can
save a private recheck report with `--report-dir`. It preserves all reservations.
`payments_reconciled` means no attempted payment remains unresolved;
`workflow_complete` additionally requires both payments and validated delivery.
Proof and anchor status remain separate. A reconciled router fee does not resume
seller execution or imply the purchase completed. The original stop reason stays
in the durable report as historical context.

## Reputation V2 traffic policy

Known operator test observations remain visible in history and operational
health, but are excluded from the scoring usage count, performance sample and
confidence sample. They cannot establish the history required for a stability
score. Existing operational identity/quote change penalties remain conservative.
Catalog tenure and distribution remain separate inputs.

Authority is the operator-configured LIVE402_LAB_ORIGINS set. Caller fields and
seller claims cannot choose a traffic class. New observations persist self_test
or unclassified through an additive SQLite column. Persisted self_test rows stay
excluded if configuration later removes the origin. Legacy observations for a
currently configured lab origin are excluded on read; old rows, receipts and
checkpoints are not rewritten. If history reading fails, configured lab origins
are still excluded from scoring the in-memory summary.

Unclassified observations remain eligible but are **not evidence of organic
demand or independent paying customers**. Older unclassified rows from an origin
no longer configured as a lab cannot be retroactively identified. Public raw
probe counts stay available, with an additional scoring count and exclusion count.
The model ID is reputation-v2 and its canonical methodology hash records this
policy. Legacy function name score_v1 remains for internal compatibility.

## Cross-component regression suite

CI builds the locked TypeScript buyer/seller with Node 24 and exercises actual
SDK-generated x402 challenges, Python router evidence/signing, JavaScript receipt
and quote validation, and real loopback seller HTTP utility delivery/replay.
The matrix covers three rails and three utilities. Expired bindings, explicit
false observations, free misses and changed/unsupported seller challenges must
not settle or invoke the buyer authorization callback as applicable.

Facilitator responses and payment signatures are synthetic; this suite does not
validate live-chain settlement or external provider availability. It has no wallet
keys, external payments or production storage. The lab source and its dependency
tree are excluded from the production router image.

## Rollout and rollback

Run Python, SDK, lab and cross-component tests, then build from the reviewed
commit. Preserve production configuration and volumes. Snapshot the volume and
verify the current cumulative PQ anchor/key pin before deployment. The history
migration only adds a column and default; previous router code ignores it on
rollback. Restore the previous image to roll back code; do not roll back live
payment or transparency databases. Reputation model records retain their hashes.
New response/report fields are additive. After deployment, verify health, unpaid
challenge compatibility and saved receipt recovery without authorizing a payment.
