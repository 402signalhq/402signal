# Base continuation merchant hook

`BaseBatchContinuationMerchant` is an opt-in lab hook for one reviewed Base USDC channel. It accepts 3–64 sequential vouchers at 1,000 atomic USDC per call on the existing GET `/base/batch/sha256` resource. It does not fund, claim, settle onchain, refund, schedule closure, or retry an uncertain operation. The existing version 1 two-voucher merchant is unchanged.

## Configuration and activation contract

The constructor takes `(pool, config, facilitator)`. Configuration has exactly these fields:

- `version: 2`, `campaignId` (8–60 letters, digits, underscores or hyphens), and the exact canonical HTTPS `url`.
- `createdAt` and `expiresAt`: safe integer milliseconds; positive duration no greater than 24 hours. This fixed deadline is immutable, including across restart. Expired campaigns permit retained recovery but no new voucher work.
- `perCallAtomic: "1000"` and integer `maxCalls` from 3 through 64. The maximum accepted cumulative voucher is `maxCalls * 1000`.
- `channelConfig`: the same pinned Base USDC owner EOA, receiver, receiver authorizer, token, salt and 900-second withdrawal delay as the reviewed channel contract.

Use a new reviewed campaign and channel salt. The module uses separate `merchant-v2-<campaignId>` stage and `merchant-v2:<campaignId>` channel-storage namespaces; it never reuses version 1 campaign records. Call `initialize()` with the existing restricted DML role. Schema migration is an explicit test/operator operation, `initialize({migrateSchema:true})`, not runtime authority.

The proposed loader flags are `LAB_BASE_BATCH_CONTINUATION=reviewed-owner-batch-continuation-v2` and `LAB_BASE_BATCH_CONTINUATION_CONFIG=<reviewed-config-path>`. This module does not edit or activate the shared configuration loader. Integration must reject simultaneous v1/v2 registration on the same path, bind the configured URL and receiver to the seller deployment, reuse the scoped read-only CDP provider and separate lab database, and remain disabled without explicit activation. No key collection or new provider credentials are introduced.

## SDK acknowledgement and recovery

The actual locked x402 SDK verifies the voucher and updates durable offchain accounting. The hook validates its acknowledgement: success, Base network, empty transaction, charged amount 1,000, matching channel and cumulative amount, and payer if supplied. It emits the SDK acknowledgement as `PAYMENT-RESPONSE`; it does not invent a successful acknowledgement or claim onchain settlement. The header string and canonical response body text are retained in the durable outcome and returned unchanged on recovery.

An immutable intent records the exact GET request digest and raw authorization-header digest before SDK work. Missing or uncertain outcomes remain fenced. A new signed sequential request may repair only a completed predecessor whose final progress transition was interrupted; it never repeats the predecessor's SDK accounting.

`readReceipt({recoveryOnly:true,channelId,sequence,requestDigest,authorizationDigest})` is an authority-free retained lookup. `requestDigest` is SHA256 of canonical JSON `{body:"",method:"GET",url}`. `authorizationDigest` is SHA256 of the complete raw PAYMENT-SIGNATURE base64 header string. Lookup needs no voucher, initialization, provider call, write or progress transition. Missing outcomes return `undefined`; mismatched scope is refused. Ordinary `request(url, header, true)` also performs no new SDK accounting, but requires the original voucher header.

Qualification uses the actual SDK with synthetic PostgreSQL channel snapshots and public synthetic signing keys. It covers 3/10/64 calls, exact HTTP acknowledgement replay, restart, expiry, order/concurrency, invalid acknowledgements and lost acknowledgements. It does not establish provider availability, live funding, long-duration service delivery or onchain completion.
