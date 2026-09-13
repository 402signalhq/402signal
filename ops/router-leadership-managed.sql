-- Router writer leadership lease for managed PostgreSQL.
--
-- Fly Managed Postgres (and similar services) reject GRANT and REVOKE, so this
-- variant keeps PostgreSQL's default PUBLIC EXECUTE on its functions. Each
-- function instead refuses every login except the replay runtime login pinned
-- in signal_replay.runtime_policy, the model the replay functions already use.
-- The runtime login still has no direct write access to the lease table.
--
-- Install as the replay migration owner AFTER ops/replay-postgres-functions.sql.
-- Self-managed PostgreSQL that permits grants may use ops/router-leadership.sql.
-- Installing changes nothing at runtime until LIVE402_LEADERSHIP_BACKEND=postgres.
--
-- Expiry uses the database clock. A renew by the current holder extends the
-- lease; any other holder acquires only after expiry and bumps the epoch.

BEGIN;

DO $$
BEGIN
    IF pg_catalog.to_regclass('signal_replay.runtime_policy') IS NULL THEN
        RAISE EXCEPTION 'install ops/replay-postgres-functions.sql first';
    END IF;
END;
$$;

CREATE SCHEMA IF NOT EXISTS signal_router;

CREATE TABLE IF NOT EXISTS signal_router.router_leadership (
    slot text PRIMARY KEY CHECK (slot ~ '^[a-z0-9-]{1,64}$'),
    holder text NOT NULL CHECK (length(holder) BETWEEN 1 AND 128),
    until timestamptz NOT NULL,
    epoch bigint NOT NULL DEFAULT 1,
    renewed_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION signal_router.lease_renew(p_slot text, p_holder text, p_ttl_ms integer)
RETURNS TABLE (lease_holder text, lease_epoch bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM signal_replay.runtime_policy p
                   WHERE p.singleton AND p.runtime_login = session_user::text) THEN
        RAISE EXCEPTION 'router leadership unavailable';
    END IF;
    INSERT INTO signal_router.router_leadership AS l (slot, holder, until, epoch, renewed_at)
    SELECT p_slot, p_holder, clock_timestamp() + p_ttl_ms * interval '1 millisecond', 1, clock_timestamp()
    WHERE p_ttl_ms BETWEEN 1000 AND 120000
    ON CONFLICT (slot) DO UPDATE
        SET holder = EXCLUDED.holder,
            until = EXCLUDED.until,
            renewed_at = EXCLUDED.renewed_at,
            epoch = CASE WHEN l.holder = EXCLUDED.holder THEN l.epoch ELSE l.epoch + 1 END
        WHERE l.holder = EXCLUDED.holder OR l.until < clock_timestamp()
    RETURNING l.holder, l.epoch INTO lease_holder, lease_epoch;
    IF FOUND THEN
        RETURN NEXT;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION signal_router.lease_release(p_slot text, p_holder text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM signal_replay.runtime_policy p
                   WHERE p.singleton AND p.runtime_login = session_user::text) THEN
        RAISE EXCEPTION 'router leadership unavailable';
    END IF;
    UPDATE signal_router.router_leadership
    SET until = clock_timestamp() - interval '1 second'
    WHERE slot = p_slot AND holder = p_holder;
    RETURN FOUND;
END;
$$;

COMMIT;
