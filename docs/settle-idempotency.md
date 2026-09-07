# Settle idempotency (SEC-ROUTER-001)

Process-local sqlite ledger for `/route` settle replay. Single-machine
until a shared ledger exists.

## What is stored

`UNIQUE` constraint on `SHA-256(fingerprint)`. Version 2 fingerprints bind
the rail-specific economic authorization: EIP-3009/Permit2 fields on Base,
the signed Solana message without mutable signatures, or Algorand unsigned
transaction IDs plus `paymentIndex`. Unsigned resource metadata, wrapper
extensions, and signature encoding do not create a fresh authorization.
Never the fingerprint, never `PAYMENT-SIGNATURE`, never raw payment material.
The uniqueness key is authorization-only. A separate keyed request digest binds
the endpoint, original request values and private client-generated `Replay-Key`.
A different endpoint, request or key cannot retrieve the response or create a
second economic action. See [private response recovery](replay-recovery.md).

## Outcome states

| State | Terminal? | Second settle? |
|---|---|---|
| `settlement_pending` | no | no |
| `unknown` | no | no |
| `settled` | yes | no |
| `not_settled` | yes | no |
| `rejected` | yes | no |

`begin()` reserves only bounded process memory. After successful facilitator
verification, `authorize()` durably reserves `settlement_pending` before probing
or settlement. `unknown` is a crash, `abandon`, lost/malformed settle response,
or unreadable outcome.
The public unknown result uses `settled:null`; it does not assert a failed
settlement. Non-terminal states fail closed: no cached success, no second
economic action and no reuse of that authorization.

`not_settled` is a verified authorization whose route workflow ended in a
free miss. Within the private recovery window it replays the original safe
response without a second verification, probe workflow, or settlement attempt.
The strict `success_only_v1` billing object distinguishes `settled` from
`not_settled`: HTTP 200 alone is not a settlement classification. Completed normal
misses use HTTP 200; operational failures retain HTTP 503.

## Version 1 ledger cutover

Legacy rows contain only irreversible hashes of the full client wrapper.
Their underlying authorizations and metadata variants cannot be reconstructed.
The privacy migration removes their response payloads, which lack private
retrieval credentials, while preserving identities and states. The ledger refuses
every new version 2 reservation while any legacy row exists unless the safe
cutover below has been acknowledged.

An operator may set `LIVE402_REPLAY_V2_CUTOVER_ACK` to the exact value
`payto-rotated-or-legacy-authorizations-expired` only after rotating every
advertised `payTo` or proving that every legacy authorization has expired.
The acknowledgement is persisted in ledger metadata. Without that explicit
safe cutover, deployment readiness stays false; deleting or rewriting legacy
history is not a migration strategy.

Response retrieval expires 120 seconds after the original request begins,
including durable response payloads. Admission and readiness maintenance prune
expired stored payloads. This is not immediate physical erasure from SQLite pages
or backups. Authorization uniqueness and pending/unknown states never expire.

## Scope

One process tree, one sqlite file. A second machine with its own file
is not covered until a shared ledger exists. This does not claim
facilitator exactly-once.

Production requires `/data/live402-replay.sqlite`; `/ready` is false when that
durable ledger is unavailable. Test support may use an isolated temp path.
The WAL uses `synchronous=FULL` so a successful reservation commit is not
silently lost on host power failure.
