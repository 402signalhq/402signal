# Offer Evidence Record, version 1

A versioned, protocol-independent description of the evidence 402Signal issues for one checked offer: what was requested, what was offered, when, observed by whom, signed how and anchored where. The record is the product; the probe that produces it is an implementation detail. This page names the format so that a record outlives any one payment protocol, and it maps the fields to the receipts the service issues today.

Short name: `offer_evidence_record_v1`. Status: documents what is issued today (the v4 exact x402 binding and the v5 group-offer observation) and reserves fields for what is not yet issued (MPP bindings, agent mandates). It introduces no new wire format, key, signer or on-chain transaction.

## Why a record and not a score

A score is an opinion about an endpoint computed from public inputs. A record is a signed statement, made by a third party at a specific second, that a specific request received a specific offer, bound to the payment the buyer then made. Scores can be recomputed by anyone with a cron job; a record is only as good as its signature, its log and its anchor. Everything below exists to make the record verifiable by someone who does not trust 402Signal.

## The record

One record has seven parts. The first five are what an auditor asks about; the last two are how the answer is proven.

| Part | Content | Today's field |
| --- | --- | --- |
| Request | The exact seller request: complete HTTPS URL including the query, method, hash of the request body bytes. No redirects, no normalization. | `decision_binding.request.url`, `.method`, `.body_sha256` |
| Offer | The whole challenge the seller returned, hashed: every payment option in order with price, recipient, asset, network, timeout, facilitator and fee-payer data, and supported extensions; plus which option the check selected. | `decision_binding.quote_sha256`, `decision_binding.selected_index`; the observed challenge itself in the reveal |
| Rules | The buyer's rules as submitted: price ceiling, networks, latency bound, required inputs, objective. Evidence of what was asked, not of human approval. | `request_json` inside the reveal's evidence |
| Decision | The outcome: the winner, the compared candidates with exclusion reasons, the selected payment, the scoring model. | `routing_evidence_json` inside the reveal's evidence |
| Time | When the challenge was received and when the observation stops being usable for signing. Never extended by retries, replay or approval. | `decision_binding.observed_at`, `.expires_at` |
| Signature | A commitment to the private evidence in a public leaf; the leaf in an append-only Merkle log; a checkpoint of that log signed with Ed25519; an inclusion proof from the leaf to the checkpoint. | `pq_trust.transparency.receipt` (leaf hash, inclusion proof, checkpoint) |
| Anchor | Cumulative checkpoints written to Algorand MainNet in a transaction authorized with Falcon-1024, so a later rewrite of log history becomes detectable against the chain. | Public trust descriptor and `/transparency`; not part of the receipt |

### Commitment

The public leaf commits to the private evidence without revealing it:

```
leaf_commitment = SHA256("402signal.route_decision.v4" || 0x00 || canonical(evidence) || salt_32_bytes)
evidence = { evidence_version, binding, request_json, routing_evidence_json }
```

`canonical` is the RFC 8785 profile the verifiers implement: null, booleans, Unicode strings, arrays, objects and finite numbers within plus or minus 2^53 in the ES6 layout; non-finite numbers, duplicate keys, lone surrogates and unsafe integers are rejected. `request_json` and `routing_evidence_json` are JSON strings whose bytes must be preserved exactly. The public leaf carries only the leaf type, a minute-rounded timestamp, a nonce and the commitment. The reveal (evidence plus salt) stays with the buyer.

### What is private and what is public

Private, retained by the buyer: the request, the full response, the reveal, the observed challenge, the seller URL and body. Public, in the log: the commitment, the leaf type, the rounded time, the nonce, the checkpoints and the anchors. 402Signal never copies seller response bodies, payment headers, wallet keys, authorizations or signatures into the record. Bounded private response recovery exists for 120 seconds behind a client-held `Replay-Key`; it is not evidence storage.

## Protocol profiles

The record is protocol-independent; the offer part carries a profile that says how the challenge was parsed.

| Profile | Offer content | Status |
| --- | --- | --- |
| `x402-exact-v2` | An x402 v2 `PaymentRequired` envelope with `exact` scheme options on Base, Solana, Algorand or an observed EVM network. | Issued today as the v4 binding. |
| `x402-group-offer-v1` | One exact HTTPS GET API observed under buyer limits with a codec auto-detected from the live challenge (the v5 observation). | Issued today. |
| `mpp-charge-v1` | A `WWW-Authenticate: Payment` challenge classified as a charge, with the method, intent, amount, recipient and network. | Observed today and returned as terms; a signed binding for it is not yet issued. |
| `mpp-session-v1`, `mpp-subscription-v1` | Session and subscription terms: unit price, suggested deposit, period. | Observed today as terms, never as a fixed price; no binding. |
| `mandate-ref-v1` | Reserved. A reference to an agent mandate (AP2 cart or payment mandate, Visa Trusted Agent Protocol assertion, Mastercard verifiable intent): the mandate's identifier, its hash, the network that issued it. Lets one record carry both the offer and the authority the agent acted under. | Reserved; nothing is issued. |

Adding a profile changes the offer part only. The request, time, signature and anchor parts, the commitment scheme and the verifiers do not change.

## Verification

A verifier needs the retained record and an independently pinned log verification key. It never accepts a key that arrived in the same response.

1. Recompute the commitment from the reveal and compare it with the leaf.
2. Check the inclusion proof from the leaf to the checkpoint and the checkpoint's Ed25519 signature under the pinned key and the expected log origin.
3. Compare `decision_binding` in the response with the authenticated binding inside the evidence.
4. Compare `request_json` with the request the buyer actually made (JSON value semantics; 1 and 1.0 equal, booleans never coerce).
5. Before signing a payment: compare the seller's current challenge with the bound quote hash, and refuse when the terms differ or `expires_at` has passed.

Implementations: `verifyReceipt` and `withVerifiedRoute` in `@402signal/route-guard` (Node, zero dependencies), the `signal402` Python package's offline verifier, and the browser page at `/verify`. All three agree on the conformance fixture in CI.

## Versioning

`evidence_version` and the leaf type (`402signal.route_decision.v4`, `402signal.batch_observation.v5`) version the commitment. Historical leaves keep their original verification semantics forever; a verifier for v3 still verifies v3. New profiles and new reserved fields are additive. A change to the commitment scheme or the signature is a new leaf type and a new version of this document.

## Limits of the claim

The record proves that a specific request received a specific offer at a specific time and what the check decided. It does not prove delivery, output quality, seller identity or intent, legality, or that a human approved the submitted rules. It cannot recover a deleted private record and it cannot observe purchases that bypassed the check. The Falcon anchor protects the checkpoint history; it does not make the seller payment post-quantum secure.

Related: [proof-carrying route v1](proof-carrying-route-v1.md) (the v4 binding contract), [check group offer](batch-observation-v1.md) (v5), [route recovery](route-recovery.md), [investigating with retained evidence](customer/evidence.md), [the proposed x402 extension](proposals/offer-evidence-extension.md).
