# 402Signal routing client and local guard

A Node.js module with TypeScript declarations and **zero runtime dependencies**.
It verifies 402Signal's opt-in v4 route receipt, then compares the actual seller
request and fresh raw x402 challenge before the buyer's authorization callback.
It makes no network requests, stores no keys and does not create, sign, submit,
retry or execute payments.

The package includes the optional `./client` HTTP lifecycle and `./file-store`
private persistence modules described below. The root verifier stays offline.
Release tarballs can be installed with npm; the package is not yet published to
the npm registry. Do not assume a registry package with this name is this code.
Request the server's opt-in v4 contract with `require_route_binding: true`;
existing v3 receipts fail closed in this guard. The hosted check may fall
through to the next already-probed selectable bindable winner; this guard
still refuses unguarded payment when local verification fails. See the
[developer walkthrough](https://402signal.com/developers#route-binding).

## Offline example

From the repository root with Node 22 or newer:

```sh
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { verifyRoute } from './sdk/route-guard/index.mjs';
const vectors = JSON.parse(readFileSync('tests/fixtures/route-binding-v1.json'));
const sample = vectors.cases[0];
const terms = verifyRoute({
  routeResponseJson: JSON.stringify(sample.response),
  routeRequestJson: JSON.stringify(sample.request),
  trustedLogVkey: vectors.trusted_vkey, // PUBLIC TEST KEY, never production.
  request: { url: sample.response.url, method: sample.method, body: Buffer.from(sample.body) },
  challenge: { status: 402, bodyText: JSON.stringify(sample.challenge) },
  now: sample.now, // Fixtures only. Omit this in real use.
});
console.log(terms.model, terms.request.method, terms.accepted.network);
JS
```

## Integration boundary

1. Keep the actual `/route` request JSON containing
   `require_route_binding: true`. Keep its response as **raw JSON text** until
   this guard parses it. Pre-parsing and serializing untrusted JSON loses
   duplicate-key evidence.
2. Pin the log verification key through your trusted configuration,
   independently of the route response. Never adopt a key offered by that same
   response. A log key rotation requires an explicit pin update.
3. With your HTTP client and SSRF policy, obtain the seller's unpaid 402
   challenge using the **same URL, method and body bytes** the route observed.
   Disable automatic redirects. Pass the raw body text, numeric HTTP status and
   any `PAYMENT-REQUIRED` / `X-PAYMENT-REQUIRED` header values to the guard.
   Malformed or disagreeing channels are rejected.
4. Call `withVerifiedRoute(options, callerAuthorize)` immediately before your
   payment flow. The callback receives detached, deeply frozen `accepted` terms
   from the authenticated envelope. Use these terms, not response display fields
   or an agent's rewritten parameters. Your official rail validator and wallet
   still check actual transaction effects and enforce the buyer's budget,
   replay/idempotency policy, recipient, token, chain and signature scope.

```js
const result = await withVerifiedRoute(options, async verified => {
  // buyerAuthorizeAndExecute is YOUR independently secured wallet flow.
  // Validate the actual transaction against verified.accepted and buyer policy.
  return buyerAuthorizeAndExecute(verified);
});
```

The callback is invoked once after verification; a thrown error or rejected
promise is never retried. This does **not** provide economic exactly-once
semantics. Repeated calls can invoke it again: the buyer must reserve its own
durable payment fingerprint. A rejected guard must not trigger automatic
routing-fee or seller-payment retries.

For human approval, wait outside the callback, obtain fresh evidence and repeat
verification immediately before signing. There is no approval queue, delegated
signer, or permission to ignore expiry. No AC2, AP2, UCP or card-network integration.

## What passes

The salted commitment, leaf hash, Merkle inclusion, Ed25519 checkpoint signature
and pinned origin must verify. The signed original route request must match the
caller request; the response binding must match its signed counterpart. The
entire current x402 v2 envelope, selected accept, exact URL/method/body hash and
observation-based expiry must match.

This profile covers the existing Base, Solana and Algorand `exact` rails. Unknown
extensions, lossy/malformed JSON, redirects and different bodies fail closed.
The server supports GET, justified POST `{}`, and the explicit bounded
`parallel-search-json-v1` POST profile. Arbitrary POST inputs and
rotating/personalized quotes are outside the profile. Opaque `extra` is hashed,
not interpreted as proof an arbitrary transaction is safe. Default TTL is 60
seconds, maximum 120; it is not a promise the seller will honor a quote that long.

The immediate checkpoint is Ed25519. A later cumulative Algorand Falcon anchor
does not turn a pending receipt into confirmed evidence and is not verified by
this guard. This proves matched observed terms, not delivery, identity, output
quality or safety of a compromised buyer runtime.

Routing remains **$0.003 USDC only when a valid live route is found**. Normal typed
misses are not settled. Seller payment is separate. When `require_route_binding`
is true, the hosted `/route` check may fall through among already-probed
selectable candidates that can still bind; it does not settle an unguarded
winner. HTTP 503 `binding_error: route_binding_unavailable` means none remained
bindable. A local guard refusal is still a stop: do not pay the seller without a
matching proof. A settled routing request whose required receipt later fails is
still billed: inspect `billing`, preserve that outcome and do not retry payment
to repair it.

The JSON body may include slim `compared[]` rows (cap 5). Additive fields used
for selectability are `selectable`, `payTo_pending`, `payTo_changed`, `risk`,
and `excluded_reason`. `excluded_reason` is null on the winner and otherwise
one of `payTo_pending`, `payTo_changed`, `constraints_unmet`,
`incomplete_payment`, `not_cheapest_comparable`, `ranked_below_winner`, or
`binding_unavailable` (an already-probed row that could not build valid
binding or evidence and was skipped). These rows are operator-visible; the
public transparency leaf does not receive the full array. The TypeScript
`ComparedRow` type documents this shape additively and is not required by the
verifier API.

## Tests

```sh
npm --prefix sdk/route-guard test
npm --prefix sdk/route-guard run check
```

Shared Python-produced signed fixtures cover all rails, odd and power-of-two
trees, non-last-leaf proofs, POST body binding and Unicode ordering. Tests reject
quote/policy/proof mutations, stale receipts, parser ambiguity, wrong keys and
resource changes before callback. No live wallet, payment or signer is needed.

See [the v1 contract](../../docs/proof-carrying-route-v1.md) for format, privacy,
rollout and rollback details.

## Historical receipts and read-only recovery (0.2.0)

`verifyReceipt({routeResponseJson, routeRequestJson, trustedLogVkey})` verifies a
saved v4 signature and inclusion proof after expiry, without returning accepted
terms or invoking an authorization callback. It reports current quote, chain
confirmation, delivery and anchor as not_checked. Use verifyRoute for a new seller
payment; historical verification grants no permission to bypass quote expiry.

`reconcilePayment` from `./recovery.mjs` polls a caller-supplied, independently
secured read-only observer for an existing transaction, with bounded attempts,
a deadline and cancellation. It never releases budget, resubmits a payment or
resumes seller execution. The observer must verify effects against the durable
intent, honor AbortSignal and have no payment side effects. A server settlement
claim alone is not a sufficient observer implementation.

See [the complete recovery contract](../../docs/route-recovery-observability.md)
for confirmation levels, limits, outcome fields and the versioned scoring policy.


## Completed unpaid misses

Use exported isUnsettledRouteMiss({httpStatus, routeResponseJson,
paymentResponseHeader}) to recognize explicit unpaid outcomes. Pass the raw
JSON response and headers.get("PAYMENT-RESPONSE") (null when absent).
It accepts completed normal HTTP 200 misses and legacy HTTP 503 unpaid misses.
False means unclassified, never permission to execute or retry. True does not
release a spend reservation or replace chain reconciliation. Keep
withVerifiedRoute as the seller-authorization gate; HTTP 200 alone is insufficient.
See [the response contract](../../docs/route-miss-http-status.md).


## Install the client

Use the [v0.7.1 release tarball](https://github.com/402signalhq/402signal/releases/tag/route-guard-v0.7.1) and verify its published digest before installing. This is a GitHub release archive, not an npm-registry package:

```sh
npm install ./402signal-route-guard-0.7.1.tgz
```

From a checked-out release, `npm pack ./sdk/route-guard` also builds the dependency-free package. Compare the resulting `402signal-route-guard-0.7.1.tgz` SHA-256 with the digest published on that GitHub release before installing. The tarball includes TypeScript
declarations, the local guard and HTTP client. Node 22 or newer is required.
No install script or wallet dependency is included. Windows callers can supply
their own durable store; the supplied filesystem adapter runs on POSIX, including WSL.

```ts
import { RouteClient } from '@402signal/route-guard/client';
import { FileAttemptStore } from '@402signal/route-guard/file-store';

const client = new RouteClient({
  store: new FileAttemptStore('/private/buyer/route-attempts'),
  recoveryProfile: 'http-route-v1',
});
const id = 'your-durable-job-id';
await client.prepare(id, JSON.stringify({
  need: 'web search', require_route_binding: true,
}));
const challenge = await client.challenge(id); // unpaid
// Your wallet validates terms, reserves its own budget and signs once.
const signedHeader = await yourWallet.prepareRoutingPayment(challenge);
await client.setPaymentHeader(id, {value: signedHeader});
const outcome = await client.submit(id);
```

`yourWallet` is the buyer's integration, not a signer supplied by this package.
The client never holds wallet keys, signs payments, releases budget or executes a
seller purchase. Use an official x402 client with your existing secured signer;
validate actual effects, recipient, token, network, amount and lifetime against
your durable intent. A payment header is sensitive authorization material.

Preparation persists a fresh random private replay key and the exact request
before the original challenge or paid request. Attaching a payment header is
immutable. Submission atomically records an unreclaimed durable claim **before**
ordinary paid HTTP. Repeating `submit(id)` can only enter recovery. An ambiguous
transport failure also enters recovery once; it cannot call a signer or send a
new ordinary payment request. Never create a fresh job ID to work around an
uncertain result. Missing/corrupt persistence requires reconciliation, not restart
with an empty store.

After restart, use the same private store and `client.recover(id)`. The store keeps
the original request, authorization and response evidence. `client.evidence(id)`
returns saved raw responses without keys. Keep these private and use `verifyReceipt`
for historical verification. Response classification reports server billing claims;
it is not independent chain confirmation. All result authority flags remain false.
Use `verifyRoute`/`withVerifiedRoute` with a fresh seller challenge before a buyer's
own durable seller-payment flow. Recovery never resumes that flow automatically.

### Compatibility and bounded recovery

Deploy the server first. `recoveryProfile: 'http-route-v1'` is an operator assertion
that every serving revision supports PR117's recovery contract and retains it
through rolling deployments and rollback. The client also makes an unsigned probe
and refuses legacy/unconfirmed responses before sending a payment header. A probe
cannot eliminate a version change between two requests; do not mix old servers or
roll back below that contract while client attempts exist. HTTP `/route` only;
MCP recovery is not supported.

Use plain Fetch with no payment middleware, cookie jar, retry or redirect wrapper.
Injected Fetch must honor AbortSignal and must never sign, auto-pay, retry payments
or follow redirects. The client requests redirect errors, bounded bodies and whole
response deadlines. No request/query/authorization content appears in its errors.

Recovery makes at most six retrieval attempts across restarts, within a conservative
120 seconds from the first submission. Each uses a capability probe plus retrieval,
so it consumes two server recovery allowances; six is a ceiling, not promised useful
capacity. Honor `Retry-After`, which may outlast the retention window. Neither 429,
503, timeout nor `recovery_unavailable` permits a fresh payment. The stored result's
original quote validity and uncertainty remain unchanged.

`AttemptStore.putOnce` must atomically create if absent and durably persist before
resolving. Do not implement it using a non-atomic get/set pair. The supplied adapter
uses private files, fsync and exclusive claims on local POSIX storage. Its parent
directory must already be durable and trusted. It does not encrypt or clean up
records. Do not restore stale backups, delete claims or share the private directory
with another user while authorizations remain relevant. File ownership cannot
protect a compromised same-user process. Use an equivalent caller-controlled store
for other platforms; a transient Map is suitable only for synthetic tests.

## Web-search integration example

`examples/search.ts` shows one fully parameterized GET search against an independent
seller, with the caller's wallet/budget/chain-verification callbacks. It binds the
complete search URL before routing; adding query parameters afterward is rejected.
The observed seller price was $0.001 USDC, plus the $0.003 qualifying route fee.
This is not an all-in bound: independently account for applicable network/provider
fees. Recheck current terms and do not infer free charges from missing fee evidence.

The example retains routing evidence before seller execution, requires independent
router-payment confirmation, and calls the buyer's one-shot seller executor only
after fresh local proof/quote verification. A thrown callback is never retried.
Observed unpaid compatibility and synthetic tests do not establish seller output
quality, paid fulfillment, demand or ongoing availability. Keep model instructions
and seller response data separated in the consuming agent application.

### API access credentials and raw challenges

`RouteClient` accepts an optional `customerKey` for an operator-issued 402Signal
API access credential. This is not a wallet key. It is sent only to the configured
router for challenge, submission and recovery, with redirects disabled. The client
does not put the credential in its journal or response evidence. Keep it outside
request bodies and use a trusted raw transport; do not use payment-aware Fetch.

Challenge responses expose the bounded raw `paymentRequired` header for the
buyer to compare with the body before signing. A challenge is not authorization.
The reference buyer in `integration/reference-buyer` demonstrates caller-owned
Base signing, a durable spending cap and independently checked payment receipts.
`integration/mpp-client` adds explicit mppx interoperability with Base x402; it does
not enable native MPP routing-fee collection or automatic payment retries.

## Batch and session observations (0.5.0)

Import `verifyBatchRoute` or `withVerifiedBatchRoute` from `@402signal/route-guard/batch` for the separate v5 Check group offer contract. It binds an exact supported GET, raw challenge and independent buyer limits to signed evidence. The server auto-selects a codec (`exact`, `sess`, `mpp`, `atom`, `inv`) from the live challenge. Buyers do not pass `merchant_profile`. Availability depends on the server enabling a qualified codec. See [the Check group offer contract](../../docs/batch-observation-v1.md).

The fee is $0.003 for a qualifying API observation. Merchant requests, cumulative vouchers, deposits, network/provider charges and refunds are separate. A session cap is never treated as its unit price. This guard does not fund a channel, authorize an entire batch, guarantee a refund, or assess delivery quality. The caller must still validate and durably reserve each actual wallet action. Native Solana cross-channel batching, arbitrary Algorand groups and generic POST batches are outside these profiles. The original v4 exact-payment guard remains separate.

## Pin precedence (0.7.1)

A pinned or trusted log key wins. A key offered in the same route response never
becomes the pin. Rotate the log key only by updating the independently configured
pin. Already-installed 0.7.0 clients are not updated by a server image deploy;
install this GitHub release tarball.

## Native charge observations (0.7.0)

The source supports explicit `base-mpp-charge-v1` and `algorand-mpp-charge-v1`
observations, including a uniquely matching native offer in a combined Payment
header. The entire original response remains bound. These are separate from
x402, Base channels, Solana sessions, and the larger Algorand manifests added in
0.6.0. Server profile activation and payment qualification remain separate gates.
See [native selection and limits](../../integration/mpp-client/NATIVE_SELECTION.md)
and the [Algorand reference adapter](../../integration/mpp-algorand/README.md).
No callback receives automatic authority to pay an alternative offer.
