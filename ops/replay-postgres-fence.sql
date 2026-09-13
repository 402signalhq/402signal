-- Replay instance-fence recovery for the managed functions-v1 authority.
--
-- runtime_policy pins the PostgreSQL postmaster start time and server address,
-- so any restart, failover or restore stops paid admission. These owner-only
-- functions classify the change and re-pin only when continuity is established:
--
--   restart           Same server address and WAL timeline, WAL position at or
--                     beyond every recorded high-water mark, counters consistent.
--                     Every replay entry point already requires fsync,
--                     full_page_writes and synchronous_commit, so a restart of
--                     the same history cannot lose an acknowledged commit.
--   instance_changed  Different server address or WAL timeline: failover,
--                     promotion or restore. Replication may be asynchronous, so
--                     recent commits can be missing. Re-pin requires an operator
--                     attestation after reconciliation, bound to the current
--                     admitted count.
--   no_evidence       No timeline recorded for the current pin. Attestation only.
--
-- The database cannot detect a provider restoring an older copy onto the same
-- address and timeline. The operator wrapper therefore passes an external
-- high-water WAL position recorded outside the database (scripts/replay_fence.sh).
--
-- Install as the migration owner AFTER ops/replay-postgres-functions.sql.
-- Functions keep the default PUBLIC EXECUTE (managed providers refuse
-- GRANT/REVOKE) and refuse any login that is not a member of the schema owner.
-- Runtime entry points and the readiness guard are unchanged.

BEGIN;

DO $$
BEGIN
    IF pg_catalog.to_regclass('signal_replay.runtime_policy') IS NULL THEN
        RAISE EXCEPTION 'install ops/replay-postgres-functions.sql first';
    END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS signal_replay.instance_evidence (
    singleton BOOLEAN PRIMARY KEY CHECK (singleton),
    instance_start_us BIGINT NOT NULL CHECK (instance_start_us > 0),
    instance_server_addr INET NOT NULL,
    timeline_id BIGINT NOT NULL CHECK (timeline_id > 0),
    high_water_lsn PG_LSN NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS signal_replay.fence_events (
    event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    recorded_at TIMESTAMPTZ NOT NULL,
    actor TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('adopted', 'restart_repin', 'attested_repin')),
    classification TEXT NOT NULL,
    old_start_us BIGINT,
    new_start_us BIGINT,
    old_server_addr INET,
    new_server_addr INET,
    old_timeline BIGINT,
    new_timeline BIGINT,
    wal_lsn PG_LSN,
    admitted_count BIGINT NOT NULL,
    pending_count BIGINT NOT NULL,
    unknown_count BIGINT NOT NULL,
    note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500)
);

CREATE OR REPLACE FUNCTION signal_replay.fence_require_owner()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    IF NOT pg_catalog.pg_has_role(session_user,
            (SELECT n.nspowner FROM pg_catalog.pg_namespace n WHERE n.nspname = 'signal_replay'), 'MEMBER')
       OR EXISTS (SELECT 1 FROM signal_replay.runtime_policy p WHERE p.runtime_login = session_user::text) THEN
        RAISE EXCEPTION 'replay fence tooling is owner-only';
    END IF;
END;
$$;

-- Current WAL timeline of a primary (from the WAL file name), NULL in recovery.
CREATE OR REPLACE FUNCTION signal_replay.fence_current_timeline()
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    IF pg_catalog.pg_is_in_recovery() THEN
        RETURN NULL;
    END IF;
    RETURN ('x' || pg_catalog.lpad(pg_catalog.substr(
        pg_catalog.pg_walfile_name(pg_catalog.pg_current_wal_lsn()), 1, 8), 16, '0'))::bit(64)::bigint;
END;
$$;

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
    a signal_replay.authority%ROWTYPE;
    stored_bytes BIGINT;
BEGIN
    PERFORM signal_replay.fence_require_owner();
    SELECT * INTO STRICT p FROM signal_replay.runtime_policy WHERE singleton;
    SELECT * INTO STRICT a FROM signal_replay.authority WHERE singleton;
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
    admitted_count := a.admitted;
    counters_consistent := a.admitted = entry_count AND a.outcome_bytes = stored_bytes;
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

CREATE OR REPLACE FUNCTION signal_replay.fence_repin(
    p_mode TEXT, p_expected_admitted BIGINT DEFAULT NULL, p_note TEXT DEFAULT NULL,
    p_min_high_water PG_LSN DEFAULT NULL, p_high_water_timeline BIGINT DEFAULT NULL)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
    p signal_replay.runtime_policy%ROWTYPE;
    s RECORD;
    v_kind TEXT;
    v_start BIGINT := (extract(epoch FROM pg_catalog.pg_postmaster_start_time())*1000000)::bigint;
BEGIN
    PERFORM signal_replay.fence_require_owner();
    IF p_mode IS NULL OR p_mode NOT IN ('restart', 'attested') THEN
        RAISE EXCEPTION 'invalid fence operation';
    END IF;
    SELECT * INTO STRICT p FROM signal_replay.runtime_policy WHERE singleton;
    IF p.instance_start_us = v_start
       AND p.instance_server_addr IS NOT DISTINCT FROM pg_catalog.inet_server_addr()
       AND NOT pg_catalog.pg_is_in_recovery() THEN
        -- Still pinned: never lock the live authority. Refresh or adopt evidence only.
        UPDATE signal_replay.instance_evidence ev
           SET high_water_lsn = GREATEST(ev.high_water_lsn, pg_catalog.pg_current_wal_lsn()),
               recorded_at = pg_catalog.clock_timestamp()
         WHERE ev.singleton AND ev.instance_start_us = v_start
           AND ev.instance_server_addr IS NOT DISTINCT FROM pg_catalog.inet_server_addr()
           AND ev.timeline_id = signal_replay.fence_current_timeline();
        IF FOUND THEN
            RETURN 'already_pinned';
        END IF;
        SELECT * INTO STRICT s FROM signal_replay.fence_status(p_min_high_water, p_high_water_timeline);
        v_kind := 'adopted';
    ELSE
        -- Serialize with every replay entry point (policy, then authority) and other re-pins.
        SELECT * INTO STRICT p FROM signal_replay.runtime_policy WHERE singleton FOR UPDATE;
        PERFORM 1 FROM signal_replay.authority WHERE singleton FOR UPDATE;
        SELECT * INTO STRICT s FROM signal_replay.fence_status(p_min_high_water, p_high_water_timeline);
        IF s.classification = 'not_durable_primary' THEN
            RAISE EXCEPTION 'database is not a durable primary';
        END IF;
        IF s.classification = 'pinned' THEN
            RETURN 'already_pinned';
        END IF;
        IF NOT s.counters_consistent THEN
            RAISE EXCEPTION 'replay counters inconsistent; reconcile before re-pin';
        END IF;
        IF p_mode = 'restart' THEN
            IF s.classification <> 'restart' THEN
                RAISE EXCEPTION 'instance change is not a verified plain restart (%); attestation required',
                    s.classification;
            END IF;
            v_kind := 'restart_repin';
        ELSE
            IF p_expected_admitted IS DISTINCT FROM s.admitted_count OR p_note IS NULL
               OR pg_catalog.length(p_note) NOT BETWEEN 20 AND 500 THEN
                RAISE EXCEPTION 'attested re-pin requires the reconciled admitted count and a note';
            END IF;
            v_kind := 'attested_repin';
        END IF;
        UPDATE signal_replay.runtime_policy
           SET instance_start_us = v_start, instance_server_addr = pg_catalog.inet_server_addr()
         WHERE singleton;
    END IF;
    INSERT INTO signal_replay.instance_evidence
        (singleton, instance_start_us, instance_server_addr, timeline_id, high_water_lsn, recorded_at)
    VALUES (TRUE, v_start, pg_catalog.inet_server_addr(), s.current_timeline, s.wal_lsn,
            pg_catalog.clock_timestamp())
    ON CONFLICT (singleton) DO UPDATE
        SET instance_start_us = EXCLUDED.instance_start_us,
            instance_server_addr = EXCLUDED.instance_server_addr,
            timeline_id = EXCLUDED.timeline_id,
            high_water_lsn = EXCLUDED.high_water_lsn,
            recorded_at = EXCLUDED.recorded_at;
    INSERT INTO signal_replay.fence_events
        (recorded_at, actor, kind, classification, old_start_us, new_start_us, old_server_addr,
         new_server_addr, old_timeline, new_timeline, wal_lsn, admitted_count, pending_count,
         unknown_count, note)
    VALUES (pg_catalog.clock_timestamp(), session_user::text, v_kind, s.classification,
            p.instance_start_us, v_start, p.instance_server_addr, pg_catalog.inet_server_addr(),
            s.pinned_timeline, s.current_timeline, s.wal_lsn, s.admitted_count, s.pending_count,
            s.unknown_count, p_note);
    RETURN v_kind;
END;
$$;

-- Adopt evidence for the current pin so the first later restart can re-pin
-- without attestation. Does nothing while the fence is already broken.
DO $$
BEGIN
    IF (SELECT classification FROM signal_replay.fence_status()) = 'pinned' THEN
        PERFORM signal_replay.fence_repin('restart');
    END IF;
END;
$$;

COMMIT;
