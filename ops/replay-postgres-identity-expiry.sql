-- Replay identity expiry for the managed functions-v1 authority.
-- Install as the migration owner AFTER ops/replay-postgres-functions.sql.
-- Writers may keep running: the column is nullable and the existing functions
-- are unchanged. The router uses the new functions only once they exist.
--
-- An identity is dropped only when its row is terminal (settled, not_settled,
-- rejected), carries a known authorization expiry, and that expiry is more
-- than one hour in the past by the database clock. After expiry the chain
-- itself refuses settlement, so dropping the identity cannot enable a second
-- charge. Rows without a known expiry are never dropped.
BEGIN;

ALTER TABLE signal_replay.entries
    ADD COLUMN IF NOT EXISTS authorization_expires_at DOUBLE PRECISION
    CHECK (authorization_expires_at IS NULL OR
           (authorization_expires_at >= 0 AND authorization_expires_at < 'Infinity'::float8));

CREATE INDEX IF NOT EXISTS replay_expirable_identities
    ON signal_replay.entries(authorization_expires_at)
    WHERE authorization_expires_at IS NOT NULL AND state IN ('settled','not_settled','rejected');

CREATE OR REPLACE FUNCTION signal_replay.api_reserve_v2(
    requested_authority TEXT, fingerprint TEXT, private_scope TEXT, expiry DOUBLE PRECISION,
    authorization_expiry DOUBLE PRECISION)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE inserted TEXT;
BEGIN
    IF authorization_expiry IS NOT NULL AND NOT
       (authorization_expiry >= 0 AND authorization_expiry < 'Infinity'::float8) THEN
        RAISE EXCEPTION 'invalid replay operation';
    END IF;
    PERFORM * FROM signal_replay.api_authority(requested_authority,TRUE,TRUE);
    INSERT INTO signal_replay.entries
      (fp_hash,state,outcome_json,created_at,fingerprint_version,scope_hash,expires_at,authorization_expires_at)
      VALUES(fingerprint,'settlement_pending',NULL,extract(epoch FROM pg_catalog.clock_timestamp()),2,
             private_scope,expiry,authorization_expiry)
      ON CONFLICT(fp_hash) DO NOTHING RETURNING fp_hash INTO inserted;
    IF inserted IS NOT NULL THEN
        UPDATE signal_replay.authority SET admitted=admitted+1 WHERE singleton;
        RETURN TRUE;
    END IF;
    RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION signal_replay.api_expire_identities(requested_authority TEXT, batch INTEGER)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE removed_rows BIGINT; removed_bytes BIGINT;
BEGIN
    IF batch IS NULL OR batch < 1 OR batch > 10000 THEN
        RAISE EXCEPTION 'invalid replay operation';
    END IF;
    PERFORM * FROM signal_replay.api_authority(requested_authority,FALSE,TRUE);
    WITH doomed AS (
        SELECT fp_hash, coalesce(octet_length(outcome_json),0) AS bytes
        FROM signal_replay.entries
        WHERE state IN ('settled','not_settled','rejected')
          AND authorization_expires_at IS NOT NULL
          AND authorization_expires_at + 3600 < extract(epoch FROM pg_catalog.clock_timestamp())
        ORDER BY authorization_expires_at
        LIMIT batch
        FOR UPDATE SKIP LOCKED),
    deleted AS (
        DELETE FROM signal_replay.entries e USING doomed d
        WHERE e.fp_hash = d.fp_hash
        RETURNING d.bytes)
    SELECT count(*), coalesce(sum(bytes),0) INTO removed_rows, removed_bytes FROM deleted;
    IF removed_rows > 0 THEN
        UPDATE signal_replay.authority
        SET admitted=admitted-removed_rows, outcome_bytes=outcome_bytes-removed_bytes
        WHERE singleton;
    END IF;
    RETURN removed_rows;
END;
$$;

COMMIT;
