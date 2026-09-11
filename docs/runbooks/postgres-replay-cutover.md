# Postgres replay cutover (this writer)

Cut **replay only**. Catalog, history and the MainNet PQ log stay on `/data`.
Keep `LIVE402_ROUTER_WRITERS=1`. No second Fly app taking paid `/route`.
Do not stop or replace the MainNet PQ signer.

This is operator procedure, not a buyer recipe. It does not provision cloud
resources from a merge. Changing this file does not deploy or set secrets.

## Current writer

The live image is already the postgres-capable variant (`Dockerfile.postgres`).
Replay still uses SQLite (`LIVE402_REPLAY_DB=/data/live402-replay.sqlite`).
`LIVE402_REPLAY_BACKEND` is unset (sqlite). That is the fence-aware sqlite
stage required before activation.

Do **not** put `LIVE402_REPLAY_POSTGRES_DSN` or `LIVE402_REPLAY_AUTHORITY_ID`
on the serving writer while the backend is sqlite. Conflicting env fails
`replay_ledger` and Fly will pull paid traffic. Stage the DSN from a console.

`fly.toml` stays sqlite-default. Backend and DSN are Fly **secrets** at cut,
not `[env]`. A merge of this runbook must not flip production.

## Existing cluster (402ops)

Use the Fly Postgres already attached to this writer (preserved on deploys as
`postgres/pr117-v2`). Do **not** create a second cluster, a second app, or a
public Postgres.

1. Confirm it is **`iad`**, **6PN only**, no public HTTP.
2. Runtime DSN: `sslmode=verify-full` and a pinned CA. Test-mode `sslmode=disable`
   is forbidden on Fly.
3. Separate migration-owner login from the runtime Reader login on **that**
   cluster.
4. Fresh 128-bit authority id (32 lowercase hex). Do not reuse a lab id.
5. Empty **replay** target (`signal_replay.authority` / `entries`). Never import
   onto a database that already has those tables. Other uses of this cluster
   stay out of the replay schema.

Budget inventory still has to close before paid activation. This runbook does
not pick a paid plan and does not authorize a new Postgres bill.

## Stage (console, writers still serving sqlite)

Dry-run is source-only. It does not touch Postgres:

```sh
PYTHONPATH=. python3 scripts/replay_migrate.py --source /data/live402-replay.sqlite
```

After the destination exists and TLS works, check the **inactive** target from
a console that holds the DSN, not from the live sqlite process. After apply
activates the authority, the same console check is:

```sh
PYTHONPATH=. python3 scripts/replay_stage_ready.py
```

It prints `{"ok": true}` or `{"ok": false}`. No DSN, host, or password.
`ok: false` means do not cut the writer.

## Cut

1. Keep writers at 1. Drain paid `/route`. Assert `--writers-stopped`.
2. Wait until private response windows have expired (120s). Economic identities stay.
3. Off-host encrypted SQLite bundle (`docs/backup.md`). Replay sqlite is source
   evidence after the fence, not a second authority.
4. Apply once:

```sh
PYTHONPATH=. python3 scripts/replay_migrate.py \
  --source /data/live402-replay.sqlite \
  --apply --writers-stopped
```

The tool fences the sqlite source **before** activating Postgres. A crash is
one authority or neither, never two. Do not rerun `--apply` on a fenced source.

5. Set secrets on **this** app only: `LIVE402_REPLAY_BACKEND=postgres`,
   `LIVE402_REPLAY_POSTGRES_DSN` (runtime login, `sslmode=verify-full`),
   `LIVE402_REPLAY_AUTHORITY_ID`. Optional `LIVE402_REPLAY_POSTGRES_API=functions-v1`
   with `LIVE402_REPLAY_POSTGRES_RUNTIME_LOGIN` when using the managed functions
   schema. Leave catalog/history/PQ paths on `/data`.
6. Restart the single writer. Confirm `GET /health` and `GET /ready` are 200
   with `checks.replay_ledger=true` and the other checks still true.
7. If `/ready` is not all true: **do not pay**. Preserve source, destination,
   and uncertain operations. Recover via `docs/route-recovery.md`. Never a
   second nonce. Never unfence sqlite to “fix” it.

## After `/ready` is green

One organic paid open. That is the last mainnet pay this week. Skip if replay
is uncertain.

Ambiguous commit stays unavailable / HTTP 503. That is not permission to retry
payment.

## Do not

- Raise the writer count or `min_machines_running`
- Move catalog, history, or the PQ log onto Postgres
- Add a second paid `/route` app or a leadership lease
- Put Falcon keys on the router
- Publish DSN, authority id, or backup contents
- Restore sqlite over the fenced source or an older ledger over newer payments
