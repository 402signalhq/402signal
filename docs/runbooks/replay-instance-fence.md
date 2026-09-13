# Replay instance fence

Tooling: `ops/replay-postgres-fence.sql` (owner migration) and
`scripts/replay_fence.sh` (operator wrapper around `flyctl mpg connect`).

## What stops paid routes after a database restart

`signal_replay.runtime_policy` pins the PostgreSQL postmaster start time and
server address. Every replay entry point compares them with the live server. Any
restart, failover, promotion or restore breaks the match: `/ready` fails and paid
`/route` returns 503 before verification. Free traffic keeps serving. Nothing
re-pins automatically, and restarting the router does not clear it.

## Install (migration owner, once)

After `ops/replay-postgres-functions.sql`:

```bash
fly mpg connect <cluster> -u fly-user -d <database> < ops/replay-postgres-fence.sql
```

Run a rolled-back dry run first. While the fence still matches, the install
records the current WAL timeline as evidence, so the first later restart can
re-pin without attestation. It adds two owner tables and owner-only functions;
the runtime login, replay entry points and readiness guard are unchanged.

## Routine

Run `status` on a schedule and before planned maintenance. While pinned it saves
`<timeline> <WAL position>` under `~/.402signal-fence`, outside the database.
Back that directory up with the other operator state.

```bash
FENCE_CLUSTER=<cluster> FENCE_DATABASE=<database> scripts/replay_fence.sh status
```

## When paid routes stop with "replay authority unavailable"

1. Run `status`. Act on `classification`:
   - `pinned`: the fence is not the cause. Check connectivity, credentials and
     capacity.
   - `restart`: run `repin-restart`. Paid admission resumes within the router's
     readiness cache (about 5 s). No router restart is needed.
   - `instance_changed` or `no_evidence`: do not re-pin yet. Run `report`.
     Reconcile every `settlement_pending` and `unknown` identity against on-chain
     settlements and router logs, and compare `admitted_count` with the last
     recorded value (`fence_events`, metrics). Then run
     `repin-attested <admitted_count> "<what was checked>"`.
   - `not_durable_primary`: wait for a writable primary. Never re-pin a replica.
2. Run `status` again. It must report `pinned`. Run the public smoke checks.

## Why a plain restart is safe, and the limits

- `restart` requires the same server address, the same WAL timeline, a WAL
  position at or beyond the recorded high-water marks, and consistent
  `admitted`/`outcome_bytes` counters. Every replay entry point already requires
  `fsync`, `full_page_writes` and `synchronous_commit`, so a restart of the same
  history cannot lose an acknowledged commit.
- A failover or promotion starts a new timeline; a restore comes up on a new
  cluster address. Fly Managed Postgres replicates asynchronously
  (`synchronous_standby_names` was empty on 2026-09-12), so a failover can lose
  the most recent acknowledged admissions. A lost identity could let the same
  payment authorization be admitted again until it expires. That is why these
  cases need a reconciled attestation.
- The database cannot detect an older copy restored onto the same address and
  timeline. The external high-water mark catches that only if `status` ran after
  the lost writes, so the time between `status` runs is the exposure window. A
  router-side high-water (recording the commit position of each admission on
  the router volume) would close the gap; it is not implemented.
- A re-pin never changes the authority, capacity, retained identities or the
  runtime login. Every re-pin is recorded in `signal_replay.fence_events`.
- The router has no owner credential by design. Running `repin-restart`
  automatically would require storing an owner credential in a scheduler; that
  is an operator decision.
