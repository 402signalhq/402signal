-- Transparency-leaf outbox for the managed functions-v1 authority.
--
-- A router process that does not hold the writer lease can complete a paid
-- check whose evidence does not have to be signed at response time: it queues
-- the public leaf bytes here, durably, and the writer appends them to the
-- append-only log in queue order. Only public leaf bytes are stored (the same
-- bytes the log holds); never the reveal, salt or any private evidence. The
-- log append is idempotent by leaf hash, so a drain that crashes after the
-- append and before the acknowledgement repeats no leaf.
--
-- Every entry point runs the same guard as paid admission
-- (signal_replay.api_authority: runtime login, instance fence, authority id,
-- activation, durable primary, role drift), so a fenced database refuses
-- queued leaves exactly as it refuses admissions.
--
-- Install as the migration owner AFTER ops/replay-postgres-functions.sql.
-- Additive: no writer stop, no existing function changes. The router uses the
-- outbox only when LIVE402_PQ_OUTBOX=1 and these functions exist.
BEGIN;

DO $$
BEGIN
    IF pg_catalog.to_regprocedure('signal_replay.api_authority(text,boolean,boolean)') IS NULL THEN
        RAISE EXCEPTION 'install ops/replay-postgres-functions.sql first';
    END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS signal_replay.leaf_outbox (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    leaf_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(leaf_hash) = 32),
    body BYTEA NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 65536),
    queued_by TEXT NOT NULL CHECK (length(queued_by) BETWEEN 1 AND 128),
    queued_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    appended_idx BIGINT CHECK (appended_idx IS NULL OR appended_idx >= 0),
    appended_at TIMESTAMPTZ,
    CHECK ((appended_idx IS NULL) = (appended_at IS NULL))
);
CREATE INDEX IF NOT EXISTS leaf_outbox_pending
    ON signal_replay.leaf_outbox(id) WHERE appended_idx IS NULL;

CREATE OR REPLACE FUNCTION signal_replay.outbox_guard(requested_authority TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    PERFORM * FROM signal_replay.api_authority(requested_authority, FALSE, FALSE);
    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN pg_catalog.pg_roles r
        WHERE c.oid = 'signal_replay.leaf_outbox'::regclass
          AND (r.rolname = session_user OR pg_catalog.pg_has_role(session_user, r.oid, 'MEMBER'))
          AND (pg_catalog.has_table_privilege(r.oid, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
               OR pg_catalog.has_any_column_privilege(r.oid, c.oid, 'INSERT,UPDATE')
               OR r.oid = c.relowner)) THEN
        RAISE EXCEPTION 'replay authority unavailable';
    END IF;
END;
$$;

-- Queue one public leaf. The hash must be the RFC 6962 leaf hash of the body
-- (SHA-256 over 0x00 || body). A repeated leaf returns the existing row.
CREATE OR REPLACE FUNCTION signal_replay.api_outbox_put(
    requested_authority TEXT, leaf BYTEA, leaf_body BYTEA, queued_by TEXT)
RETURNS TABLE (id BIGINT, duplicate BOOLEAN, appended_idx BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE inserted BIGINT;
BEGIN
    PERFORM signal_replay.outbox_guard(requested_authority);
    IF leaf IS NULL OR leaf_body IS NULL OR queued_by IS NULL
       OR pg_catalog.sha256('\x00'::bytea || leaf_body) <> leaf THEN
        RAISE EXCEPTION 'invalid replay operation';
    END IF;
    INSERT INTO signal_replay.leaf_outbox AS o (leaf_hash, body, queued_by)
      VALUES (leaf, leaf_body, queued_by)
      ON CONFLICT (leaf_hash) DO NOTHING RETURNING o.id INTO inserted;
    IF inserted IS NOT NULL THEN
        RETURN QUERY SELECT inserted, FALSE, NULL::bigint;
    ELSE
        RETURN QUERY SELECT o.id, TRUE, o.appended_idx FROM signal_replay.leaf_outbox o WHERE o.leaf_hash = leaf;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION signal_replay.api_outbox_pending(requested_authority TEXT, batch INTEGER)
RETURNS TABLE (id BIGINT, leaf_hash BYTEA, body BYTEA)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    PERFORM signal_replay.outbox_guard(requested_authority);
    IF batch IS NULL OR batch < 1 OR batch > 1000 THEN
        RAISE EXCEPTION 'invalid replay operation';
    END IF;
    RETURN QUERY SELECT o.id, o.leaf_hash, o.body FROM signal_replay.leaf_outbox o
                  WHERE o.appended_idx IS NULL ORDER BY o.id LIMIT batch;
END;
$$;

CREATE OR REPLACE FUNCTION signal_replay.api_outbox_ack(requested_authority TEXT, row_id BIGINT, idx BIGINT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    PERFORM signal_replay.outbox_guard(requested_authority);
    IF row_id IS NULL OR idx IS NULL OR idx < 0 THEN
        RAISE EXCEPTION 'invalid replay operation';
    END IF;
    UPDATE signal_replay.leaf_outbox SET appended_idx = idx, appended_at = pg_catalog.clock_timestamp()
     WHERE id = row_id AND appended_idx IS NULL;
    RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION signal_replay.api_outbox_depth(requested_authority TEXT)
RETURNS TABLE (pending BIGINT, oldest_age_s DOUBLE PRECISION)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    PERFORM signal_replay.outbox_guard(requested_authority);
    RETURN QUERY SELECT count(*)::bigint,
                        coalesce(extract(epoch FROM pg_catalog.clock_timestamp() - min(o.queued_at)), 0)::double precision
                   FROM signal_replay.leaf_outbox o WHERE o.appended_idx IS NULL;
END;
$$;

-- Drop acknowledged rows older than the retention. Pending rows are never dropped.
CREATE OR REPLACE FUNCTION signal_replay.api_outbox_prune(requested_authority TEXT, older_than_days INTEGER)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE removed BIGINT;
BEGIN
    PERFORM signal_replay.outbox_guard(requested_authority);
    IF older_than_days IS NULL OR older_than_days < 1 OR older_than_days > 365 THEN
        RAISE EXCEPTION 'invalid replay operation';
    END IF;
    WITH gone AS (
        DELETE FROM signal_replay.leaf_outbox
         WHERE appended_idx IS NOT NULL
           AND appended_at < pg_catalog.clock_timestamp() - older_than_days * interval '1 day'
        RETURNING 1)
    SELECT count(*) INTO removed FROM gone;
    RETURN removed;
END;
$$;

COMMIT;
