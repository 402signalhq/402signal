# Changelog

All notable changes to the hosted service, the client packages and the MCP
server. The format follows Keep a Changelog; dates are UTC.

## Unreleased

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
