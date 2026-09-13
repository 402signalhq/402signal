# Security policy

402Signal moves money on behalf of automated buyers, so reports about the
payment, replay, probe and signer paths get priority.

## Report a vulnerability

Email **ross@402signal.com** with a concise description, the affected
revision or package version, and a safe reproduction. The machine-readable
contact is published at https://402signal.com/.well-known/security.txt.

Please do not:

- send private keys, seed phrases, payment headers, recovery secrets or
  unredacted customer records; use synthetic fixtures where possible;
- test destructive behaviour or spend funds against someone else's endpoint
  without permission;
- open a public issue for an unfixed vulnerability.

You can expect an acknowledgement within three business days and a fix or a
documented decision within thirty days for confirmed reports. Reports made in
good faith under this policy will not be met with legal action.

## Scope

- The hosted service at https://402signal.com (router, MCP server, public
  transparency log).
- `sdk/route-guard` and the other client packages in this repository.
- The isolated Falcon signer (private repository; report through the same
  address).

Out of scope: third-party facilitators, seller endpoints listed in the catalog,
and denial-of-service findings that require volumes beyond the published
admission limits.

## Rewards

Verified findings on the payment, replay, probe and signer paths are rewarded
at the operator's discretion, currently $100 to $500 by severity, paid in USDC.

## Supported versions

Fixes land on `main` and in the latest published package version. Older
release archives are not patched.

## What is already in place

- Facilitator verify before any probe; settle only for a qualifying live
  offer; ambiguous settlements are never retried.
- Replay identities are durable in PostgreSQL with a single-writer lease and
  an instance fence that stops paid routes after any database restart until an
  operator reconciles.
- Outbound probes pin DNS results to globally routable addresses and
  re-validate redirects.
- Dependencies are hash-locked; base images and GitHub Actions are pinned by
  digest; CodeQL, pip-audit and npm audit run on every change.
- The Falcon signer holds the only post-quantum key, has no public address,
  and authorises checkpoint transactions only.
