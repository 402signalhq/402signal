# Proposal: an `offer-evidence` extension for x402

**Status: draft.** This is a proposed wire format, not an adopted x402 extension
or a claim of current client support. Current verifiers accept only their
documented extensions; this proposal does not expand that allowlist.

## Purpose

A buyer may retain a third-party record of the payment challenge it observed.
A common reference format could let that buyer, a seller and a facilitator
identify the same record when reviewing a purchase. The reference would remain
separate from the payment authorization and settlement result.

The proposed extension defines no new payment scheme and changes no settlement
semantics. Its presence alone grants no authority and authenticates no record.

## Payment payload

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

The buyer would include this reference only after verifying that the record's
`quote_sha256` matches the challenge being considered. The draft does not
require a seller or facilitator to verify or acknowledge the reference.

## Challenge declaration

The proposed discovery declaration identifies acceptable issuers:

```json
"extensions": {
  "offer-evidence": {
    "version": 1,
    "accepted_issuers": ["402signal.com/pq/log"]
  }
}
```

This declaration is untrusted seller metadata. It does not establish the
issuer's identity, the authenticity of a record, or the safety of a payment.

## Referenced record and assurance boundaries

The extension carries a reference, not the record. The
[Offer Evidence Record](../evidence-record.md) describes the recorded request,
observed offer, criteria, decision evidence, commitment and signed inclusion
receipt. Verification requires a deliberately trusted issuer key and the
private evidence needed to reconstruct the commitment. A later chain anchor
is separate evidence; pending anchoring is not confirmation.

A verified record establishes what the issuer recorded. It does not by itself
prove that a wallet paid those terms, that the buyer approved them, or that a
seller delivered useful output. Correlate it with separately retained payment,
policy and delivery records. A public leaf hash is not a backup of private
evidence or permission to retrieve it.

The draft provides no guarantee of seller identity, output quality, refunds or
payment reversibility. It does not replace wallet policy or transaction
validation, and it does not make an unsupported payment profile supported.

## Unresolved format questions

- Whether `receipt_ref` should be a leaf hash or an issuer-scoped URL.
- Whether a settlement response should echo the reference.
- Whether the extension needs an explicit canonicalization identifier for the
  challenge hash.
