# Native charge offer selection

The native Base and Algorand adapters can select a charge from a combined
WWW-Authenticate response. The buyer must name a supported native profile and
pin the realm, network, asset, recipient and price/fee limits. Exactly one offer
must satisfy those rules. Two qualifying offers are ambiguous even when their
prices match; the order of offers does not choose a winner.

The parser preserves quoted commas and escaped quotes, rejects duplicate
parameters and malformed offers, and accepts at most 16 Payment challenges.
Existing raw response bounds still apply: 16 KiB per channel and 24 KiB combined.
The original complete header, body and optional PAYMENT-REQUIRED header remain
in the signed observation. Alternative payment instructions are opaque data.
Only the selected original challenge is passed to the native SDK.

Verification independently rebuilds that selection. The Base wrapper also
compares the selected original segment with the SDK preparation; the Algorand
wrapper requires identical request, limits and terms. Signing failure never
falls back to another offer, network or protocol. Existing one-offer receipts
remain valid. Header formatting and unrelated offers do not create a new
economic authorization: Base retains its SDK nonce identity, and Algorand retains
its network, payer and lease identity.

This is a local pre-spend decision and explicit SDK handoff. It does not promise
merchant fulfillment, authorize automatic payments, or implement every MPP
method. The retained Agent402 response was checked offline at its observation
time; that check did not sign or submit a payment.
