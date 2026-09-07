# Batch lab qualification

These opt-in fixtures qualify building blocks; they do not enable batch payments
on the public router or widen the existing MainNet buyer signer.

## Running in an isolated cloud environment

Use Node 24, the committed npm lock, and an empty synthetic PostgreSQL 15 database.
Set `LAB_BATCH_PG_DATABASE` to a name beginning `lab_batch_`, and optionally
`LAB_BATCH_PG_HOST`, `LAB_BATCH_PG_USER` and the standard PostgreSQL authentication
environment. Run `npm ci --ignore-scripts` and `npm test` in this directory.
Database tests skip without explicit opt-in; CI supplies its own disposable database.
Run the separately locked `solana-session-contracts` package for its SDK fixtures.
Public deterministic fixture keys are never suitable for funded wallets.

## Qualified boundaries

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
  sponsorship and buyer-authorized bounds. Live facilitator acceptance of the
  expanded group profile remains a separate qualification step.
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
