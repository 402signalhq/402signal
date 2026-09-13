# Proposal: an `offer-evidence` extension for x402 (draft)

Status: draft for discussion, not submitted. Author: 402Signal. Intended venue: the x402 Foundation specifications repository, as an extension under `specs/extensions/`.

## Problem

An x402 buyer signs a payment authorization against a `PaymentRequired` challenge it received a moment earlier. Nothing in the protocol lets a third party later establish what that challenge said. When a seller changes its price or recipient between a buyer's plan and its payment, or when an agent's summary of a purchase disagrees with the bill, the only evidence is whatever the buyer's own runtime kept, which is the runtime whose behavior is in question.

Observed in September 2026 across catalog-listed sellers: prices that rose 67 percent overnight, prices that tripled, a price that doubled within four hours of the previous observation, and listings whose catalog price and recipient differed from the live challenge on a different network. None of those are protocol violations. All of them are the kind of change a buyer's controls should see, and a third party should be able to attest to.

## Proposal

An optional extension, `offer-evidence`, that lets a buyer attach to its payment payload a reference to a third-party record of the challenge it is paying against, and lets a seller or facilitator acknowledge it. It defines no new payment scheme, changes no settlement semantics and is ignorable by every party.

### In the payment payload

```json
"extensions": {
  "offer-evidence": {
    "version": 1,
    "issuer": "402signal.com/pq/log",
    "leaf_type": "402signal.route_decision.v4",
    "quote_sha256": "<hex of the challenge hash the record binds>",
    "observed_at": 1789305581,
    "receipt_ref": "<leaf hash>"
  }
}
```

The buyer includes it only when it holds a record whose `quote_sha256` matches the challenge it is about to pay. A facilitator or seller that does not recognise the extension ignores it, as the x402 extension rules already require.

### In the challenge

A seller may declare that it accepts or prefers evidence-carrying payments:

```json
"extensions": {
  "offer-evidence": {"version": 1, "accepted_issuers": ["402signal.com/pq/log"]}
}
```

This is discovery only. A seller that declares nothing still receives the payload extension and may ignore it.

### The record itself

The extension carries a reference, not the record. The referenced record format is the [Offer Evidence Record, version 1](../evidence-record.md): what was requested, what was offered (the whole challenge, hashed), the rules, the decision, the time, an Ed25519-signed log checkpoint with inclusion, and a later public-chain anchor. Any issuer that publishes a log key and a verifier can be an issuer; 402Signal is one.

## What it enables

- A buyer can prove, without its own runtime being trusted, that the challenge it paid against said a specific price and recipient at a specific second.
- A seller can point to the same record when a buyer disputes a charge that the seller's own terms justified.
- A facilitator can log the reference beside the settlement and hand a dispute a verifiable starting point instead of two conflicting summaries.
- Card-rail mandate systems (AP2, Visa Trusted Agent Protocol, Mastercard verifiable intent) can be referenced from the same record format, so an agent's authority and the offer it acted on sit together.

## Non-goals

No new scheme. No change to `exact`, `upto` or settlement. No requirement that any party verify the record. No claim about delivery, output quality or seller identity. The extension does not make a payment reversible.

## Test fixtures offered

402Signal maintains a recipient-change fixture and a price-change fixture (a seller that answers one challenge, then another with a different `payTo` or `amount`) and the conformance fixture its three verifiers agree on. Both would be contributed with the extension so implementers can test the "terms changed between observation and payment" path.

## Open questions for the working group

1. Should `receipt_ref` be a bare leaf hash or a URL with the issuer's log origin?
2. Should facilitators be encouraged to echo the reference in the settlement response so the reference travels with the settlement record?
3. Is a hash of the challenge the right binding, or should the extension carry a canonicalization identifier so different implementations hash the same bytes?
