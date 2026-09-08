# Transparency publication and repair

The current transparency store has one process writer. Its SQLite lock and durable transactions are part of the receipt contract; adding HTTP workers does not create independent log writers.

## Append and checkpoint ordering

1. Commit the leaf, its Merkle state, and tree size with the existing durable SQLite settings.
2. Publish the changed entry-bundle and hash-tile tails in a separate committed transaction.
3. Check that every object required by the requested checkpoint exists before signing it.

Normal append updates at most one entry-bundle tail and the affected tile at each level. It uses the existing range-hash cache and retains the same independently verifiable roots, tile bytes, entry-bundle bytes, and historical object URLs. It does not replace the log with a trusted in-memory frontier. Presence checks still examine indexed ranges; they are not constant-cost at arbitrary log sizes.

If required publication objects are missing, append falls back to full reconstruction. Reopening a store with missing publication objects also repairs them. A crash after leaf commit cannot turn an unpublished leaf into a signed checkpoint: receipt issuance retains a separate readiness check. Repeated event submission retains the original leaf identity.

## Full reconstruction remains available

`live402.pq.store.publish_up_to(tree_size)` reconstructs the derived publication objects for that size from retained leaves. Existing identical objects are left untouched; missing or corrupt derived objects are repaired. This is the explicit full-repair path, rather than a historical audit on every paid request.

A normal append checks object presence and updates its affected tails. It does **not** re-audit all historical object contents. A present but corrupt older object therefore requires full repair; its presence alone is not a content-integrity attestation. Startup repair is triggered by missing required objects, not by a full historical corruption scan. Full reconstruction does not authorize changing a committed checkpoint root or discarding economic replay identities.

Operators should cordon and drain the writer, preserve the existing backup scope and public verification-key pin, and use an isolated copy to verify suspected corruption before deliberate repair. Follow the existing recovery and replay-authority procedures; do not open the same SQLite log from multiple writer processes.

## Scaling boundary

This optimization reduces repeated publication work. It does not provide multiwriter support, remove retained-object growth, increase admission limits, or change payment, replay, settlement, checkpoint, or recovery semantics. Production capacity still depends on provider latency, durable storage, workload mix, admission policy, and log size. A shared-store and ordered-publication design must be qualified before deploying multiple writers.
