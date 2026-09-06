-- Apply only with the migration/admin role. Runtime never executes DDL.
CREATE SCHEMA IF NOT EXISTS signal_replay;
REVOKE ALL ON SCHEMA signal_replay FROM PUBLIC;
CREATE TABLE IF NOT EXISTS signal_replay.authority (
    singleton BOOLEAN PRIMARY KEY CHECK (singleton),
    authority_id TEXT NOT NULL CHECK (authority_id ~ '^[0-9a-f]{32}$'),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    active BOOLEAN NOT NULL DEFAULT FALSE,
    legacy_ready BOOLEAN NOT NULL DEFAULT FALSE,
    admitted BIGINT NOT NULL CHECK (admitted >= 0),
    max_rows BIGINT NOT NULL CHECK (max_rows > 0 AND admitted <= max_rows),
    max_bytes BIGINT NOT NULL CHECK (max_bytes >= 1048576),
    migration_digest TEXT NOT NULL CHECK (migration_digest ~ '^[0-9a-f]{64}$')
);
CREATE TABLE IF NOT EXISTS signal_replay.entries (
    fp_hash TEXT PRIMARY KEY CHECK (fp_hash ~ '^[0-9a-f]{64}$'),
    state TEXT NOT NULL CHECK (state IN ('settlement_pending','unknown','settled','not_settled','rejected')),
    outcome_json TEXT CHECK (octet_length(outcome_json) <= 262144),
    created_at DOUBLE PRECISION NOT NULL CHECK (created_at >= 0 AND created_at < 'Infinity'::float8),
    fingerprint_version INTEGER NOT NULL CHECK (fingerprint_version IN (1,2)),
    scope_hash TEXT CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
    expires_at DOUBLE PRECISION CHECK (expires_at >= 0 AND expires_at < 'Infinity'::float8),
    CHECK (scope_hash IS NOT NULL OR outcome_json IS NULL)
);
CREATE INDEX IF NOT EXISTS replay_expiring_outcomes
    ON signal_replay.entries(expires_at) WHERE outcome_json IS NOT NULL;
REVOKE ALL ON ALL TABLES IN SCHEMA signal_replay FROM PUBLIC;
-- Create a separate runtime role out of band. Grant only:
-- GRANT USAGE ON SCHEMA signal_replay TO <runtime_role>;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON signal_replay.entries TO <runtime_role>;
-- GRANT SELECT ON signal_replay.authority TO <runtime_role>;
-- GRANT UPDATE (admitted) ON signal_replay.authority TO <runtime_role>;
-- No ownership, DDL, TRUNCATE, or authority activation/identity/cap changes.
-- DELETE is solely for an invalid-input 400 before any economic action;
-- no retention/TTL job deletes economic identities.
