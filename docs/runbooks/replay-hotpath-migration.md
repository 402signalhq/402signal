# Replay hot path: installing the sharded counters

`ops/replay-postgres-hotpath.sql` replaces the single `signal_replay.authority`
row lock in every paid admission with sixteen shard rows. The router needs no
new configuration: the same owner functions keep their names and signatures,
and the router's pooled, single-round-trip client works before and after the
migration. Read `docs/replay-throughput-benchmark.md` for the numbers and the
design.

## What changes in the database

- New table `signal_replay.authority_shard` (16 rows, keyed by the first hex
  byte of the fingerprint modulo 16) with its own `admitted`, `outcome_bytes`,
  `max_rows` and `max_bytes`. The shard quotas are the authority quotas split
  evenly, so the total can never exceed `max_rows` or the logical byte budget.
- `api_reserve`, `api_reserve_v2`, `api_finish`, `api_prune`,
  `api_expire_identities` and `api_ready` are replaced; they update shard rows
  and never take the authority row `FOR UPDATE`.
- `api_authority` keeps every guard (runtime login, instance fence, authority
  id, activation, durable primary, role drift on all four tables) and takes
  the authority row `FOR SHARE` only.
- New `api_capacity(authority)` returns the live totals for operator alerts;
  `fence_status` compares the shard totals with the entries table.
- The authority row's `admitted` and `outcome_bytes` are frozen at their
  values at migration time. They are not maintained afterwards.

Lock order everywhere: `runtime_policy` (share), `authority` (share), entries,
then shard rows in ascending order. `fence_repin` still takes the authority
row `FOR UPDATE`, which serializes it with every entry point.

## Before the window

1. The router build that contains the pooled client must already be live
   (CHANGELOG "Replay hot path"). It runs against the old functions too.
2. `scripts/replay_fence.sh status` must report `pinned` and
   `counters_consistent = true`. The migration refuses inconsistent counters.
3. Take a Managed Postgres backup and note its id.
4. Dry run with the writer still up: the file is one transaction; run it with
   the operator assertion and `ROLLBACK` appended, through
   `flyctl mpg connect <cluster> -u <owner> -d <database>` (the same wrapper
   `scripts/replay_fence.sh` uses; it never prints a connection string):

   ```
   SET live402.upgrade_writers_stopped = '1';
   \i ops/replay-postgres-hotpath.sql
   ```

   with the final `COMMIT;` of the file replaced by `ROLLBACK;` for the dry
   run. It should end without errors and report nothing changed.

## The window (writers stopped, about two minutes)

1. Stop the router writer: `flyctl scale count 0 -a 402signal` (the graceful
   drain finishes in-flight paid requests; wait for `/ready` to stop answering).
2. Run the file for real (with `COMMIT;`), preceded by
   `SET live402.upgrade_writers_stopped = '1';`.
3. Check: `SELECT * FROM signal_replay.api_capacity('<authority id>');` from
   the owner session returns the same `admitted` and `outcome_bytes` the
   fence reported before, and `SELECT count(*) FROM signal_replay.authority_shard`
   is 16.
4. Start the router: `flyctl scale count 1 -a 402signal`. `/ready` returns
   `replay_ledger: true` without a fence re-pin because Postgres did not
   restart.
5. `scripts/replay_fence.sh status` reports `pinned` and
   `counters_consistent = true`.

## Rollback

The old function bodies are in `ops/replay-postgres-functions.sql` and
`ops/replay-postgres-identity-expiry.sql`. Re-installing them (writers
stopped) reverts the hot path, but the authority row's frozen counters must
first be set to the shard totals:

```
UPDATE signal_replay.authority a
   SET admitted = s.admitted, outcome_bytes = s.outcome_bytes
  FROM (SELECT sum(admitted) AS admitted, sum(outcome_bytes) AS outcome_bytes
          FROM signal_replay.authority_shard) s
 WHERE a.singleton;
```

Then run the two files and `ops/replay-postgres-fence.sql` (which restores the
authority-row `fence_status`). Leave `authority_shard` in place; it is inert
without the new functions.
