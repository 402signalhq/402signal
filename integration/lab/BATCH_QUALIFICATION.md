# Batch lab qualification

These opt-in fixtures qualify building blocks; they do not enable batch payments
on the public router or widen the existing MainNet buyer signer.

## Controlled MainNet tests

Owner-operated MainNet campaigns completed the supported Base batch, Solana MPP
push-session and Algorand two-item atomic-group paths. Base and Solana tests
covered two merchant calls, independent settlement checks and return of unused
capital. The Algorand test covered both indexed payments in one atomic group.
These are correctness tests of specific profiles and controlled endpoints;
they do not measure production throughput or certify other merchants.

Those earlier v1 voucher flows require a fresh delivery observation within its
original short validity window. The separate v2 continuation client authorizes
funding under the original observation, then bounds later calls by an immutable
buyer policy, current merchant challenge, remaining budget and deadline. It does
not renew the observation or charge a new routing fee per voucher.

On September 8, 2026, additional controlled MainNet campaigns completed:

- Solana v2 continuation: three accepted calls, 3000 atomic USDC paid to the
  merchant, 1000 refunded to the buyer, and all rent subsequently returned.
- Algorand manifests: three 1000-atomic-USDC payments plus one sponsor transaction,
  and a separate three-job invoice with one 3000-atomic payment plus a sponsor.
  Both resource receipts were accepted and every exact transaction was
  independently confirmed in the group's common round. Each campaign paid one
  separate 3000-atomic routing fee.
- Native Algorand MPP charge: one 1000-atomic-USDC payment to the controlled
  SHA-256 endpoint, an acknowledged response and independently confirmed full
  transaction effects. With `fee_payer:null`, the buyer paid 1000 microALGO in
  network fees. Its separate Base routing observation cost 3000 atomic USDC.

A separate native Base MPP charge test on September 8, 2026 received the UUID
response from `https://agent402.tools/api/uuid`. Both the 3000-atomic-USDC routing
payment and 1000-atomic-USDC merchant payment were independently confirmed at
finality, with zero buyer Base gas. The owner used a bounded same-offer wait; the
public adapter was unchanged. This is one external compatibility result, not an
output-quality assessment or commercial fee quote.

A separate Base v2 continuation campaign completed three accepted calls. Its
3000-atomic-USDC routing payment, 4000-atomic deposit, 3000-atomic claim and
settlement, and final 1000-atomic buyer refund were independently confirmed at
finality. No capital remained in the channel. This is a controlled three-call
result, not a high-count or long-duration qualification.
The 3/10/64-call, two-hour continuation tests are synthetic; none of these live
results establishes long-duration, high-count or production-throughput capacity.
Deposits and recoverable rent are capital, not fees; transfers between test
wallets are not evidence of business revenue. Facilitator commercial charges
are not inferred from transaction network fees.

The isolated tests below use synthetic provider responses and remain separate
from these live results.

## Running in an isolated cloud environment

Use Node 24 and the committed npm lock with an empty synthetic PostgreSQL database.
The isolated cloud qualification uses PostgreSQL 15; CI uses pinned PostgreSQL 16.15.
Set `LAB_BATCH_PG_DATABASE` to a name beginning `lab_batch_`, and optionally
`LAB_BATCH_PG_HOST`, `LAB_BATCH_PG_PORT`, `LAB_BATCH_PG_USER` and the standard
PostgreSQL authentication environment. Run from this directory:

```sh
npm ci --ignore-scripts
npm run build
node --test --test-concurrency=1 dist/test/*.test.js
```

Files share a synthetic database, so setup runs one file at a time. Deliberate
concurrent operations and competing processes within each test remain enabled.
Database tests skip without explicit opt-in; CI supplies its own disposable database.
Run the separately locked `solana-session-contracts` package for its SDK fixtures.
Public deterministic fixture keys are never suitable for funded wallets.

## Qualified synthetic boundaries

- Base uses the pinned x402 SDK's actual voucher verification, reservation,
  cancellation, cumulative accounting and claim/payout hooks. Provider responses
  are synthetic. Voucher acceptance, provider acknowledgement and independently
  observed chain settlement remain separate states.
- The PostgreSQL channel adapter serializes mutations across workers, including
  the first insert. It bounds record and list sizes and never retries a mutation
  callback after an uncertain database commit. All writers must use its lock
  protocol. The deployment namespace must bind chain, contract and recipient.
- The operation journal persists a unique send permit before a provider call.
  The runner binds a stable cycle, operation kind, scope and immutable payload
  digest. Restart does not reissue a permit. Failed or uncertain operations
  require explicit reconciliation; provider errors do not trigger fresh payments.
- Reconciliation records evidence supplied by a trusted observer; this journal
  does not validate chain receipts itself. A production controller must verify
  chain, contract, recipient, token, amount, transaction and finality, preserve
  stable cycle IDs and serialize overlapping payout cycles. Channel storage alone
  does not supply that controller or its durable payout schedule.
- Algorand fixtures validate complete atomic groups, indexed payment identities,
  sponsorship and buyer-authorized bounds. The dated three-payment group and
  three-job invoice tests above do not qualify every supported group size or
  invoice payload limit.
- Solana fixtures validate the separately pinned session SDK and distinguish
  accepted vouchers from settled funds. They do not open or fund channels.

## Before a live campaign

Use a new immutable campaign with explicit limits for fees, native gas/rent and
locked capital, supported provider/contract versions, owner-controlled wallets,
and reconciled final balances. Do not reuse completed campaign headroom. Exercise
failure and high-count scenarios synthetically first. No production credentials
or records belong in this development database.

The current router admission implementation is still process-local. This lab's
shared batch storage does not turn router quotas into distributed quotas, and
these correctness fixtures are not a production throughput benchmark.
