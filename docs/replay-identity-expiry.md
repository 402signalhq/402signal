# Replay identity expiry (design)

Status: implemented and installed. `ops/replay-postgres-identity-expiry.sql` is
applied on the managed replay database. Base records the authorization's own
expiry; Solana and Algorand record a conservative upper bound counted from the
moment the facilitator verified the authorization (see rule 2).

## Problem

Every verified paid attempt admits a permanent economic identity. The managed
authority counts these against a lifetime `max_rows` (currently 10,000,000).
At 231 requests per second that ceiling is reached in about 12 hours, after
which paid admission stops. Retained identities exist only to stop a second
economic action for the same authorization. Once an authorization can no
longer settle on-chain, its identity no longer protects anything.

## When an identity may be dropped

All of these must hold:

1. The row is terminal: `settled`, `not_settled` or `rejected`. Never
   `settlement_pending` or `unknown`.
2. The row carries a known authorization expiry, recorded at reservation from
   verified payment fields:
   - Base EIP-3009: `validBefore`. Permit2: `deadline`.
   - Algorand: verification time plus 3600 s. A transaction is valid for at
     most 1000 rounds (about 47 minutes at 2.8 s per round), and the identity
     is admitted only after the facilitator verified it as currently valid.
   - Solana: verification time plus 300 s. A transaction is processable only
     while its recent blockhash is valid (about 60 to 90 seconds). The exact
     x402 scheme uses recent blockhashes; a durable-nonce transaction would
     not pass the facilitator's freshness checks in this profile.
3. `authorization_expires_at + 3600 s < now` by the database clock.

After expiry the chain itself refuses settlement (USDC `validBefore`, Algorand
`lastValid`), so dropping the identity cannot enable a second charge. A settled
authorization's on-chain nonce is already consumed.

## Database change (migration owner)

1. `ALTER TABLE signal_replay.entries ADD COLUMN authorization_expires_at
   DOUBLE PRECISION CHECK (authorization_expires_at IS NULL OR
   authorization_expires_at >= 0)`. Nullable and metadata-only; existing rows
   stay `NULL` and are never dropped.
2. `signal_replay.api_reserve_v2(authority, fingerprint, scope, expiry,
   authorization_expiry)`: same checks as `api_reserve`, also stores the
   authorization expiry.
3. `signal_replay.api_expire_identities(authority, batch)`: under
   `api_authority(authority, FALSE, TRUE)`, deletes at most `batch` rows that
   satisfy the rule above, subtracts them from `admitted` and their cached
   bytes from `outcome_bytes`, and returns the count.
4. Keep `api_reserve` for rollback. Keep every existing readiness guard.

## Router change

1. Compute the authorization expiry from the verified payload. Pass it to
   `api_reserve_v2` when that function exists (`to_regprocedure`), otherwise
   `api_reserve`.
2. Writer maintenance calls `api_expire_identities` in small batches, holding
   the writer lease, and logs `replay_expired count=...`.
3. `replay_capacity` logging already reports `rows_pct` for alerting.

## Rollout

1. Add CI coverage against real PostgreSQL 16 and 17: expired terminal rows
   are dropped; pending, unknown, `NULL` expiry and unexpired rows are kept;
   counters stay consistent; a dropped identity re-admitted after chain
   expiry cannot settle.
2. Migration owner applies the SQL. Readiness must stay green (no new
   triggers, grants or ownership changes on guarded tables).
3. Release the router. Confirm `replay_capacity admitted` falls for
   long-expired terminal rows and nothing else.

Rollback: release the previous router. The column and functions are inert
without it.
