# Changelog

All notable changes to the hosted service, the client packages and the MCP
server. The format follows Keep a Changelog; dates are UTC.

## Unreleased

- Replay hot path: the PostgreSQL replay client keeps a bounded pool of
  connections per process (`LIVE402_REPLAY_POOL_SIZE`, default 8) and runs
  each paid admission write as one pipelined round trip. The owner migration
  `ops/replay-postgres-hotpath.sql` moves the admission and byte counters to
  sixteen shard rows so reservations stop serializing on the authority row;
  every guard, the identity primary key and exact quota enforcement are
  unchanged. `api_capacity` reports live totals; `fence_status` reconciles
  against the shards. Runbook: `docs/runbooks/replay-hotpath-migration.md`.
- `@402signal/route-guard` 0.7.3 is published: the GitHub release archive
  (`route-guard-v0.7.3`, digest pinned in `/capabilities.json`) and the npm
  registry package with a provenance attestation. `capabilities.json` records
  the published digests, `verifier_package` moves to 0.7.3, the installer
  script and every install instruction point at 0.7.3, and the developer
  guide leads with `npm install` plus `npm audit signatures`.
- MCP: `check` is a paid alias of `route` with the same schema, fee and
  result, listed right after `route` in `tools/list` and the manifest.
- Website: new homepage built around the one-minute try and the two client
  hooks, with the returns table, field numbers and a shorter evidence
  section; the September "State of x402 endpoints" report is published at
  `/insights/state-of-x402-endpoints-2026-09` and listed in the sitemap.
- Public per-host endpoint pages at `/endpoints/<host>` (catalog listings,
  declared networks, 30-day public probe results, an embeddable SVG badge), a
  host index at `/endpoints`, and `/endpoints/sitemap.xml`. Only public
  organic probes from trusted observation classes are counted; nothing a
  seller pays for changes the numbers.
- `/verify`: receipt verification in the browser with WebCrypto and a key you
  pin yourself; nothing is uploaded. Checked in CI against the conformance
  fixture under Node.
- `/status` (live readiness booleans, monitoring method, incident issues) and
  `/security` (custody boundaries, controls, automated checks, reviews so
  far); Status and Security links in every footer.
- Developer guides show the x402 `onBeforePaymentCreation` hook and the mppx
  `onChallenge` hook next to the existing wrap.
- Replay authority runbook records the move to the Basic cluster
  `402signal-replay-v3`.
- Python package `402signal` (import `signal402`, `sdk/python`): unpaid
  challenge, paid check and read-only recovery helpers, outcome
  classification, and an offline receipt verifier (reveal commitment, leaf
  hash, RFC 6962 inclusion, Ed25519 checkpoint signature) that matches the
  server implementation on the conformance fixture. Published from
  `publish-pypi.yml` with PyPI Trusted Publishing on `python-v*` tags.
- `@402signal/route-guard`: new `./mpp` export with `mppGuard`, an mppx
  `onChallenge` hook plus `challenge.received` observer that runs the hosted
  Check group offer observation for Base USDC charges, verifies the receipt
  locally and aborts when the live challenge's terms differ.
- `@402signal/route-guard`: new `./x402` export with `signalGuard`, an
  `onBeforePaymentCreation` hook for the official x402 client that runs the
  hosted check, verifies the receipt locally and aborts mismatched payments.
- Replay identities now expire on Solana and Algorand too (conservative
  bounds from verification time), not only on Base.
- Check credits (API key v0): operator-issued credits can now cover up to
  1,000 listed-URL checks for up to 30 days.
- MCP tool descriptions cut to about a third of their length.
- `scripts/endpoint_report.py` renders the "State of x402 endpoints" report
  from catalog and probe history copies; the September 2026 edition is
  published under `docs/insights/`.
- README, homepage and `llms.txt` now open with a one-minute start (unpaid
  curl, the x402 hook, evaluation credits) and document the `./x402` hook.
- The provisional route-guard 0.7.3 pack digest is re-pinned because the
  `x402` adapter joined the package.
- `ops/loadtest/`: k6 scripts for the free and paid paths and a disposable
  free-path staging config; `docs/load-test.md` records the procedure and
  results.
- Repository hygiene: external uptime probe with incident issues, OpenSSF
  Scorecard, npm publish workflow with provenance, security and contributing
  policies, issue and pull request templates.
- Historical release gates, closeouts and operator runbooks moved to the
  private operations repository; public docs now describe current contracts
  only.
- Production image labels are `api-<sha>`.

## 2026-09-13

- Router lease for managed PostgreSQL without GRANT or REVOKE (#196).
- Replay instance fence with verified re-pin after a database restart and
  attested recovery after a failover or restore (#197).
- Replay admission throughput benchmark on Managed Postgres (#198): about
  45 admissions per second per router process, 100 to 120 across processes.
- Base and Solana routing-fee treasuries rotated (#199).

## 2026-09-12

- Replay identities expire once their Base authorization can no longer settle
  (#195).
- Per-payer budget for verified attempts that do not settle; gated production
  deploy workflow (#194).
- Writer lease, private organic metrics, backup schedule, readiness cache,
  graceful drain, separate free and paid discovery pools, IPv6 /64 abuse
  identity, $0.005 session accounting fix (#193).
- Hosted session price and hop shape published (#191, #192).

## 2026-09-11

- Postgres replay authority cut over on the production writer (#190).
- Hosted session open ($0.005) and hops, hashed trial credits (#184 to #188).
- Only the billable winner is promoted to settled history (#185).

## 2026-09-10

- `@402signal/route-guard` 0.7.2: Check group offer without `merchant_profile`,
  digest-checked install, default `wrapExactAuthorize` (#168 to #179).
- Canonical origin and site disclosure pages (#182).

## 2026-09-09

- `@402signal/route-guard` 0.7.1: pinned log keys win over response-offered
  keys (#154, #156).
- Bounded unpaid public request admission (#155); separate unpaid discovery
  budget (#150).
- MCP Registry metadata 0.3.2 (#157).

## 2026-09-08

- `@402signal/route-guard` 0.7.0, `session-client` 0.1.1, `mpp-client` 0.1.0,
  `algorand-batch-buyer` 0.2.0 release archives.
- Native MPP charge integrations for Base and Algorand (#139); bounded
  sessions and Algorand payment manifests (#138).
