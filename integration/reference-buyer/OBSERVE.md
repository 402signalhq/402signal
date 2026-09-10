# One hosted observation, without a seller purchase

Use this example when a free fixture has passed and an operator wants to inspect one supported exact-GET endpoint. Use preview for catalog discovery and validate for free listed-endpoint readiness. This example never executes the seller request or creates an MPP seller credential. It does not demonstrate native MPP, sessions or manifests.

## Offline and plan

From a reviewed checkout, with Node 24 and private POSIX storage for the later paid path:

```sh
node integration/reference-buyer/observe.mjs offline
node integration/reference-buyer/observe.mjs plan integration/reference-buyer/observe-plan.example.json
node integration/buyer-checks/lifecycle.mjs routing
```

Offline reports five adapter and two historical checks. The synthetic plan reports maximum checking fee `0.003`, buyer network fee `0`, `sellerExecution: disabled`, zero network requests and `signerLoaded: false`. Its `purpose: synthetic-plan` prevents spending even if an acknowledgment is supplied. These commands also work from another directory when invoked with absolute paths. Plan reads the configured public verification-key file, never an account module or payment credential.

Obtaining code and installing dependencies are separate network operations. The guard's reviewed GitHub archive is `402signal-route-guard-0.7.2.tgz`. Verify the digest in `/capabilities.json` before installing. Its checksum file is named `SHA256SUMS`, not `SHA256SUMS.txt`. See `/capabilities.json` for exact download URLs. A GitHub archive is not an npm-registry release. This source example uses the checkout's guard through its existing locked local dependency:

```sh
cd integration/reference-buyer
npm ci --ignore-scripts
npm test
```

For the complete reference test suite, first install the separately locked `integration/mpp-client` dependencies with `npm ci --ignore-scripts`; some existing seller tests use that adapter. The observe path itself does not use it.

## Approve the public verification key independently

Review `docs/customer/approved-log-key.json` at a reviewed repository revision. The current record is `2026-09-09-1`, for origin `402signal.com/pq/log/mainnet-v1`. The expected SHA-256 of the trimmed UTF-8 vkey text is `cc99b21db1ce0bd3b8551bc7a76e83cbc4768290d39672a6bc1bfd772ed83970`.

The release owner compared this public key with the separately retained PR143 predeployment identity and the live public trust descriptor. Trust in the official reviewed repository is a bootstrap assumption; this does not audit the key's original generation ceremony. Do not obtain the only trusted pin from the response being verified. Copy the approved public `.txt` key into the buyer's protected configuration directory and record the fingerprint and provenance in operator-controlled configuration. A mismatch stops before the signer module is imported. A later rotation requires independently approving a successor record, retaining old keys with old evidence, and updating policy deliberately. If the operator cannot establish that trust, live onboarding remains blocked.

## Configure one authorized attempt

Copy the example to a private configuration file. Replace the synthetic buyer address with the existing wallet's public address, the router recipient with the independently reviewed Base recipient, and the RPC URL with the operator's existing approved read-only Base provider. Replace the endpoint and price bound in `routeRequestJson` while preserving exact URL/query bytes. Set absolute paths for `directory` and `trust.approvedKeyFile`; keep the approved fingerprint. Do not copy private keys into JSON. After reviewing the exact endpoint, key and costs, set `purpose` to `operator-approved-observation`.

Keep `routerUrl` exactly `https://402signal.com/route`, `campaignMaximumAtomic: "3000"`, `buyerNativeFeeAtomic: "0"`, and `sellers: []`. The guard accepts only the selected Base USDC EIP-3009 authorization with the expected recipient and exactly 3000 atomic USDC. A facilitator submits it; the buyer signs no native transaction. A different fee mechanism is refused. Provider request quotas or subscription costs are separate infrastructure, not native transaction fees.

The caller-owned account module exports `account` with the existing wallet's `address` and `signTypedData(data)` implementation. This is the same viem-compatible boundary as the reference buyer. Re-export an existing wallet adapter rather than generating a key for this tutorial. The module is trusted customer code, not sandboxed; keep it and its secret-store integration outside the repository. Optional `REFERENCE_BUYER_CUSTOMER_KEY` is a workload access credential, not a wallet private key.

Run plan again with the private configuration. Check `trustPinVerified`, `runtimeReady`, the exact endpoint and costs. A plan or payment challenge is not spending permission. Once the operator authorizes this single campaign:

```sh
REFERENCE_OBSERVE_ACK=one-check-0.003-no-seller \
REFERENCE_BUYER_ACCOUNT_MODULE=/private/existing-wallet-adapter.mjs \
node observe.mjs observe /private/observation.json original-attempt-1
```

Maximum 402Signal fee for this attempt: **$0.003 USDC**. Seller execution: **disabled**. Buyer native transaction fee cap: **0** under the supported sponsored authorization path.

The original attempt, fixed campaign budget and authorization are persisted before submission. A normal completed miss reports `not_attempted`; its conservative reservation is not automatically replenished. A qualifying result reports receipt integrity and chain confirmation separately. `signature_and_inclusion_verified` is historical receipt verification, not a fresh seller-payment authorization or Falcon-anchor check. Output quality and seller delivery are not assessed. Raw evidence and authorizations remain in the private stores.

## Lost response or restart

Use the original configuration, directory and ID. Recovery imports no signing account, never makes a seller request, and does not create a replacement authorization:

```sh
REFERENCE_OBSERVE_ACK=one-check-0.003-no-seller \
node observe.mjs recover /private/observation.json original-attempt-1
```

The existing HTTP recovery contract permits at most six recovery slots within two minutes of submission. A lost response, failed proof or expired recovery window can remain unresolved. Keep the journal and reservation, and investigate the original payment through independently approved read-only evidence. Re-running observe, choosing a new ID or restarting does not release the campaign budget. Replacing the store or using an unrelated wallet path is outside this client's protection. A later refusal does not reverse an already-settled checking fee.

## Separate lifecycle reports

```sh
node integration/buyer-checks/lifecycle.mjs routing
node integration/buyer-checks/lifecycle.mjs seller
node integration/buyer-checks/lifecycle.mjs mpp
node integration/buyer-checks/lifecycle.mjs all
```

Run these from the repository root after installing the corresponding locked reference-buyer and MPP-client dependencies. The launcher also works from another directory by absolute path. These are the repository's existing synthetic reference regressions, not tests of a customer's production adapter. Missing dependencies, skipped cases and timeouts do not receive a pass. Session continuation and live merchant qualification remain separate suites and evidence.
