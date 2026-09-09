# Optional operator-owned batch HTTP profiles

These temporary, owner-reviewed qualification profiles default off. They reuse the existing lab HTTP process and admission limits. Enabling them does not create wallets, fund channels, register a catalog entry or start a settlement scheduler.

- Algorand: `LAB_ALGORAND_ATOMIC_BATCH=reviewed-two-item-profile-v1`. The existing mainnet exact seller and durable lab SQLite ledger back `/algorand/batch/sha256?left=alpha&right=beta`.
- Base: `LAB_BASE_BATCH=reviewed-two-voucher-profile-v1`. `LAB_BASE_BATCH_CONFIG` points to reviewed campaign JSON. `/base/batch/sha256` advertises SDK-generated batch terms and accepts two pinned-channel cumulative vouchers. Its `voucher_accepted` result is off-chain accounting; owner operations separately claim, pay out and refund unused capital.
- Native Solana: `LAB_SOLANA_PUSH_SESSION=reviewed-owner-open-push-v1`. `LAB_SOLANA_SESSION_CONFIG` points to reviewed campaign JSON. `/solana/session/sha256` returns an empty unsigned 402 body and a native `WWW-Authenticate` header. The owner cosigns and broadcasts open/close transactions locally. Cloud merchant code receives public policy and read-only RPC access.

## Prepare persistence and the image

Base and native Solana use a dedicated lab-only PostgreSQL instance, separate from the router's replay authority. Set `LAB_BATCH_DATABASE_URL` to its `lab_batch_*` database using a dedicated runtime login. This credential must have no access to the router's database and must never be an administrator or migration credential.

Create the fixed tables in an explicit operator migration session before activation. The runtime needs `CONNECT`, schema `USAGE`, and only these table privileges:

- `lab_base_batch_stages_v1`: `SELECT`, `INSERT`, `UPDATE`.
- `lab_batch_channels_v1`: `SELECT`, `INSERT`, `UPDATE`, `DELETE`.

Remove public database `CREATE`/`TEMP` and schema `CREATE` permissions as applicable; the runtime cannot own the database/tables or inherit broader roles. Startup uses SELECT-only schema and privilege checks and refuses missing, changed or overprivileged schemas. It does not run migrations. The explicit `initialize()` migration helpers are for separately authorized setup/tests; live merchant initialization uses `migrateSchema:false`. Qualify the runtime login's inability to access other databases independently.

Install the pinned lab dependencies, including `pg` and the separate `solana-session-contracts` package, in the image. Preserve the existing exact seller configuration and durable volume. Exact-only deployments do not connect to the optional batch database. These profiles reuse the HTTP service but still require the prepared database and its operating resources.

## Review campaign policy and provider credentials

Base JSON is `{version:1,campaignId,url,channelConfig,perCallAtomic:'1000',maxCalls:2,expiresAt}`. `expiresAt` is epoch milliseconds. The URL is the seller origin plus `/base/batch/sha256`; the receiver must be the configured owned Base seller. `channelConfig` pins payer/payer authorizer, receiver/receiver authorizer, Base USDC token, fresh salt and withdrawal delay 900. Startup requires actual CDP batch support and the matching receiver authorizer; an exact-only facilitator is insufficient.

Set `LAB_BASE_BATCH_CDP_TOKENS` to a dedicated private token file containing exactly `{version:1,campaignId,supportedJwt,verifyJwt}`. The campaign ID must match. The file must be a regular, single-link file owned by the runtime user, with no group/other permissions; symlinks are refused. Supply separate short-lived CDP JWTs scoped to `GET /platform/v2/x402/supported` and `POST /platform/v2/x402/verify`. Their accepted lifetime is at most 120 seconds, with more than five seconds remaining when used.

The cloud adapter reloads this file before every provider call. The owner must refresh it through the reviewed deployment process during the bounded campaign, preserving ownership and permissions. Missing, expired, malformed or incorrectly scoped credentials fail closed; there is no automatic renewal or permanent pasted bearer-token solution. API master keys and wallet keys stay outside the cloud merchant. The adapter permits support discovery and voucher verification only; its settlement method is disabled. Owner-side settlement uses the separate reviewed provider-authentication callback.

Native JSON is `{campaignId,url,policy,rpcUrl,perCallAtomic,maxCalls}`. Copy the complete reviewed owner-session policy, including payer, operator/recipient, program-data pins, deposit/session limits, salt, grace period and voucher expiry. The recipient must equal the owned Solana seller. RPC permits only the configured read-method list. The cloud merchant cannot sign, broadcast, close, top up or delegate.

## Activate and run the v1 qualification sequence

The sequence below describes the original v1 two-call examples. The separately gated [v2 continuation client](../session-client/README.md) retains the initial funding proof and applies a fixed local policy to later calls; it does not require a new paid observation per voucher.

Prepare source/configuration pins, journals, balances, fee quotes and credentials before enabling the relevant flags. Treat activation as a temporary campaign; keep configuration immutable once its ledger is bound. Do not probe the native session endpoint early: its first ordinary unpaid GET persists the campaign's challenge with a validity of at most 60 seconds. A later campaign expiry does not extend that challenge or a signed routing observation.

The owner CLI supports an explicitly budgeted Base finality sequence: obtain the first paid observation, deposit once, independently confirm finalized deposit, then explicitly request `route-after-deposit` before delivery. This second observation is separately paid and checked; it never extends the first proof or permits another deposit. Set `maxRouteObservations:2` for this workflow and reserve both routing fees. `recover-route-after-deposit` and `confirm-route-after-deposit` reconcile that same attempt. There is no automatic refresh or third observation. Both deliveries must satisfy the second proof's original expiry; unresolved or expired evidence stops spending.

For example, two Base observations cost at most 6000 atomic USDC, plus 4000 deposited capital: a 10000-atomic cap. Two merchant calls consume 1000 each; the unused 2000 is returned only after successful refund and independent confirmation. Native Solana's one-observation example reserves 3000 plus the 4000 deposit, with operator native fees/rent budgeted separately. Algorand's two-item example reserves 3000 for routing plus 2000 for the merchant group. A session cap is capital, not its per-call price. Quote applicable provider/network charges and native liquidity before funding; deposit, merchant revenue, fees and refunds are distinct accounting entries.

All paid merchant requests are GETs with no body. Base uses `Payment-Signature`; native uses `Authorization`. Duplicate, legacy, cross-protocol or ambiguous recovery headers are rejected before merchant execution. `Replay-Only: 1` reads an existing stage and cannot create payment work. Unknown outcomes require the saved credential and explicit read-only recovery/chain confirmation, never another signature or ordinary request. Preserve journals and recovery access until reconciliation; then disable campaign flags and retire temporary credentials.

The SHA256 endpoints are controlled self-tests, not organic demand or production-throughput evidence. Provider acknowledgement, voucher accounting, independent chain confirmation and returned output are separate evidence. Controlled MainNet campaigns completed these payment lifecycles; see the [tested scope](BATCH_QUALIFICATION.md).
