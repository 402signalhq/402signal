-- Existing authorities: run replay-postgres-accounting-upgrade.sql with writers stopped first.
CREATE SCHEMA IF NOT EXISTS signal_replay;
CREATE TABLE IF NOT EXISTS signal_replay.authority (
    singleton BOOLEAN PRIMARY KEY CHECK (singleton),
    authority_id TEXT NOT NULL CHECK (authority_id ~ '^[0-9a-f]{32}$'),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    active BOOLEAN NOT NULL DEFAULT FALSE,
    legacy_ready BOOLEAN NOT NULL DEFAULT FALSE,
    admitted BIGINT NOT NULL CHECK (admitted >= 0),
    max_rows BIGINT NOT NULL CHECK (max_rows > 0 AND admitted <= max_rows),
    max_bytes BIGINT NOT NULL CHECK (max_bytes >= 1048576),
    migration_digest TEXT NOT NULL CHECK (migration_digest ~ '^[0-9a-f]{64}$'),
    outcome_bytes BIGINT NOT NULL DEFAULT 0 CHECK (outcome_bytes >= 0),
    CONSTRAINT replay_logical_byte_quota CHECK (admitted * 512 + outcome_bytes <= max_bytes)
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

-- Install with the migration owner in a dedicated database. Managed providers
-- may forbid GRANT/REVOKE. The runtime remains a non-owner Reader login; it has
-- no direct DML. Function EXECUTE can retain its default PUBLIC ACL because
-- every entry point checks the separately stored, exact authenticated login.
CREATE TABLE IF NOT EXISTS signal_replay.runtime_policy (
    singleton BOOLEAN PRIMARY KEY CHECK(singleton),
    authority_id TEXT NOT NULL CHECK(authority_id ~ '^[0-9a-f]{32}$'),
    runtime_login TEXT NOT NULL CHECK(runtime_login ~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$'),
    instance_start_us BIGINT NOT NULL CHECK(instance_start_us > 0),
    instance_server_addr INET NOT NULL
);

CREATE OR REPLACE FUNCTION signal_replay.api_authority(
    requested_authority TEXT, capacity BOOLEAN, exclusive_lock BOOLEAN)
RETURNS SETOF signal_replay.authority
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p signal_replay.runtime_policy%ROWTYPE;
        a signal_replay.authority%ROWTYPE;
BEGIN
    SELECT * INTO STRICT p FROM signal_replay.runtime_policy WHERE singleton FOR SHARE;
    IF session_user::text IS DISTINCT FROM p.runtime_login
       OR requested_authority IS DISTINCT FROM p.authority_id
       OR (extract(epoch FROM pg_catalog.pg_postmaster_start_time())*1000000)::bigint
          IS DISTINCT FROM p.instance_start_us
       OR pg_catalog.inet_server_addr() IS DISTINCT FROM p.instance_server_addr
       OR pg_catalog.pg_is_in_recovery()
       OR pg_catalog.current_setting('fsync') <> 'on'
       OR pg_catalog.current_setting('full_page_writes') <> 'on'
       OR pg_catalog.current_setting('synchronous_commit') <> 'on' THEN
        RAISE EXCEPTION 'replay authority unavailable';
    END IF;
    -- Fail closed if a runtime login is accidentally broadened later. Check
    -- login membership too: NOINHERIT must not hide permission to SET ROLE owner.
    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN pg_catalog.pg_roles r
        WHERE c.oid IN ('signal_replay.authority'::regclass,
                        'signal_replay.runtime_policy'::regclass,'signal_replay.entries'::regclass)
          AND (r.rolname=session_user OR pg_catalog.pg_has_role(session_user,r.oid,'MEMBER'))
          AND (pg_catalog.has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
               OR pg_catalog.has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE')
               OR r.oid=c.relowner
               OR pg_catalog.has_schema_privilege(r.oid,c.relnamespace,'CREATE')))
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                  WHERE t.tgrelid IN ('signal_replay.authority'::regclass,
                    'signal_replay.runtime_policy'::regclass,'signal_replay.entries'::regclass)
                    AND NOT t.tgisinternal) THEN
        RAISE EXCEPTION 'replay authority unavailable';
    END IF;
    IF capacity IS NULL OR exclusive_lock IS NULL THEN
        RAISE EXCEPTION 'invalid replay operation';
    END IF;
    IF capacity OR exclusive_lock THEN
        SELECT * INTO STRICT a FROM signal_replay.authority WHERE singleton FOR UPDATE;
    ELSE
        SELECT * INTO STRICT a FROM signal_replay.authority WHERE singleton FOR SHARE;
    END IF;
    IF a.authority_id IS DISTINCT FROM requested_authority OR a.schema_version <> 1
       OR NOT a.active OR NOT a.legacy_ready THEN
        RAISE EXCEPTION 'replay authority unavailable';
    END IF;
    IF capacity AND (a.admitted >= a.max_rows OR
       (a.admitted+1)*512+a.outcome_bytes > a.max_bytes) THEN
        RAISE EXCEPTION 'replay authority capacity exhausted';
    END IF;
    RETURN NEXT a;
END;
$$;

CREATE OR REPLACE FUNCTION signal_replay.api_reserve(
    requested_authority TEXT, fingerprint TEXT, private_scope TEXT, expiry DOUBLE PRECISION)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE inserted TEXT;
BEGIN
    PERFORM * FROM signal_replay.api_authority(requested_authority,TRUE,TRUE);
    INSERT INTO signal_replay.entries
      (fp_hash,state,outcome_json,created_at,fingerprint_version,scope_hash,expires_at)
      VALUES(fingerprint,'settlement_pending',NULL,extract(epoch FROM pg_catalog.clock_timestamp()),2,private_scope,expiry)
      ON CONFLICT(fp_hash) DO NOTHING RETURNING fp_hash INTO inserted;
    IF inserted IS NOT NULL THEN
        UPDATE signal_replay.authority SET admitted=admitted+1 WHERE singleton;
        RETURN TRUE;
    END IF;
    RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION signal_replay.api_finish(
    requested_authority TEXT, fingerprint TEXT, final_state TEXT, outcome TEXT, keep_identity BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a signal_replay.authority%ROWTYPE;
        prior BIGINT; wanted TEXT; wanted_bytes BIGINT;
BEGIN
    IF keep_identity IS NULL OR final_state IS NULL OR final_state NOT IN
      ('settlement_pending','unknown','settled','not_settled','rejected') THEN
        RAISE EXCEPTION 'invalid replay state';
    END IF;
    SELECT * INTO STRICT a FROM signal_replay.api_authority(requested_authority,FALSE,TRUE);
    SELECT coalesce(octet_length(outcome_json),0),
           CASE WHEN keep_identity AND scope_hash IS NOT NULL AND expires_at >
             extract(epoch FROM pg_catalog.clock_timestamp()) THEN outcome ELSE NULL END
      INTO STRICT prior,wanted FROM signal_replay.entries
      WHERE fp_hash=fingerprint AND state IN ('settlement_pending','unknown') FOR UPDATE;
    wanted_bytes:=coalesce(octet_length(wanted),0);
    IF wanted_bytes>262144 THEN RAISE EXCEPTION 'invalid replay outcome'; END IF;
    -- Cache availability never weakens economic identity or rejects completion.
    IF a.admitted*512+a.outcome_bytes-prior+wanted_bytes>a.max_bytes THEN
        wanted:=NULL; wanted_bytes:=0;
    END IF;
    UPDATE signal_replay.entries SET state=final_state,outcome_json=wanted WHERE fp_hash=fingerprint;
    UPDATE signal_replay.authority SET outcome_bytes=outcome_bytes-prior+wanted_bytes WHERE singleton;
END;
$$;

CREATE OR REPLACE FUNCTION signal_replay.api_abandon(requested_authority TEXT, fingerprint TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    PERFORM * FROM signal_replay.api_authority(requested_authority,FALSE,FALSE);
    UPDATE signal_replay.entries SET state='unknown'
      WHERE fp_hash=fingerprint AND state IN ('settlement_pending','unknown');
END;
$$;

CREATE OR REPLACE FUNCTION signal_replay.api_prune(requested_authority TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE removed BIGINT;
BEGIN
    PERFORM * FROM signal_replay.api_authority(requested_authority,FALSE,TRUE);
    WITH expired AS (SELECT fp_hash,octet_length(outcome_json) AS bytes
      FROM signal_replay.entries WHERE outcome_json IS NOT NULL
      AND (expires_at IS NULL OR expires_at <= extract(epoch FROM pg_catalog.clock_timestamp()))
      ORDER BY expires_at NULLS FIRST LIMIT 1000 FOR UPDATE SKIP LOCKED),
    cleared AS (UPDATE signal_replay.entries e SET outcome_json=NULL FROM expired x
                WHERE e.fp_hash=x.fp_hash RETURNING e.fp_hash)
    SELECT coalesce(sum(x.bytes),0) INTO removed FROM expired x JOIN cleared c USING(fp_hash);
    UPDATE signal_replay.authority SET outcome_bytes=outcome_bytes-removed WHERE singleton;
END;
$$;

CREATE OR REPLACE FUNCTION signal_replay.api_ready(requested_authority TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    PERFORM * FROM signal_replay.api_authority(requested_authority,TRUE,TRUE);
    UPDATE signal_replay.authority SET admitted=admitted WHERE singleton;
END;
$$;
