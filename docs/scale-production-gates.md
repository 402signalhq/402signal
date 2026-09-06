# Scale migration: security, functionality and release gates

Status: opt-in replay backend candidate, NOT an activated production migration.
The runtime replay integration was prepared locally but its GitHub write was
blocked. This PR therefore leaves `live402/replay.py` unchanged. Neither the
PostgreSQL adapter nor the migration command may be activated in production yet.
The full application remains single-writer and its existing ledger limits remain.

## Preserved boundaries

No changes to price, `exact` settlement, Base/Solana/Algorand acceptance, normal
free misses, route binding, buyer wallet authority, SSRF/DNS controls, public
endpoints, MainNet identity, signer keys, anchor fee policy, or `fly.toml`.
The default Dockerfile and core dependency lock remain unchanged. PostgreSQL is
an optional dependency in a separate image. No cloud resources are provisioned.

## Step 1: persistence interface review

`ReplayStore` separates storage from payment parsing and HTTP outcome semantics.
The SQLite adapter commits a unique pending authorization before returning True.
Identity checks are inside the write transaction so a migration fence cannot race
admission. Private-response expiry never deletes an economic identity. Deletion
is reserved for the existing invalid-input 400 contract before any economic action.

Functional checks: reserve/read/finish/abandon, private-scope output, retained
unknown state, expiry, capacity refusal and four-process same-identity races.
Security checks: SQL parameters, lost commit acknowledgement, fenced source.
These tests are implementation self-review, not independent security sign-off.

## Step 2: PostgreSQL authority review

The adapter requires a 128-bit authority ID matching a pre-imported active
manifest. Runtime has no DDL, empty-database initialization, backend fallback,
lease expiry takeover, or automatic retry of uncertain writes. TLS verify-full
is mandatory outside explicitly local test mode; test bypass is forbidden on Fly.
Only the writable primary with fsync/full_page_writes and synchronous commit can
admit. Runtime credentials cannot activate/change authority identity or capacity.

The durable-primary check DOES NOT prove a provider's failover recovery point.
Before release, require evidence that acknowledged economic identities cannot
be lost through automatic failover or a stale restore. Otherwise fail closed and
reconcile before resuming paid admission. A periodic backup alone is not proof.

One connection and a serialized capacity counter are intentionally conservative.
This is not a 20M/day benchmark or a high-availability architecture. A shared
ledger alone does not coordinate the current local catalog/history/PQ writers.
`LIVE402_ROUTER_WRITERS=1` is an operator configuration check, not machine discovery.
Do not add replicas based on it.

Functional/security CI adds real PostgreSQL multiprocess duplicate races, retained
pending/unknown records, expired bodies, budget exhaustion, restricted SQL role,
commit-ack loss and staged migration crash cases. The ephemeral test database is
loopback-only `402signal_ci`; destructive tests refuse other host/database names.
No real sellers, provider credentials, payments or chain transactions are used.

## Step 3: migration review and mandatory sequencing

The migration tool is DRY-RUN by default. It checks source integrity and validates
all rows, retains pending/unknown and legacy identities, imports to an empty
inactive target, and compares sorted canonical row count + SHA-256 digest.
It commits the source fence BEFORE activating the destination. A crash leaves
one usable authority or neither, never intentionally both. Partial imports are
not overwritten or automatically retried.

IMPORTANT: the old production binary does not understand the new source fence.
Production use is BLOCKED until the separately reviewed replay integration is
available and deployed in SQLite mode first. Then prove every runnable/rollback
image is fence-aware, stop and drain all writers, let private response windows
expire, and create/verify an encrypted off-host recovery copy. Merely setting a
new environment variable, copying a live SQLite file, or selecting an empty
PostgreSQL database is not migration. Do not use the optional image to imply the
missing runtime integration has been applied.

Apply requires the authoritative `/data/live402-replay.sqlite`, a deliberate
writers-stopped assertion, admin DSN, and a fresh matching authority ID. Never
log DSNs, secrets, raw payments or private output. Create/grant the limited
runtime role separately from the migration role. The tool's digest is integrity
evidence; it is not proof of stopped writers or a tested disaster recovery plan.

After a source is fenced, there is NO automatic rollback to SQLite. Do not
remove the marker, wipe rows, rotate keys, restart an old pre-fence binary, or
restore a stale snapshot to clear an error. Reconcile uncertain target state with
operators first. Only a reviewed application rollback preserving the same shared
authority can resume. Retain the source backup and manifest for investigation.

## Step 4: actual all-services $100/month gate

`python -m scripts.infrastructure_budget <private-inventory.json>` checks verified
monthly maxima + at least $10 contingency <= $100. Unknown/stale bills, automatic
upgrades, missing categories or unbounded variable costs fail. The example
inventory deliberately FAILS and includes the separate signer and Tatum.

This checker is an operator-evidence validator, NOT a provider billing cap. It
cannot read accounts, disable upgrades, stop billing or guarantee invoices.
Production/provisioning is blocked until current Fly machines/volumes/snapshots,
separate signer(s), Tatum, optional NOWNodes, database, archive storage, monitoring,
network, domains/tax and staging totals are verified. Do not publish credentials
or private billing evidence in the public repository.

Tatum stays an independent Algorand confirmation source, not a per-route call.
Its public free allowance is 100K lifetime credits and 3 RPS, not an indefinitely
renewing monthly allowance. Its automatic-upgrade setting must be verified in the
actual account. Do not assume the account is free or its credits are unspent.
No paid database plan is selected by this PR. A low-usage provider estimate is
not a contractual cap, and free tiers are not production availability promises.

## Step 5: release and scope

Required before activation: exact-SHA 402security review, 402QA functional
sign-off, green default and PostgreSQL CI, optional-image build and dependency
audits, verified budget inventory, provider durability/connection limits,
staging migration and restore rehearsal, live deployed-SHA/image identification,
one-router verification, and the existing Ross production/MainNet GO procedure.

Required after approved cutover: /health and /ready, unchanged PQ identity/root
history, low-value controlled Base/Solana/Algorand winners, free misses, private
replay, duplicate submissions and V4 binding, plus monitoring of durable writes,
remaining admission/byte budget, latency and failure rate. Stop admission on any
unresolved payment-safety discrepancy. No real-money tests occur in this PR.

Still required for the full 20M/day target: bounded asynchronous worker serving,
shared catalog/history policy, ordered durable group-commit PQ writer with failover,
archival/retention implementation, commercial quotas, staged burst/load/failure
runs and a representative 24-hour throughput/latency/error-budget soak. None is
implied by the replay adapter tests. $100 buys the current small deployment, not
a proven 20M/day service. Payment fees remain variable COGS, not infrastructure.

## Primary technical references (checked 2026-09-06)

- https://www.psycopg.org/psycopg3/docs/basic/transactions.html
- https://www.postgresql.org/docs/current/sql-insert.html
- https://www.postgresql.org/docs/current/sql-select.html
- https://pypi.org/project/psycopg/3.3.5/
- https://pypi.org/project/psycopg-binary/3.3.5/
- https://tatum.io/pricing
