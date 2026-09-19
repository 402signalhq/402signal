# Proof-carrying routes v1

This opt-in addition binds a qualifying route to the request and payment terms
402Signal observed. The buyer can compare a fresh seller challenge with signed
evidence immediately before its own signing operation.

Send `require_route_binding: true` in the existing `/route` request. Existing
requests continue to receive v3 receipts. This flag also requires a signed
checkpoint receipt; it does not wait for an Algorand transaction.

The routing fee remains **$0.003 USDC only when a valid live route is found**.
Normal typed misses are not settled. Seller payment is separate. If the ranked
winner cannot build valid binding or evidence before settlement, that URL is
marked binding-ineligible for this request and selection runs again on the
remaining already-probed selectable set under the same objective and constraints.
The paid probe is not repeated and no second router fee is charged. There is no
fall-through to unguarded (non-binding) execution: every settled winner still
has to produce valid binding and evidence. Only when no remaining bindable
selectable candidate exists is the result a 503 with
`binding_error: route_binding_unavailable` and a durable free-miss replay result.
`wrapExactAuthorize` reports that as `state=binding_unavailable` with
`keep_calling_route: true`. Inspect the outcome and correct the request or
compatibility issue before another check; this flag does not authorize an
immediate retry or bypass of a local refusal. Failed binding losers in `compared[]` use
`excluded_reason: binding_unavailable` and `selectable: false`. Default `payTo_changed` / `payTo_pending` exclusion is
unchanged; `accept_payTo_change` remains the only opt-in.
If settlement succeeds and the required receipt subsequently fails, the result
is 503 with **billing.settled=true**. `unavailable` does not prove that no leaf
was appended; v4 never attempts a second append to repair a failed receipt.
Never retry payment to repair that outcome.

## Contract and scope

`decision_binding` has exactly these fields:

| Field | Meaning |
|---|---|
| `model` | `proof_carrying_route_v1` |
| `observed_at` | Unix seconds when the actual challenge was received |
| `expires_at` | Observation time plus the configured freshness window |
| `request.url` | Exact HTTPS URL, including query, without redirects |
| `request.method` | Actual GET or POST used by the probe |
| `request.body_sha256` | SHA-256 of the exact probe request body bytes |
| `quote_sha256` | SHA-256 of the entire strictly parsed x402 v2 envelope |
| `selected_index` | Unique selected option in that envelope's `accepts` array |

The full-envelope hash includes resource metadata, all accepts (in order),
facilitator/fee-payer data in `extra`, and supported extension data. Object key
order does not matter; strings and arrays are exact. No loose URL or address
normalization is performed. The profile supports current `exact` v2 options on
Base, Solana and Algorand; unknown top-level PaymentRequired fields and protocol
extensions other than `bazaar`, `builder-code` and `payment-identifier` fail
closed. Opaque `extra` data is bound without asserting its transaction
semantics. The existing official rail validator/wallet must still validate all
actual payment effects before signing.

Observation unwraps a seller HTTP wrapper only when the extracted PaymentRequired
object is unambiguous. Nested `payment_required` / `paymentRequired` / `x402`
bodies, plus known wrapper-only keys (`catalog`, and a `paymentRequirements`
alias that equals `accepts`), are projected away on every wire channel before
comparison. A top-level `inputSchema` object is hashed observational metadata,
not payment terms; it is not fetched or rewritten. Unknown top-level extras
remain and fail closed. Header and body still have to agree on the extracted
challenge. After a valid extraction, the probe stores that PaymentRequired
object so wrapper-only extras on the raw parseable envelope do not brick an
otherwise payable exact winner. Accept fields and `resource.url` are never
rewritten to invent a match.

For a queryful GET with an empty body, `resource.url` may describe the endpoint:
it must equal either the complete actual URL or its exact byte prefix before the
first `?`. Both URLs must satisfy the existing HTTPS restrictions. No host, path,
port, query, escaping or case normalization occurs. The signed `request.url`
always retains the **complete** actual URL, and the buyer must use that exact URL,
query order/encoding, method and body. Route the fully parameterized seller URL;
adding parameters after routing invalidates the proof. This endpoint-metadata
tolerance does not apply to POST or a GET body.

Resource `serviceName`, `tags` and `iconUrl` are accepted as bounded untrusted
observational metadata: a nonempty printable-ASCII name of at most 32 characters,
at most 16 nonempty printable-ASCII tags of at most 32 characters each, and an
optional HTTPS icon URL of at most 2048 characters that satisfies the same
host/userinfo/fragment restrictions as a resource URL. Every value and tag
position remains in the complete challenge hash. An accept may carry an
`outputSchema` object as hashed observational metadata; it is not payment terms.
The envelope may likewise carry a top-level `inputSchema` object.
This tolerance is not a claim of strict x402 schema conformance; the protocol's
five-tag limit is narrower. Metadata grants no trust or payment authority. Other
resource fields remain limited to `url`, `description` and `mimeType`; unknown
extensions and disagreeing extracted header/body challenges remain unsupported.
Decimal values in a challenge (a bazaar output example that quotes `67234.12`,
for instance) are accepted when finite and within plus or minus 2^53 and are
laid out per RFC 8785 (the ES6 number form, which `JSON.stringify` emits), so
Python and JavaScript hash the same bytes. Deploy a compatible server and guard
together; older guards reject these newly accepted descriptions (route-guard
0.7.3 and earlier refuse a challenge with decimal values as `invalid_json`,
fail closed; 0.7.6 accepts them). There is no receipt-format or
payment-authority change.

The default freshness window is 60 seconds, with a maximum of 120 seconds.
The signed expiry is authoritative. Receipt
issuance, HTTP retries, and replay never reset observation time. The x402
`maxTimeoutSeconds` field is an authorization timeout, not a quote expiry and is
not used to invent one. Expiry can occur while settling or waiting for approval;
an expired receipt is unusable, and the original billing result remains accurate.

Ordinary probes send GET without a body, or a justified POST with exactly `{}`.
The guard accepts only that same URL, method and body. It does not certify an
arbitrary input merely because a schema exists. Redirects, personalized/rotating
challenges, unsupported extensions or unresolved policy may be ineligible.
When `require_route_binding` is true, the router may fall through among
already-probed selectable winners that can still bind. It does not start a new
probe fan-out and does not settle an unguarded (non-binding) winner. HTTP 503
`route_binding_unavailable` is returned only when none remain bindable.
`wrapExactAuthorize` maps that 503 to `state=binding_unavailable` and leaves
`keep_calling_route` true. Optional binding availability is narrower than
ordinary routing availability.

### Reviewed search POST profile

`parallel-search-json-v1` is a separate, explicit exception for one reviewed
read-only search endpoint. The caller supplies the exact URL and raw JSON body;
there is no discovery fanout for that body and no general POST proxy.

```json
{
  "url": "https://parallelmpp.dev/api/search",
  "networks": ["base"],
  "max_price_usd": 0.01,
  "require_invocable": true,
  "require_route_binding": true,
  "probe_request": {
    "profile": "parallel-search-json-v1",
    "method": "POST",
    "body": "{\"query\":\"x402 payment protocol\",\"mode\":\"one-shot\"}"
  }
}
```

The URL must match exactly. The profile accepts only `query` (1..300 Unicode
characters) and `mode` exactly `one-shot`, encoded as a JSON object within 4096
UTF-8 bytes. Unknown fields, duplicate JSON keys, unsupported methods, malformed
bodies, another endpoint, or combining the profile with capability discovery
fail before payment verification or outbound probing. Arbitrary caller headers
are not accepted. The request uses the same public-address validation, pinned
DNS connection and bounded admission/probe budgets, with redirects disabled.

The actual method and exact supplied UTF-8 body bytes are retained for the v4
request hash. The buyer must reproduce those bytes; parsing and reserializing
the JSON can change whitespace or key order and invalidate the binding. The
original route request carries the search body in private evidence and bounded
private response recovery. Do not put that evidence in public logs. Raw search
bodies are not written to public log leaves or observation history. There is no
new payment authority, receipt version or seller-fulfillment guarantee.

Other nonempty POST bodies remain unsupported by this profile. Batch/session
observations use a [separate v5 contract](batch-observation-v1.md); a v4 exact
receipt does not authorize batch funding or session vouchers.

## Authentication and privacy

`402signal.route_decision.v4` uses evidence version 2:

```
SHA256("402signal.route_decision.v4\0" || canonical(evidence) || random_32_byte_salt)
```

`evidence` has exactly `evidence_version`, `binding`, `request_json`, and
`routing_evidence_json`. The latter two are JSON **strings**. Preserve their exact
bytes when verifying the outer commitment. This deliberately avoids changing the
historical v3 numeric serialization or requiring Python and JavaScript to
re-serialize legacy floating-point evidence identically. Decode the strings to
inspect the policy, winner, observation, selected payment, candidate digest and
scoring model. They are never executable instructions.

The outer commitment uses RFC 8785: null, booleans, Unicode strings, arrays,
objects, and finite numbers within plus or minus 2^53 in the ES6 layout (the
evidence itself carries only integers and strings). Reject non-finite numbers,
duplicate keys, lone surrogates, unsafe integers, excessive size/depth, unknown
binding/evidence fields, and unsupported versions. Public leaves still contain
only `type`, minute-rounded `ts`, nonce and salted commitment. The producer does not copy seller response bodies or buyer payment headers,
keys, authorizations or wallet signatures into this new evidence. Retain the private receipt/reveal securely, outside public
logs. Private response recovery requires the original client-generated `Replay-Key`
and exact request values. Responses, including private reveals, expire 120 seconds
after the original request begins; admission and readiness maintenance remove
expired stored payloads. Permanent authorization identities do not expire. This
is not a promise of immediate physical erasure from underlying storage or backups.
Keep your own receipt/reveal copy and follow [private recovery](replay-recovery.md).
Do not include credentials in routing prompts, policy, or resource URLs.

Before comparing the seller challenge, verify the reveal/commitment, public leaf
hash, Merkle inclusion, Ed25519 checkpoint signature, and expected log origin with
an **independently pinned log verification key**. A key from the same untrusted
response is not a trust anchor. The response's `decision_binding` must equal the
authenticated binding. Compare `request_json` with the actual route request the
buyer made, not a request supplied by an agent after the fact. Policy comparison
uses JSON value semantics: numeric 1 and 1.0 are equivalent, booleans are never
coerced into numbers. This does not re-serialize the signed commitment strings.

The immediate proof is the existing Ed25519 log checkpoint. A later cumulative
Algorand Falcon anchor is separate evidence; pending never means confirmed. The
guard does not claim the immediate receipt or Base/Solana payment is PQ-secure.
v1-v3 historical leaves and their original verification paths remain unchanged.

## Client verification

For Node/TypeScript, see the [local route guard](../sdk/route-guard/README.md).
It uses the same signed fixtures and a caller-owned authorization callback, with
no runtime dependencies or network operations. The current installable client and offline guard is
`@402signal/route-guard@0.7.7` on the npm registry (provenance attested) and the [v0.7.7 release archive](https://github.com/402signalhq/402signal/releases/tag/route-guard-v0.7.7);
verify the archive digest before installation, or run `node scripts/install_route_guard.mjs` from a reviewed checkout. v0.7.1 remains the historical verifier.
Source is also available in this repository. See the
[developer walkthrough](https://402signal.com/developers/route-binding) for the
request and buyer-side integration sequence.

Supply the actual response and exact request bytes from the buyer's HTTP client.
Do not follow a redirect or change the body after this check. The verifier itself
performs no network requests.

The [Python client](../sdk/python/README.md) exposes
`signal402.verify_route_receipt(response, trusted_log_vkey=...)` for historical
receipt verification. It does not compare the current seller challenge or
authorize a payment. Use the JavaScript guard for the live request/offer check.

## Recipient changes

Two outcomes matter to buyers:

- A candidate is excluded from selection (`compared[].excluded_reason`
  `payTo_pending`, `payTo_changed` true) when the live challenge's `payTo`
  differs from 402Signal's own previous trusted observation of that URL, even
  if the catalog listing has since been updated to the new wallet. A catalog
  claim never clears it; a second independent observation of the same
  destination does, and a request may opt in with `accept_payTo_change`.
- The guard's binding check fails closed on a recipient change, not only on
  a price change: `decision_binding.quote_sha256` is the RFC 8785 digest of
  the seller's whole raw 402 challenge, so a different `payTo` (like a
  different `amount`, `network` or `asset`) is a `quote_changed` refusal and
  the buyer's callback never runs.

Definitions used by every surface: *claimed* is the catalog listing at
`claimed.claimed_at`; *observed* is the live challenge at `verified_at`;
`payTo_changed` means the observed recipient differs from the catalog claim
or from the last trusted observed destination; `claimed_payTo_match` compares
the two sides directly (per rail).

## Limits of the claim

This proves that the current supplied challenge and request match terms that
402Signal recorded for a qualifying route. It does not guarantee delivery, output
quality, immutable future seller behavior, legality, identity, merchant intent,
or safety of every transaction an arbitrary wallet might construct. It cannot
force a compromised buyer runtime to use the guard. The caller still enforces
wallet policy, signature scope and economic replay protections. Recheck after a
human delay; an approval is never permission to ignore expiry or changed terms.

Binding does not require an additional buyer on-chain transaction. The existing
batched anchor lifecycle and limits remain in force. There are no additional
server probes for binding.

MPP offers seen on an ordinary check are observation only. The result carries
them as `mpp_offers` (and an MPP-only seller's charge as an `mpp-charge`
option), but this binding and the paid-route gate qualify x402 `exact` offers
only: an MPP-only winner is answered as an unbilled miss (`no_402_envelope`)
with the observed offers preserved, never as a signed receipt. Native
MPP charges bind through the Check group offer path and the native adapters.

## Compatibility

The guard's signed conformance fixtures use public test keys and require no live
payment. Run the [package tests](../sdk/route-guard/README.md) when changing a
verifier. Preserve verification of retained receipts when upgrading clients.
Never silently turn a request for guarded execution into an unguarded payment.
