-- Re-apply on a database that already carries ops/replay-postgres-hotpath.sql:
-- signal_replay.api_admit_shard becomes SECURITY INVOKER.
--
-- Why: the hot-path migration created this internal helper as SECURITY DEFINER
-- with the default PUBLIC EXECUTE and no caller check. Any login with USAGE on
-- the schema could call it directly and increment a shard's admitted counter
-- without inserting a replay identity, which the fence then reports as
-- "replay counters inconsistent" and refuses to re-pin (security review
-- 2026-09-14, finding 2). As SECURITY INVOKER the helper still works inside the
-- SECURITY DEFINER reserve functions (they run as the owner) and fails with
-- "permission denied" for everyone else, because no reader has UPDATE on
-- signal_replay.authority_shard.
--
-- Safe while writers run: one CREATE OR REPLACE, same signature, same body.
-- Idempotent. Run as the migration owner (fly-user); the runtime login is
-- unaffected. Dry run: replace the final COMMIT with ROLLBACK.
BEGIN;

CREATE OR REPLACE FUNCTION signal_replay.api_admit_shard(fingerprint TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
    -- Exact per-shard enforcement under the shard's own row lock.
    UPDATE signal_replay.authority_shard s SET admitted = s.admitted + 1
     WHERE s.shard = signal_replay.shard_of(fingerprint)
       AND s.admitted < s.max_rows
       AND (s.admitted+1)*512 + s.outcome_bytes <= s.max_bytes;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'replay authority capacity exhausted';
    END IF;
END;
$$;

COMMIT;
