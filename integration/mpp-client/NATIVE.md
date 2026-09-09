# Native MPP client

Inspect a supported Base USDC offer and verify its 402Signal observation before authorizing one payment. Your application retains its wallet, keys, durable budget and network transport.

The native Base adapter supports MPP `evm.charge` EIP-3009 authorizations on Base MainNet. The separate `base-x402` export preserves the existing x402 exact adapter. Neither export performs an automatic fetch, broadcasts a transaction, or retries a payment. Native MPP support here is distinct from Base batch channels and Solana sessions.

## Installable archive

The [v0.1.0 release](https://github.com/402signalhq/402signal/releases/tag/mpp-client-v0.1.0) includes the [archive](https://github.com/402signalhq/402signal/releases/download/mpp-client-v0.1.0/402signal-mpp-client-0.1.0.tgz) and its SHA-256 digest. Verify the digest before installation. No npm registry publication is implied. To build the archive from a reviewed checkout, run `node integration/mpp-client/build-package.mjs /path/to/new-package`, then run `npm pack` in that output directory. Install the resulting tarball in your application. The package records source-file hashes in `provenance.json`.

Import `prepareVerifiedNativeBaseMpp` from `@402signal/mpp-client/base`. Supply your retained route request/response and independently trusted log key as `routeEvidence`, the same exact GET request and current merchant challenge, and wallet policy containing network, USDC asset, recipient, payer and maximum atomic amount. Keep the original URL and raw response unchanged.

When a response contains several Payment offers, exactly one must match the pinned native profile, realm and limits. The full original response stays bound to the evidence; only the selected original challenge reaches the SDK. Ambiguity refuses, and signing failure never selects another offer.

Preparation verifies the evidence and current offer without signing. Call `prepared.createCredential({authorize})` only after your application has atomically claimed the returned authorization ID and reserved its budget in durable storage. The callback receives the exact inspection and returns a signing-only account. Record the signing intent before allowing the account to sign; persist the resulting credential before a single merchant submission. Do not let a restart create a second durable claim. A failed or uncertain signing/send attempt remains consumed until independent reconciliation proves its outcome. The adapter's in-memory one-shot guard supplements your durable application state; it cannot replace it.

The returned credential uses the seller's supported Authorization or Payment-Authorization header. Send it only to the exact approved request with redirects disabled. A transport acknowledgment is not independently confirmed settlement or proof of service quality. Native EVM settlement is performed by the merchant; the buyer adapter only produces the bounded authorization.

The hosted `base-mpp-charge-v1` observation accepts an exact HTTPS GET, Base USDC, a nonzero pinned recipient, an explicit MPP `realm` (which may differ from the hostname), and a canonical positive `max_call_amount_atomic` up to uint64. It costs the normal qualifying observation fee. Merchant fees remain separate. Runtime profile enablement and release qualification are required.

For a buyer-owned POST flow without hosted evidence, the lower-level `prepareNativeBaseMpp` requires the merchant challenge to contain the exact body digest. This does not expand the hosted routing POST profiles. Splits, Permit2, other chains/assets and alternate credential types are refused by this version.

Qualification covers the pinned mppx0.9.2/viem2.56.3 SDK, synthetic signed evidence, refusal cases and no-network signing. On September 8, 2026, a separate owner-operated test at `https://agent402.tools/api/uuid` received the resource response and independently confirmed finalized Base transactions for the 3000-atomic-USDC routing fee and 1000-atomic-USDC merchant charge. Buyer Base gas was zero. The buyer-owned operator used the unchanged public adapter with a bounded wait on the same offer before signing; no new offer or automatic payment retry was introduced. This is one external compatibility observation, not an output-quality assessment, commercial fee quote or universal merchant claim.

The durable authorization ID binds the network, token, payer and EIP-3009 nonce. Different presentation or changed terms for that same nonce retain the same claim. Store the full inspection separately; an uncertain claim remains fenced until explicit reconciliation.
