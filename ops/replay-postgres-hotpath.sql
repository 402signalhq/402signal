-- Replay hot path for the managed functions-v1 authority: sharded counters.
--
-- Before this migration every paid admission took the single
-- signal_replay.authority row FOR UPDATE twice (reserve, then finish) and held
-- it until commit, so writers serialized across every router process
-- (docs/replay-throughput-benchmark.md: 100 to 120 admissions per second).
--
-- After it, identity uniqueness still comes from the entries primary key and
-- every entry point still checks the runtime login, the instance fence, the
-- authority id, activation and the role drift guard. Only the counters move:
-- signal_replay.authority_shard holds 16 rows keyed by the first hex byte of
-- the fingerprint, each with its own share of max_rows and max_bytes. A
-- reservation locks one shard row for the duration of its commit; the other 15
-- shards keep admitting. Capacity is still enforced exactly, per shard: the
-- shard quotas sum to the authority quotas, so the total can never exceed
-- max_rows or the logical byte budget. Exhaustion is reached when the busiest
-- shard fills, which for a uniform hash is within a fraction of a percent of
-- the total.
--
-- The authority row's admitted and outcome_bytes columns are frozen at the
-- values they had when this migration ran; signal_replay.api_capacity and
-- fence_status report the live totals from the shards. Lock order in every
-- function is: runtime_policy (share), authority (share), entries, then shard
-- rows in ascending shard order, so no two entry points can deadlock.
--
-- Install as the migration owner AFTER ops/replay-postgres-functions.sql,
-- ops/replay-postgres-identity-expiry.sql and ops/replay-postgres-fence.sql,
-- with every router writer stopped. Explicit operator assertion required in
-- this session:
--   SET live402.upgrade_writers_stopped = '1';
-- The migration reconciles counters against the entries table first and
-- refuses to run when they disagree. It replaces function bodies only; no
-- row, response, authority setting or database-instance pin is changed.
BEGIN;
SET LOCAL synchronous_commit = 'on';
SET LOCAL lock_timeout = '5000ms';
SET LOCAL statement_timeout = '120000ms';

DO $$ BEGIN
    IF current_setting('live402.upgrade_writers_stopped', true) IS DISTINCT FROM '1' THEN
        RAISE EXCEPTION 'stop all replay writers before the hot-path migration';
    END IF;
    IF pg_catalog.to_regprocedure('signal_replay.api_reserve_v2(text,text,text,double precision,double precision)') IS NULL
       OR pg_catalog.to_regprocedure('signal_replay.api_expire_identities(text,integer)') IS NULL THEN
        RAISE EXCEPTION 'install ops/replay-postgres-identity-expiry.sql first';
    END IF;
    IF pg_catalog.to_regprocedure('signal_replay.fence_status(pg_lsn,bigint)') IS NULL THEN
        RAISE EXCEPTION 'install ops/replay-postgres-fence.sql first';
    END IF;
END $$;

LOCK TABLE signal_replay.authority, signal_replay.entries IN ACCESS EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS signal_replay.authority_shard (
    shard SMALLINT PRIMARY KEY CHECK (shard BETWEEN 0 AND 15),
    admitted BIGINT NOT NULL DEFAULT 0 CHECK (admitted >= 0),
    outcome_bytes BIGINT NOT NULL DEFAULT 0 CHECK (outcome_bytes >= 0),
    max_rows BIGINT NOT NULL CHECK (max_rows >= 0),
    max_bytes BIGINT NOT NULL CHECK (max_bytes >= 0),
    CONSTRAINT replay_shard_row_quota CHECK (admitted <= max_rows),
    CONSTRAINT replay_shard_byte_quota CHECK (admitted * 512 + outcome_bytes <= max_bytes)
);

CREATE OR REPLACE FUNCTION signal_replay.shard_of(fingerprint TEXT)
RETURNS SMALLINT LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path=pg_catalog AS $$
    SELECT (('x' || pg_catalog.substr(fingerprint, 1, 2))::bit(8)::int % 16)::smallint
$$;

-- Populate the shards once, from the entries table, and check the frozen
-- authority counters agree with it. A second run leaves existing shards alone.
DO $$
DECLARE a signal_replay.authority%ROWTYPE;
        shard_rows BIGINT; shard_bytes BIGINT; k INTEGER;
        rows_each BIGINT; rows_extra BIGINT; bytes_each BIGINT; bytes_extra BIGINT;
BEGIN
    IF (SELECT count(*) FROM signal_replay.authority_shard) = 16 THEN
        RETURN;
    END IF;
    IF (SELECT count(*) FROM signal_replay.authority_shard) <> 0 THEN
        RAISE EXCEPTION 'partial shard table; reconcile before the hot-path migration';
    END IF;
    SELECT * INTO STRICT a FROM signal_replay.authority WHERE singleton FOR UPDATE;
    SELECT count(*), coalesce(sum(octet_length(outcome_json)), 0)
      INTO shard_rows, shard_bytes FROM signal_replay.entries;
    IF a.admitted <> shard_rows OR a.outcome_bytes <> shard_bytes THEN
        RAISE EXCEPTION 'reconcile replay counters before the hot-path migration (admitted % vs % rows, bytes % vs %)',
            a.admitted, shard_rows, a.outcome_bytes, shard_bytes;
    END IF;
    rows_each := a.max_rows / 16; rows_extra := a.max_rows % 16;
    bytes_each := a.max_bytes / 16; bytes_extra := a.max_bytes % 16;
    FOR k IN 0..15 LOOP
        INSERT INTO signal_replay.authority_shard (shard, admitted, outcome_bytes, max_rows, max_bytes)
        SELECT k,
               count(*),
               coalesce(sum(octet_length(e.outcome_json)), 0),
               rows_each + CASE WHEN k < rows_extra THEN 1 ELSE 0 END,
               bytes_each + CASE WHEN k < bytes_extra THEN 1 ELSE 0 END
          FROM signal_replay.entries e
         WHERE signal_replay.shard_of(e.fp_hash) = k;
    END LOOP;
    -- The table constraints raise if any shard already exceeds its share.
END $$;

-- Shared entry-point guard. capacity=TRUE now means "some shard still has room"
-- (a snapshot read for readiness); the exact check happens on the shard row
-- inside api_reserve. exclusive_lock is accepted for signature compatibility
-- and no longer takes the authority row FOR UPDATE: nothing in the hot path
-- writes that row any more.
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
    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN pg_catalog.pg_roles r
        WHERE c.oid IN ('signal_replay.authority'::regclass,
                        'signal_replay.runtime_policy'::regclass,'signal_replay.entries'::regclass,
                        'signal_replay.authority_shard'::regclass)
          AND (r.rolname=session_user OR pg_catalog.pg_has_role(session_user,r.oid,'MEMBER'))
          AND (pg_catalog.has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
               OR pg_catalog.has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE')
               OR r.oid=c.relowner
               OR pg_catalog.has_schema_privilege(r.oid,c.relnamespace,'CREATE')))
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                  WHERE t.tgrelid IN ('signal_replay.authority'::regclass,
                    'signal_replay.runtime_policy'::regclass,'signal_replay.entries'::regclass,
                    'signal_replay.authority_shard'::regclass)
                    AND NOT t.tgisinternal) THEN
        RAISE EXCEPTION 'replay authority unavailable';
    END IF;
    IF capacity IS NULL OR exclusive_lock IS NULL THEN
        RAISE EXCEPTION 'invalid replay operation';
    END IF;
    SELECT * INTO STRICT a FROM signal_replay.authority WHERE singleton FOR SHARE;
    IF a.authority_id IS DISTINCT FROM requested_authority OR a.schema_version <> 1
       OR NOT a.active OR NOT a.legacy_ready THEN
        RAISE EXCEPTION 'replay authority unavailable';
    END IF;
    IF (SELECT count(*) FROM signal_replay.authority_shard) <> 16 THEN
        RAISE EXCEPTION 'replay authority unavailable';
    END IF;
    IF capacity AND NOT EXISTS (
        SELECT 1 FROM signal_replay.authority_shard s
        WHERE s.admitted < s.max_rows AND (s.admitted+1)*512 + s.outcome_bytes <= s.max_bytes) THEN
        RAISE EXCEPTION 'replay authority capacity exhausted';
    END IF;
    RETURN NEXT a;
END;
$$;

-- Live totals for operator alerts and the fence: the sum over the shards.
CREATE OR REPLACE FUNCTION signal_replay.api_capacity(requested_authority TEXT)
RETURNS TABLE (admitted BIGINT, max_rows BIGINT, max_bytes BIGINT, outcome_bytes BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    PERFORM * FROM signal_replay.api_authority(requested_authority, FALSE, FALSE);
    RETURN QUERY SELECT sum(s.admitted)::bigint, sum(s.max_rows)::bigint,
                        sum(s.max_bytes)::bigint, sum(s.outcome_bytes)::bigint
                   FROM signal_replay.authority_shard s;
END;
$$;

CREATE OR REPLACE FUNCTION signal_replay.api_admit_shard(fingerprint TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
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

CREATE OR REPLACE FUNCTION signal_replay.api_reserve(
    requested_authority TEXT, fingerprint TEXT, private_scope TEXT, expiry DOUBLE PRECISION)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE inserted TEXT;
BEGIN
    PERFORM * FROM signal_replay.api_authority(requested_authority,FALSE,FALSE);
    INSERT INTO signal_replay.entries
      (fp_hash,state,outcome_json,created_at,fingerprint_version,scope_hash,expires_at)
      VALUES(fingerprint,'settlement_pending',NULL,extract(epoch FROM pg_catalog.clock_timestamp()),2,private_scope,expiry)
      ON CONFLICT(fp_hash) DO NOTHING RETURNING fp_hash INTO inserted;
    IF inserted IS NOT NULL THEN
        PERFORM signal_replay.api_admit_shard(fingerprint);
        RETURN TRUE;
    END IF;
    RETURN FALSE;
END;
$$;

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
    PERFORM * FROM signal_replay.api_authority(requested_authority,FALSE,FALSE);
    INSERT INTO signal_replay.entries
      (fp_hash,state,outcome_json,created_at,fingerprint_version,scope_hash,expires_at,authorization_expires_at)
      VALUES(fingerprint,'settlement_pending',NULL,extract(epoch FROM pg_catalog.clock_timestamp()),2,
             private_scope,expiry,authorization_expiry)
      ON CONFLICT(fp_hash) DO NOTHING RETURNING fp_hash INTO inserted;
    IF inserted IS NOT NULL THEN
        PERFORM signal_replay.api_admit_shard(fingerprint);
        RETURN TRUE;
    END IF;
    RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION signal_replay.api_finish(
    requested_authority TEXT, fingerprint TEXT, final_state TEXT, outcome TEXT, keep_identity BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s signal_replay.authority_shard%ROWTYPE;
        prior BIGINT; wanted TEXT; wanted_bytes BIGINT;
BEGIN
    IF keep_identity IS NULL OR final_state IS NULL OR final_state NOT IN
      ('settlement_pending','unknown','settled','not_settled','rejected') THEN
        RAISE EXCEPTION 'invalid replay state';
    END IF;
    PERFORM * FROM signal_replay.api_authority(requested_authority,FALSE,FALSE);
    -- Entry first, then its shard (the same order prune and expiry use).
    SELECT coalesce(octet_length(outcome_json),0),
           CASE WHEN keep_identity AND scope_hash IS NOT NULL AND expires_at >
             extract(epoch FROM pg_catalog.clock_timestamp()) THEN outcome ELSE NULL END
      INTO STRICT prior,wanted FROM signal_replay.entries
      WHERE fp_hash=fingerprint AND state IN ('settlement_pending','unknown') FOR UPDATE;
    wanted_bytes:=coalesce(octet_length(wanted),0);
    IF wanted_bytes>262144 THEN RAISE EXCEPTION 'invalid replay outcome'; END IF;
    SELECT * INTO STRICT s FROM signal_replay.authority_shard
      WHERE shard = signal_replay.shard_of(fingerprint) FOR UPDATE;
    -- Cache availability never weakens economic identity or rejects completion.
    IF s.admitted*512+s.outcome_bytes-prior+wanted_bytes>s.max_bytes THEN
        wanted:=NULL; wanted_bytes:=0;
    END IF;
    UPDATE signal_replay.entries SET state=final_state,outcome_json=wanted WHERE fp_hash=fingerprint;
    UPDATE signal_replay.authority_shard SET outcome_bytes=outcome_bytes-prior+wanted_bytes
      WHERE shard = s.shard;
END;
$$;

-- Per-shard deltas of one maintenance batch, applied in ascending shard order.
DO $$ BEGIN
    IF pg_catalog.to_regtype('signal_replay.shard_delta') IS NULL THEN
        CREATE TYPE signal_replay.shard_delta AS (shard SMALLINT, rows_removed BIGINT, bytes BIGINT);
    END IF;
END $$;

CREATE OR REPLACE FUNCTION signal_replay.api_prune(requested_authority TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE deltas signal_replay.shard_delta[]; delta signal_replay.shard_delta;
BEGIN
    PERFORM * FROM signal_replay.api_authority(requested_authority,FALSE,FALSE);
    WITH expired AS (SELECT fp_hash,octet_length(outcome_json) AS bytes
      FROM signal_replay.entries WHERE outcome_json IS NOT NULL
      AND (expires_at IS NULL OR expires_at <= extract(epoch FROM pg_catalog.clock_timestamp()))
      ORDER BY expires_at NULLS FIRST LIMIT 1000 FOR UPDATE SKIP LOCKED),
    cleared AS (UPDATE signal_replay.entries e SET outcome_json=NULL FROM expired x
                WHERE e.fp_hash=x.fp_hash RETURNING e.fp_hash),
    grouped AS (SELECT signal_replay.shard_of(x.fp_hash) AS shard, count(*) AS rows_cleared, sum(x.bytes) AS bytes
                FROM expired x JOIN cleared c USING(fp_hash) GROUP BY 1)
    SELECT array_agg(ROW(g.shard, g.rows_cleared, g.bytes)::signal_replay.shard_delta ORDER BY g.shard)
      INTO deltas FROM grouped g;
    FOREACH delta IN ARRAY coalesce(deltas, '{}') LOOP
        UPDATE signal_replay.authority_shard SET outcome_bytes=outcome_bytes-delta.bytes WHERE shard=delta.shard;
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION signal_replay.api_expire_identities(requested_authority TEXT, batch INTEGER)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE deltas signal_replay.shard_delta[]; delta signal_replay.shard_delta; removed_rows BIGINT := 0;
BEGIN
    IF batch IS NULL OR batch < 1 OR batch > 10000 THEN
        RAISE EXCEPTION 'invalid replay operation';
    END IF;
    PERFORM * FROM signal_replay.api_authority(requested_authority,FALSE,FALSE);
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
        RETURNING d.fp_hash, d.bytes),
    grouped AS (SELECT signal_replay.shard_of(fp_hash) AS shard, count(*) AS rows_removed, coalesce(sum(bytes),0) AS bytes
                FROM deleted GROUP BY 1)
    SELECT array_agg(ROW(g.shard, g.rows_removed, g.bytes)::signal_replay.shard_delta ORDER BY g.shard)
      INTO deltas FROM grouped g;
    FOREACH delta IN ARRAY coalesce(deltas, '{}') LOOP
        UPDATE signal_replay.authority_shard
           SET admitted=admitted-delta.rows_removed, outcome_bytes=outcome_bytes-delta.bytes
         WHERE shard=delta.shard;
        removed_rows := removed_rows + delta.rows_removed;
    END LOOP;
    RETURN removed_rows;
END;
$$;

CREATE OR REPLACE FUNCTION signal_replay.api_ready(requested_authority TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    PERFORM * FROM signal_replay.api_authority(requested_authority,TRUE,FALSE);
    -- Write-permission probe on one shard; the router rolls this back.
    UPDATE signal_replay.authority_shard SET admitted=admitted WHERE shard=0;
END;
$$;

-- The fence compares live counters with the entries table.
CREATE OR REPLACE FUNCTION signal_replay.fence_status(
    p_min_high_water PG_LSN DEFAULT NULL, p_high_water_timeline BIGINT DEFAULT NULL)
RETURNS TABLE (
    classification TEXT, start_matches BOOLEAN, addr_matches BOOLEAN, durable_primary BOOLEAN,
    pinned_timeline BIGINT, current_timeline BIGINT, wal_lsn PG_LSN, high_water_lsn PG_LSN,
    counters_consistent BOOLEAN, admitted_count BIGINT, entry_count BIGINT,
    pending_count BIGINT, unknown_count BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
    p signal_replay.runtime_policy%ROWTYPE;
    e signal_replay.instance_evidence%ROWTYPE;
    stored_bytes BIGINT; counted_bytes BIGINT;
BEGIN
    PERFORM signal_replay.fence_require_owner();
    SELECT * INTO STRICT p FROM signal_replay.runtime_policy WHERE singleton;
    SELECT * INTO e FROM signal_replay.instance_evidence WHERE singleton;
    start_matches := (extract(epoch FROM pg_catalog.pg_postmaster_start_time())*1000000)::bigint
                     = p.instance_start_us;
    addr_matches := pg_catalog.inet_server_addr() IS NOT DISTINCT FROM p.instance_server_addr;
    durable_primary := NOT pg_catalog.pg_is_in_recovery()
        AND pg_catalog.current_setting('fsync') = 'on'
        AND pg_catalog.current_setting('full_page_writes') = 'on'
        AND pg_catalog.current_setting('synchronous_commit') = 'on';
    current_timeline := signal_replay.fence_current_timeline();
    IF current_timeline IS NOT NULL THEN
        wal_lsn := pg_catalog.pg_current_wal_lsn();
    END IF;
    SELECT count(*), count(*) FILTER (WHERE x.state = 'settlement_pending'),
           count(*) FILTER (WHERE x.state = 'unknown'),
           coalesce(sum(octet_length(x.outcome_json)), 0)
      INTO entry_count, pending_count, unknown_count, stored_bytes
      FROM signal_replay.entries x;
    SELECT coalesce(sum(s.admitted), 0), coalesce(sum(s.outcome_bytes), 0)
      INTO admitted_count, counted_bytes FROM signal_replay.authority_shard s;
    counters_consistent := (SELECT count(*) FROM signal_replay.authority_shard) = 16
        AND admitted_count = entry_count AND counted_bytes = stored_bytes;
    IF e.singleton IS NOT NULL AND e.instance_start_us = p.instance_start_us
       AND e.instance_server_addr = p.instance_server_addr THEN
        pinned_timeline := e.timeline_id;
        high_water_lsn := e.high_water_lsn;
    END IF;
    IF p_min_high_water IS NOT NULL AND p_high_water_timeline IS NOT DISTINCT FROM current_timeline THEN
        high_water_lsn := GREATEST(high_water_lsn, p_min_high_water);
    END IF;
    IF NOT durable_primary THEN
        classification := 'not_durable_primary';
    ELSIF start_matches AND addr_matches THEN
        classification := 'pinned';
    ELSIF pinned_timeline IS NULL THEN
        classification := 'no_evidence';
    ELSIF addr_matches AND current_timeline = pinned_timeline AND wal_lsn >= high_water_lsn THEN
        classification := 'restart';
    ELSE
        classification := 'instance_changed';
    END IF;
    RETURN NEXT;
END;
$$;

COMMIT;
