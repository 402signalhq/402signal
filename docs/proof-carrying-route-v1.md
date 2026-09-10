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
marked binding-ineligible for this request and `pick_winner` runs again on the
remaining already-probed selectable set under the same objective and constraints.
The paid probe is not repeated and no second router fee is charged. There is no
fall-through to unguarded (non-binding) execution: every settled winner still
has to produce valid binding and evidence. Only when no remaining bindable
selectable candidate exists is the result a 503 with
`binding_error: route_binding_unavailable` and a durable free-miss replay result.
Failed binding losers in `compared[]` use `excluded_reason: binding_unavailable`
and `selectable: false`. Default `payTo_changed` / `payTo_pending` exclusion is
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
alias that equals `accepts`), are projected away before comparison. Unknown
top-level extras such as `inputSchema` remain and fail closed. Header and body
still have to agree on the extracted challenge. Accept fields and `resource.url`
are never rewritten to invent a match.

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
This tolerance is not a claim of strict x402 schema conformance; the protocol's
five-tag limit is narrower. Metadata grants no trust or payment authority. Other
resource fields remain limited to `url`, `description` and `mimeType`; unknown
extensions, floating-point challenge values and disagreeing extracted
header/body challenges remain unsupported. Deploy a compatible server and guard
together; older guards reject these newly accepted descriptions. There is no
receipt-format or payment-authority change.

The default freshness window is 60 seconds. `LIVE402_ROUTE_BINDING_TTL_S` accepts
integers 1..120; invalid settings fail closed for opted-in requests. Receipt
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
Optional binding availability is narrower than ordinary routing availability.

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

The outer commitment uses an RFC8785 subset: null, booleans, Unicode strings,
arrays, objects, and safe integers only. Reject floats, non-finite numbers,
duplicate keys, lone surrogates, unsafe integers, excessive size/depth, unknown
binding/evidence fields, and unsupported versions. Public leaves still contain
only `type`, minute-rounded `ts`, nonce and salted commitment. The producer does not copy seller response bodies or buyer payment headers,
keys, authorizations or wallet signatures into this new evidence. Retain the private receipt/reveal securely, outside public
logs. Private response recovery requires the original client-generated `Replay-Key`
and exact request values. Responses, including private reveals, expire 120 seconds
after the original request begins; admission and readiness maintenance remove
expired stored payloads. Permanent authorization identities do not expire. This
is not a promise of immediate physical erasure from SQLite pages or backups.
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

## Python verifier

For Node/TypeScript, see the [local route guard](../sdk/route-guard/README.md).
It uses the same signed fixtures and a caller-owned authorization callback, with
no runtime dependencies or network operations. The published [v0.7.1 release archive](https://github.com/402signalhq/402signal/releases/tag/route-guard-v0.7.1)
contains the current installable client and offline guard; verify its digest before installation. The intended chk_grp verifier is route-guard v0.7.2 and stays pending until that GitHub release exists.
Source is also available in this repository. This is not an npm registry
publication. See the
[developer walkthrough](https://402signal.com/developers#route-binding) for the
request and buyer-side integration sequence.

```python
from live402.route_binding import observed_challenge, verify_route

envelope = observed_challenge(seller_status, lower_case_headers, seller_body)
accepted = verify_route(
    route_response, actual_route_request, vkey=pinned_log_vkey,
    status=seller_status, envelope=envelope,
    url=actual_seller_url, method=actual_seller_method,
    body=actual_seller_request_bytes,
)
# Pass accepted to your existing payment validator/signer under your own policy.
```

Supply the actual response and exact request bytes from the buyer's HTTP client.
Do not follow a redirect or change the body after this check. The verifier itself
performs no network requests. A comparison-only `verify_challenge` helper is also
available; it does not authenticate a receipt and is not the public trust boundary.

## Limits of the claim

This proves that the current supplied challenge and request match terms that
402Signal recorded for a qualifying route. It does not guarantee delivery, output
quality, immutable future seller behavior, legality, identity, merchant intent,
or safety of every transaction an arbitrary wallet might construct. It cannot
force a compromised buyer runtime to use the guard. The caller still enforces
wallet policy, signature scope and economic replay protections. Recheck after a
human delay; an approval is never permission to ignore expiry or changed terms.

No AC2 connection, approval queue, signing service, key, infrastructure component,
or extra on-chain transaction is introduced. The existing batched anchor lifecycle
and limits remain in force. There are no additional server probes for binding.

## Validation and rollback

Run the existing complete fixture suite and `test_route_binding.py` separately.
`scripts/route_binding_vectors.py` reproduces all-rail signed conformance fixtures
using a public test key and a temporary log. Python and the client must agree on
them, including trees of different sizes. No live payment is needed.

Deploy only after review. Rollout is caller opt-in. To stop new v4 issuance,
clients can stop requesting the flag; retain v4 verification for already issued
receipts. Rolling back code does not undo a settlement and must not wipe or reset
replay, history, signer, or transparency state. Never silently turn a request for
guarded execution into an unguarded payment.
