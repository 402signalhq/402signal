-- Router writer leadership lease on the replay PostgreSQL.
--
-- Install as the replay migration owner (not the runtime Reader login), then
-- grant the runtime login execute rights separately:
--
--   GRANT USAGE ON SCHEMA signal_router TO <runtime_login>;
--   GRANT EXECUTE ON FUNCTION signal_router.lease_renew(text, text, integer) TO <runtime_login>;
--   GRANT EXECUTE ON FUNCTION signal_router.lease_release(text, text) TO <runtime_login>;
--
-- Expiry uses the database clock. A renew by the current holder extends the
-- lease; any other holder acquires only after expiry and bumps the epoch.
-- The runtime login cannot write the table directly.

BEGIN;

CREATE SCHEMA IF NOT EXISTS signal_router;
REVOKE ALL ON SCHEMA signal_router FROM PUBLIC;

CREATE TABLE IF NOT EXISTS signal_router.router_leadership (
    slot text PRIMARY KEY CHECK (slot ~ '^[a-z0-9-]{1,64}$'),
    holder text NOT NULL CHECK (length(holder) BETWEEN 1 AND 128),
    until timestamptz NOT NULL,
    epoch bigint NOT NULL DEFAULT 1,
    renewed_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON signal_router.router_leadership FROM PUBLIC;

CREATE OR REPLACE FUNCTION signal_router.lease_renew(p_slot text, p_holder text, p_ttl_ms integer)
RETURNS TABLE (lease_holder text, lease_epoch bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
    INSERT INTO signal_router.router_leadership AS l (slot, holder, until, epoch, renewed_at)
    SELECT p_slot, p_holder, clock_timestamp() + p_ttl_ms * interval '1 millisecond', 1, clock_timestamp()
    WHERE p_ttl_ms BETWEEN 1000 AND 120000
    ON CONFLICT (slot) DO UPDATE
        SET holder = EXCLUDED.holder,
            until = EXCLUDED.until,
            renewed_at = EXCLUDED.renewed_at,
            epoch = CASE WHEN l.holder = EXCLUDED.holder THEN l.epoch ELSE l.epoch + 1 END
        WHERE l.holder = EXCLUDED.holder OR l.until < clock_timestamp()
    RETURNING l.holder, l.epoch;
$$;

CREATE OR REPLACE FUNCTION signal_router.lease_release(p_slot text, p_holder text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
    WITH released AS (
        UPDATE signal_router.router_leadership
        SET until = clock_timestamp() - interval '1 second'
        WHERE slot = p_slot AND holder = p_holder
        RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM released);
$$;

REVOKE ALL ON FUNCTION signal_router.lease_renew(text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION signal_router.lease_release(text, text) FROM PUBLIC;

COMMIT;
