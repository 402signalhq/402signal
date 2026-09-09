# Work admission operations

The admission policy is a private, operator-controlled file. Keep production limits, customer key digests and customer identities outside this repository. Customer keys grant a workload class, not wallet authority or access to another customer's results. All backends in this release support one router process only.

## Policy versions

Version 1 remains supported. Version 2 retains its required fields and adds:

- `anonymous_totals`: positive `ingress` and `unpaid` aggregate allowances, each strictly below its corresponding global allowance. The existing `anonymous` fields remain per-peer limits. Unknown or duplicated customer-key headers remain anonymous.
- `recovery`: positive `global`, `anonymous_total`, `anonymous` and `customer` allowances; anonymous aggregate must be below the global recovery allowance. Recovery uses a separate bounded bucket map and consumes no ordinary work allowance.

Each group refills over `window_seconds`. The global work ceiling still applies to recognized customers. Anonymous aggregate limits preserve headroom; they do not promise CPU, worker, target-probe, storage or end-to-end availability. Target failure limits remain shared and a paid customer cannot bypass them. Do not advertise these quotas as an SLA or horizontal scaling support.

Version 2 preallocates and retains known-customer/global ingress and unpaid counters, preventing anonymous identity-map churn from displacing them. Recovery similarly retains its known-customer/global counters. Unpaid discovery uses a third independent map so preview/validate, unpaid GET /route challenge, and MCP handshake identity churn cannot occupy paid ingress, unpaid-work, or paid target-probe slots. The image-only anonymous discovery default leaves headroom so a cold MCP setup on one identity can still run the unpaid preview and validate tools. Each map is bounded by `max_keys`; combined resident counters stay within three times that bound. Confirmed routing settlement restores only its unpaid-work lease once; it does not refund ingress or probe work. Recovery never creates a new economic work lease or payment authority.

## Startup, changes and revocation

Configured engines start empty and refill from elapsed uptime. Restarting does not create a full burst, and may conservatively discard earned allowance. The first unit in a bucket requires at least `window_seconds / capacity` of uptime. A request needs all relevant allowances. A green readiness flag does not establish positive capacity and also passes with no policy configured; verify the active path/hash and release privately.

The loader caches by configured absolute path. Editing or replacing a file at the same path does not reload it or revoke a customer key. Use a new versioned policy path and a controlled process restart. Invalid replacement policy fails closed; it does not retain a previously loaded customer list as a fallback. Removing a customer digest revokes its privileged workload class; the public API may still serve that caller under anonymous limits. It does not revoke a wallet authorization, erase private replay evidence or cancel a payment.

1. Retain the previous private policy/configuration; validate the replacement schema and the intended removed/retained key digests. Use bounded files with mode0600, authorized owner and no symlink.
2. Stage a new immutable filename. Confirm one router and adequate resource ceilings; do not expose policy contents in logs.
3. For routine changes, drain existing requests, set the new path, restart, verify its identity and allow controlled warm-up before restoring traffic. For urgent revocation, stop new admission first. Already-running work may finish; revocation is not authority to cancel or repeat an uncertain payment.
4. Verify removed and retained controlled credentials, recovery behavior, readiness and aggregate counters. Never roll back to a revoked key merely to restore capacity. Keep PostgreSQL authority and the SQLite source fence intact.

Tests cover same-path non-reload, versioned revocation, invalid replacement, conservative restart, anonymous exhaustion, identity-map churn and independent recovery budgets. No customer management dashboard or automatic reload is introduced.

## Retry behavior

An outer429 may concern a repeat request whose previous attempt already settled. Never infer nonpayment from that response. Use the explicit recovery-only contract and retain the original request, authorization and private replay credential. A capacity response after durable admission may itself be the recorded outcome. Backoff does not authorize a fresh nonce, payment or seller request. Recovery is bounded and time-limited; no guarantee extends the private outcome-retention window.
