# Router writer lease

Status: implemented. Production uses the `file` backend on the single writer
Machine. Paid `/route` stays on that one Machine (`min_machines_running = 1`).
The MainNet signer remains the only Falcon publisher.

## What the lease guards

Without the lease, each of these no-ops or refuses:

| Path | Without the lease |
|---|---|
| PQ anchor worker `start_worker` and every tick | not started; ticks skip |
| Catalog crawler `start_refresher` and every trickle | not started; trickles skip |
| PQ leaf append (`receipt.append_event`) | `ReceiptError`; no second tree |
| Paid `POST /route`, paid MCP `route`, recovery | HTTP 503 `writer_unavailable` before verification |
| Writer housekeeping (session prune, metric flush) | skipped |

Nothing is verified or reserved before the 503, so the same authorization may
be retried. Unpaid pages, discovery and challenges keep serving.

## Backends

`LIVE402_LEADERSHIP_BACKEND`:

- `none`: implicit single-process leadership. Local development and fixtures.
- `file`: exclusive `flock` on `/data/router-leadership.lock`
  (`LIVE402_LEADERSHIP_LOCK`). A Fly volume attaches to one Machine, so a
  second Machine or a second process cannot hold it. Production default.
- `postgres`: row lease in the replay database, `signal_router.router_leadership`.
  Renew about every 5 s (`LIVE402_LEADERSHIP_RENEW_S`), hold about 15 s
  (`LIVE402_LEADERSHIP_TTL_S`). Expiry uses the database clock. A holder counts
  its lease from the local monotonic time taken before the renew call, minus a
  2 s safety margin, so it stops publishing before anyone else can acquire.
  Another holder acquires only after expiry and increments the epoch.

An unknown backend value fails closed (never leader).

## Why production is on `file` today

The lease table belongs on the same Postgres as replay. The router's runtime
login on the managed cluster is a non-owner Reader. It cannot create schemas
or tables, and runtime DDL is forbidden by the replay design. Fly Managed
Postgres also refuses every GRANT and REVOKE ("MPG system roles cannot be
modified"), so `ops/router-leadership.sql` cannot be installed there.

`ops/router-leadership-managed.sql` is the managed variant: the same table and
function signatures, no GRANT or REVOKE, and each function refuses every login
except the replay runtime login pinned in `signal_replay.runtime_policy`. The
runtime login reaches the schema through its read-all role and still cannot
write the table directly. Installing it changes nothing until the backend is
switched.

Staying on `file` with one Machine is deliberate. The kernel releases a
crashed process's `flock` immediately, while a database lease stays held until
it expires (up to `LIVE402_LEADERSHIP_TTL_S`), so a crash restart would wait
before taking paid traffic. The Postgres backend also makes anchoring and
catalog work depend on the database. Switch when a second Machine exists.

Activation of the Postgres backend (operator, when a standby is planned):

1. As migration owner, after `ops/replay-postgres-functions.sql`:
   - managed PostgreSQL: `psql -f ops/router-leadership-managed.sql`;
   - self-managed PostgreSQL: `psql -f ops/router-leadership.sql`, then the
     three `GRANT` statements in its header for the runtime login.
2. Set `LIVE402_LEADERSHIP_BACKEND = "postgres"` in `fly.toml` and deploy.
3. Confirm logs show `leadership acquired backend=postgres` exactly once.

A standby without the `/data` volume still cannot publish PQ leaves, so the
Postgres lease is a prerequisite for, not the completion of, a multi-machine
writer.

## Failover drill (do not execute against production without an operator instruction)

Preconditions: take a volume snapshot; confirm no automation job is in
`AUTHORIZED`, `SEND_ATTEMPTED` or `SUBMITTED`; confirm `/ready` is green.

1. Stop the writer: `fly machine stop <writer id> -a 402signal`.
2. Expected: the process receives SIGTERM, drains in-flight paid requests for
   up to `LIVE402_DRAIN_S`, flushes metrics, releases the lease, and exits.
   Logs show `leadership released`.
3. Who publishes while it is stopped: nobody. The signer receives no anchor
   request. No other Machine holds `/data` or the lease.
4. Start the writer: `fly machine start <writer id> -a 402signal`.
5. Expected: `leadership acquired backend=file`, then catalog crawl and PQ
   ticks resume. The tree size and root are unchanged from before the stop;
   the next anchor covers leaves appended after restart.
6. With the Postgres backend, repeat with two processes on a staging app:
   stop holder A; holder B logs `acquired` only after the lease expiry, with
   epoch + 1; A never logs `acquired` again without a fresh renew.

Record timings and log lines. Never clear automation state to make the drill
pass.
