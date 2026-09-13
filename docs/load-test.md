# Load test

How the HTTP layer is measured, separately from the replay authority (see
`replay-throughput-benchmark.md`). Results are appended at the bottom with the
revision they were measured on.

## Two targets, on purpose

The server refuses test-support modes (`LIVE402_FIXTURE`, `LOCAL_FREE`) on any
Fly machine, so there is no "fixture staging app". The two halves are measured
in the two places they can run honestly:

1. **Free path on Fly hardware.** A disposable production-shaped app in the lab
   organisation, deployed from `ops/loadtest/fly.staging.toml`: same image and
   machine size as production, no volume, no secrets, no replay authority, no
   PQ signer. `/ready` is not ready and every paid request is refused
   in-process before verification, which is exactly the production behaviour
   during an authority outage. The unpaid challenge, `/preview`, `/rails`,
   `/pulse` and `/health` are real.
2. **Paid path locally in fixture mode.** `LIVE402_FIXTURE=1 LOCAL_FREE=1` on a
   loopback bind with an ephemeral, never-persisted `LIVE402_PQ_LOG_SK` so
   receipts are signed and appended. Discovery, ranking, probing, receipt
   signing and leaf append run for real against synthetic sellers; nothing
   touches a facilitator or the replay authority. The number is per process on
   the developer's CPU, so treat it as an upper bound for one Fly
   `performance-1x` vCPU and scale it down (roughly 2x) before planning.

Combine with the replay benchmark (about 45 admissions per second per process)
to reason about end-to-end paid capacity: the paid path costs one probe
pipeline run plus two replay writes plus one facilitator verify and, on a hit,
one settle.

## Fly target

```sh
flyctl apps create 402signal-staging -o 402testenvironment
flyctl deploy -a 402signal-staging -c ops/loadtest/fly.staging.toml --dockerfile Dockerfile.postgres --remote-only --ha=false --build-arg GIT_SHA=$(git rev-parse HEAD)
k6 run -e TARGET=https://402signal-staging.fly.dev -e VUS=50 -e DURATION=60s ops/loadtest/free-path.js
flyctl apps destroy 402signal-staging -y
```

Wait for `/pulse` to report a populated catalog before measuring `/preview`;
the crawler fills it from the public discovery feeds in the first minutes.
Destroy the app afterwards; it bills like a production machine while it runs.

## Local target

```sh
export LIVE402_FIXTURE=1 LOCAL_FREE=1 PYTHONPATH=. LIVE402_LEADERSHIP_BACKEND=none
export LIVE402_ROUTE_RPM=1000000 LIVE402_PREVIEW_RPM=1000000 LIVE402_PUBLIC_RPM=1000000
export LIVE402_PQ_LOG_SK=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')   # throwaway
python3 -m live402 --host 127.0.0.1 --port 8099 &
k6 run -e TARGET=http://127.0.0.1:8099 -e VUS=20 -e DURATION=60s ops/loadtest/paid-path.js
```

Without `LOCAL_FREE` the same fixture server answers `POST /route` with the
unpaid 402, so `free-path.js` can also run locally for a quick regression check.

## Scripts

- `ops/loadtest/free-path.js`: unpaid 402 challenge, `/preview`, `/rails`,
  `/health`. None of these touch the replay authority.
- `ops/loadtest/paid-path.js`: `POST /route` bodies that discover, rank and
  probe synthetic sellers end to end, with and without route binding.

Run from a machine close to `iad` when latency matters; a laptop run measures
throughput adequately but adds its own network latency to every percentile.

## What the numbers mean

- The free path is what marketing drives (discovery, MCP handshakes, unpaid
  challenges, report traffic). If it saturates below the traffic you expect,
  the HTTP layer is the limit and the ASGI rewrite is justified.
- Fly's `[http_service.concurrency]` limits (soft 150, hard 190 requests) cap
  what one machine accepts; 503 "server busy" from the app and 429 from
  admission are counted separately by the scripts.

## Results

Appended by whoever runs the test: date, revision, target, k6 summary
(requests per second, p50, p95, error rate) for each script.

### 2026-09-13, revision b74f388 (k6 v2.2.0)

**Local, fixture mode, one process, Intel i9-13980HX (WSL2).** Percentiles
include loopback only. Treat as an upper bound for one Fly `performance-1x`
vCPU; halve the throughput before planning.

| Script | VUs | Duration | Requests/s | p50 | p95 | Errors |
|---|---:|---:|---:|---:|---:|---:|
| free-path (challenge, preview, rails, health) | 50 | 45 s | 849 | 1.3 ms | 35 ms | 0% |
| paid-path (LOCAL_FREE, 3 hits + 1 miss) | 20 | 45 s | 59.5 | 116 ms | 833 ms | 0% (misses answered 503 by design) |

Per endpoint on the free path: unpaid 402 challenge p50 1.2 ms / p95 2.6 ms,
`/preview` p50 19 ms / p95 56 ms, `/rails` and `/health` about 1 ms. On the
paid path 44.9 qualifying observations per second completed; the remaining
quarter were the stale-URL misses, each a fast 503. Receipt signing was not
exercised (no log signer in the fixture harness).

**Fly, production-shaped staging app (`performance-1x`, 2 GB, iad), client on
a residential connection in the eastern US.** Free path with `PREVIEW=0`
because the fresh catalog was still warming from the upstream feeds.

| Script | VUs | Duration | Requests/s | p50 | p95 | Max | Errors |
|---|---:|---:|---:|---:|---:|---:|---:|
| free-path (challenge, rails, health) | 50 | 60 s | 273 | 18 ms | 236 ms | 14.3 s | 1 of 16,678 |

Unpaid 402 challenge p50 23 ms / p95 246 ms; `/rails` and `/health` p50 17 ms.
The gap between p50 and p95, and the 14 s outlier, come from the path between
the client and the Fly edge plus proxy queueing, not from the process: the
same endpoints answer in about a millisecond locally. Run the client from a
machine in `iad` for a clean server-side number.

Reading: one process serves roughly 850 cheap requests per second and about
45 fixture-mode paid observations per second, the same order as the replay
authority's 45 admissions per second per process. Real sellers add their own
probe latency (p50 870 ms, p95 2.5 s in September 2026 probe history), which
occupies handler threads rather than CPU, so the handler cap
(`LIVE402_MAX_HANDLERS`, 200) and the probe cap (`LIVE402_MAX_PROCESS_PROBES`,
32) bound production concurrency before CPU does.
