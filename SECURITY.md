# Security policy

402Signal helps automated buyers check offers and verify decision evidence before their own payment client authorizes a purchase. Reports about payment authority, replay, receipt verification, probes and signing boundaries get priority.

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
- `sdk/route-guard` and the other client packages and adapters in this repository.
- The isolated Falcon signer (private repository; report through the same
  address).

The public repository contains clients, adapters and verification contracts. The hosted-service implementation is maintained separately; its vulnerability reports still belong at the same address.

Out of scope: third-party facilitators, seller endpoints listed in the catalog,
and denial-of-service findings that require volumes beyond the published
admission limits.

## Rewards

Verified findings on the payment, replay, probe and signer paths are rewarded
at the operator's discretion, currently $100 to $500 by severity, paid in USDC.

## Supported versions

Fixes land on `main` and in the latest published package version. Older
release archives are not patched.

## Public client boundaries

- Buyer keys, funds and authorization remain under the buyer's control. The MCP stdio adapter does not sign or submit payments.
- Guarded authorization requires verification of the supported signed receipt, original request, exact seller offer and expiry against an independently pinned log key before the configured authorization callback runs.
- Untrusted seller metadata and tool output do not grant payment authority. The wallet must independently enforce transaction effects and buyer policy.
- A timeout, lost response or unknown settlement does not authorize another payment. Recovery must not silently create or resubmit an economic attempt.
- Historical receipt verification is separate from current permission to spend, payment confirmation, seller delivery and later Falcon anchoring. Pending anchoring is not confirmed anchoring.
- Private evidence and recovery credentials must not enter public log leaves, examples or reports. Public fixtures use synthetic data.

These boundaries describe intended behavior, not a certification of every external provider, merchant or wallet.
