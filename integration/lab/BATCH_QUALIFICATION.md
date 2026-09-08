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

The current buyer and lab voucher flows require the delivery observation to
remain within its original short validity window; long-running or high-count
sessions are not yet qualified.

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
  sponsorship and buyer-authorized bounds. Any profile beyond the supported
  two-item scope requires separate live qualification.
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
