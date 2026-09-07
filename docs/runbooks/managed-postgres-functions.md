# Managed PostgreSQL replay functions

This opt-in API supports a managed service that provides a Reader login but
does not permit custom grants. It does not enable additional router or PQ log
writers. Select `LIVE402_REPLAY_POSTGRES_API=functions-v1` with the existing
PostgreSQL backend, verified TLS DSN and matching authority ID.

The migration owner installs `ops/replay-postgres-functions.sql`. It owns the
tables and functions; the application uses a different non-owner Reader login.
Set `LIVE402_REPLAY_POSTGRES_RUNTIME_LOGIN` to that exact login during migration.
The ordinary direct-grant backend and default SQLite image remain unchanged.

All mutations use schema-qualified owner functions with a fixed `pg_catalog`
search path. Every entry point checks the authenticated `session_user`, matching
active authority, primary durability flags and stored instance identity. Default
PUBLIC execute permission does not authorize another authenticated login. The
Reader cannot directly change activation, authority identity, row/byte capacity,
runtime policy, schema or retained identities. Broadened authority/policy grants
and membership of their owner role make readiness fail closed.

Migration pins both PostgreSQL's postmaster start time and server address in a
separate owner-controlled policy row. A database restart, promotion onto another
server, or a stale restore must stop paid admission. Application restart and
connection recycling never refresh this policy. This trades automatic recovery
for safety when the provider has not established zero acknowledged-write loss.
It is not a claim of automatic high availability or a provider failover guarantee.

After a database-instance change, keep admission disabled. Preserve the source,
destination, recovery bundle and all uncertain operations. Establish continuity
of every acknowledged economic identity and reconcile outstanding settlements
before an operator may deliberately update the policy. Never repin merely because
the new primary answers queries, and never restore an unfenced SQLite authority.
If continuity cannot be established, remain unavailable; a stale backup alone is
insufficient. Restoring/restarting an old binary cannot clear this database fence.

Use the existing SQLite-first, one-writer drain, source-fence-before-activation
migration procedure. The new migration installs the policy only into a fresh
target and verifies the same instance before activation. A retry never overwrites
or repins an existing policy. Preserve exact row/digest and recovery evidence.

Qualification must include restricted-login lifecycle/duplicate tests, actual
provider TLS and permissions, instance-change rejection, migration interruption,
and representative replay-throughput measurements. Storage throughput alone does
not prove end-to-end MainNet throughput or horizontal catalog/history/PQ safety.
Keep explicit capacity budgets; retained economic identities are not TTL data.
