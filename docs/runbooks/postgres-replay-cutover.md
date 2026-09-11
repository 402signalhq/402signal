# Postgres replay on this writer (post-cut)

Replay **only** already lives on Fly Managed Postgres. Catalog, history and the
MainNet PQ log stay on `/data`. Keep `LIVE402_ROUTER_WRITERS=1`. No second Fly
app taking paid `/route`. Do not stop or replace the MainNet PQ signer.

This is operator procedure, not a buyer recipe. Changing this file does not
deploy, set secrets, or migrate. **Do not run a cutover.** The sqlite source is
already fenced.

## Live (do not re-cut)

- App `402signal`, region `iad`. Postgres-capable image lineage (`Dockerfile.postgres`).
  Deploy preserve flag `postgres/pr117-v2` is the **image variant**, not a cluster
  name. There is no unmanaged Fly Postgres app named `pr117-v2`.
- Replay backend is already `LIVE402_REPLAY_BACKEND=postgres` with
  `LIVE402_REPLAY_POSTGRES_API=functions-v1`. DSN and 32-hex authority id are
  already on the writer. `sslmode=verify-full` is required.
- Authority: Fly Managed Postgres cluster **`402signal-replay-v2`** (`*.flympg.net`),
  `iad`, 6PN, no public HTTP. Do **not** create a second cluster.
- `/health` and `/ready` are 200 when `checks.replay_ledger` is true. The DSN
  **belongs** on this writer now.
- `/data/live402-replay.sqlite` remains as **fenced source evidence**
  (`external_authority_id` + `external_migration_digest`). It is not the serving
  authority. A second `--apply` must fail closed (`source already fenced`).
- `LIVE402_ROUTER_WRITERS` may be unset; the runtime defaults to `"1"`.
- `fly.toml` `[env]` stays sqlite-path defaults. Backend and DSN stay secrets.

Confirm continuity of the existing authority. Do not invent a fresh authority
id, empty target, or second migrate.

## Ready check (not a migrate)

On a process that already has `LIVE402_REPLAY_BACKEND=postgres` (the writer, or
a console with that same backend):

```sh
PYTHONPATH=. python3 scripts/replay_stage_ready.py
```

Prints `{"ok": true}` or `{"ok": false}`. No DSN, host, or password.
`ok: false` means do not pay and do not "fix" by unfencing sqlite.

The script refuses a Fly process whose serving backend is still sqlite. That
guard is for a pre-cut machine. It is not a reason to attach a DSN to sqlite
again.

## If `/ready` is not all true

**Do not pay.** Preserve the MPG cluster, the fenced sqlite file, and uncertain
operations. Recover via `docs/route-recovery.md`. Never a second nonce. Never
unfence sqlite. Never `--apply` again. Never restore an older ledger over newer
payments.

Ambiguous commit stays unavailable / HTTP 503. That is not permission to retry
payment.

## Paid traffic after this state

One organic paid open is allowed only when operator + 402security treat the
current `/ready` as post-cut green. Skip if replay is uncertain. Do not pay
mid-recovery and do not pay to “prove” a migrate that already happened.

## Do not

- `fly postgres create` or attach a second cluster
- Rerun `scripts/replay_migrate.py --apply`
- Unfence sqlite or treat `/data/live402-replay.sqlite` as the live authority
- Raise the writer count or `min_machines_running`
- Move catalog, history, or the PQ log onto Postgres
- Add a second paid `/route` app or a leadership lease
- Put Falcon keys on the router
- Publish DSN, authority id, or backup contents
- Restore sqlite over the fenced source or an older ledger over newer payments
