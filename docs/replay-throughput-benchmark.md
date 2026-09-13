# Replay admission throughput (2026-09-13)

## Question

How many paid admissions per second can the functions-v1 replay authority on Fly
Managed Postgres accept, and is the Basic plan enough for the 20M/day planning
target (about 231 per second on average)?

## Setup

- Database: a temporary Fly Managed Postgres **Basic** cluster (shared-2x, 1 GB,
  PostgreSQL 16, iad) in the lab organization, destroyed afterwards. Schema from
  `ops/replay-postgres-functions.sql` and `ops/replay-postgres-identity-expiry.sql`,
  a separate reader login, `sslmode=verify-full` like production.
- Client: a performance-2x Machine in iad running `scripts/replay_bench.py`,
  which drives the router's real `PostgresStore`. One admission is `reserve`
  (with an authorization expiry) followed by `finish(settled)`: the two ledger
  writes of a paid route. Processes model router processes; threads model
  concurrent paid requests per process. 20 s per level after a 3 s warm-up.
  17,990 admissions in total, zero errors.
- Server-side reference, measured inside the database: synchronous commit
  0.82 ms, the replay privilege guard 0.18 ms. `SELECT 1` round trip about 2 ms.

## Results

Pooled host (`pgbouncer.<cluster>.flympg.net`):

| Processes × threads | Admissions/s | p50 | p95 | p99 |
|---|---:|---:|---:|---:|
| 1 × 1 | 37.0 | 25 ms | 36 ms | 56 ms |
| 1 × 4 | 43.1 | 71 ms | 242 ms | 375 ms |
| 1 × 16 | 45.4 | 208 ms | 1,032 ms | 1,624 ms |
| 1 × 64 | 43.0 | 842 ms | 4,539 ms | 6,116 ms |
| 2 × 16 | 73.7 | 415 ms | 1,006 ms | 1,279 ms |
| 4 × 16 | 96.8 | 620 ms | 1,460 ms | 1,885 ms |
| 8 × 16 | 100.8 | 1,179 ms | 2,652 ms | 3,533 ms |

Direct host (`direct.<cluster>.flympg.net`):

| Processes × threads | Admissions/s | p50 | p95 | p99 |
|---|---:|---:|---:|---:|
| 1 × 1 | 47.5 | 20 ms | 27 ms | 34 ms |
| 1 × 16 | 45.8 | 196 ms | 1,119 ms | 1,550 ms |
| 4 × 16 | 119.4 | 521 ms | 1,121 ms | 1,534 ms |
| 8 × 16 | 97.2 | 1,233 ms | 2,715 ms | 3,632 ms |

Latencies cover both writes of one admission, including time queued behind
other requests.

## Findings

1. **One router process tops out at about 40–48 admissions per second.**
   `PostgresStore` holds one connection behind a process lock, so every
   concurrent request queues for it. More concurrency raises latency, not
   throughput.
2. **All processes together plateau near 100–120 admissions per second.**
   `api_reserve` and `api_finish` both take the single `signal_replay.authority`
   row `FOR UPDATE` (capacity and byte counters) and hold it until commit, so
   writers serialize across processes. The shared-CPU database may also
   contribute; the benchmark does not separate the two.
3. **The database's own work is small** (about 1 ms to commit, 0.2 ms for the
   guard). The time goes to round trips made while holding those locks and to
   client-side queueing. A larger plan removes neither serialization point.
   Starter has the same shared-2x CPU class; it was not benchmarked.
4. **The pooled host adds about 5 ms per admission** at low concurrency compared
   with the direct host.
5. **At about 100 per second the authority can admit roughly 8.6M per day** at a
   perfectly even rate. That is below the 20M/day average target and well below
   realistic peaks. Current production volume is orders of magnitude lower, so
   this is a scaling limit, not an incident.
6. **TLS:** `sslrootcert=system` fails with psycopg's bundled libpq. The cluster
   presents a Let's Encrypt certificate that verifies with
   `sslrootcert=/etc/ssl/certs/ca-certificates.crt`.

## Implemented after the benchmark (2026-09-13)

- **Client:** `PostgresStore` keeps a bounded pool of connections per process
  (`LIVE402_REPLAY_POOL_SIZE`, default 8, at most 32) instead of one connection
  behind a lock, and each `reserve`, `finish` and `abandon` is one pipelined
  round trip: BEGIN, the four `SET LOCAL` settings, the owner function and
  COMMIT are queued together and synchronized once, and the result is read
  only after the commit is acknowledged. Reads, readiness and maintenance keep
  the explicit multi-statement transaction. A request that cannot get a
  connection within five seconds fails closed instead of queueing.
- **Database:** `ops/replay-postgres-hotpath.sql` (proposal 1 below) moves the
  counters to sixteen shard rows with exact per-shard quotas that sum to the
  authority quotas. Reservations lock one shard row; the authority row is
  taken `FOR SHARE` only. Installation: `docs/runbooks/replay-hotpath-migration.md`.
- **Measured (2026-09-13, second disposable Basic cluster, same rig, pool of
  8 connections per process, 20 s per level):**

  New client against the *old* functions (authority row lock still there),
  pooled host:

  | Processes × threads | Admissions/s | p50 | p95 | p99 | errors |
  |---|---:|---:|---:|---:|---:|
  | 1 × 1 | 20.5 | 24 ms | 66 ms | 493 ms | 0 |
  | 1 × 4 | 108.0 | 31 ms | 53 ms | 97 ms | 0 |
  | 1 × 16 | 97.5 | 65 ms | 694 ms | 1,596 ms | 3 |
  | 4 × 16 | 87.0 | 303 ms | 2,402 ms | 4,416 ms | 48 |
  | 8 × 16 | 63.5 | 684 ms | 4,476 ms | 5,564 ms | 281 |

  Pooling alone lifts one process from 43 to 108 admissions/s at four
  threads, then the row lock takes over: more concurrency means longer
  waits and `lock_timeout` errors (the errors are refused admissions, never
  duplicates; the counters stayed consistent throughout).

  New client against the *sharded* functions, pooled host:

  | Processes × threads | Admissions/s | p50 | p95 | p99 | errors |
  |---|---:|---:|---:|---:|---:|
  | 1 × 1 | 18.6 | 18 ms | 63 ms | 594 ms | 3 |
  | 1 × 4 | 143.9 | 22 ms | 45 ms | 145 ms | 0 |
  | 1 × 16 | 210.9 | 31 ms | 259 ms | 1,131 ms | 1 |
  | 4 × 16 | 448.1 | 70 ms | 525 ms | 1,077 ms | 0 |
  | 8 × 16 | 295.6 | 165 ms | 1,428 ms | 3,903 ms | 62 |

  Direct host:

  | Processes × threads | Admissions/s | p50 | p95 | p99 | errors |
  |---|---:|---:|---:|---:|---:|
  | 1 × 1 | 45.1 | 20 ms | 27 ms | 38 ms | 0 |
  | 1 × 4 | 169.7 | 22 ms | 33 ms | 55 ms | 0 |
  | 1 × 16 | 276.1 | 26 ms | 224 ms | 769 ms | 0 |
  | 4 × 16 | 406.6 | 67 ms | 648 ms | 1,482 ms | 0 |
  | 8 × 16 | 110.4 | 151 ms | 895 ms | 3,637 ms | 1,712 |

  Findings: the plateau moved from 100–120 to about 400–450 admissions per
  second (3.5 to 4 times), and one process now reaches 210–276 per second
  instead of 45. The 300 per second target is met at 4 × 16; the p95 target
  of 100 ms is met only up to about 170 per second (1 × 4 direct), because
  the shared-2x database CPU is now the limit: at 400 per second it commits
  800 synchronous transactions per second. The 8 × 16 errors are connections
  refused or pool waits that hit the five-second fail-closed limit (64
  direct connections against the Basic plan's connection budget), not
  duplicates; the fence reported consistent counters after every run. A
  larger plan now buys throughput, which it did not before. Use the direct
  host for the router: it saves about 5 ms per admission and avoids the
  pooler's serialization at 16 threads.

## Proposed changes (proposals 1 to 3 are implemented above)

1. **Take the global row lock out of the hot path.** Keep identity uniqueness on
   the primary key and the activation, fence and role checks under shared locks.
   Move `admitted` and `outcome_bytes` to sharded counter rows (fingerprint hash
   mod N) or to a periodically reconciled counter with a safety margin below
   `max_rows`. Capacity is a lifetime budget (10M, with 725 used), so exact
   per-admission enforcement is not required.
2. **Pool connections per router process** so concurrent paid requests stop
   queueing behind one connection.
3. **Cut round trips per operation.** Move the per-transaction `SET LOCAL`
   statements into function-level settings, and confirm each operation is one
   pipelined round trip.
4. **Re-run this benchmark after each change.** Before enabling a second router,
   target at least 300 admissions per second sustained with p95 under 100 ms.

## Plan decision

Basic handles today's volume. The limits above apply to Starter as well, so
paying for Starter buys no replay throughput. Switching plans restarts Postgres,
which trips the instance fence; use the replay instance fence runbook in the private operations repository.

## Reproduce

On a disposable cluster with the replay schema, a reader login, and an
authority and runtime policy for a benchmark authority ID, from a Machine in the
same region with `BENCH_DATABASE_URL` set as a secret:

```bash
LIVE402_BENCH_ACK=disposable-benchmark-authority BENCH_CLUSTER_ID=<disposable cluster id> \
  python -m scripts.replay_bench --authority <32-hex id> \
  --levels 1x1,1x4,1x16,1x64,2x16,4x16,8x16 --seconds 20 --warmup 3
```

The script refuses any database host that does not name the disposable cluster given in `BENCH_CLUSTER_ID`, and prints JSON only.
