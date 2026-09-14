-- Shadow catalog replica on the managed replay PostgreSQL.
--
-- Fourth step of the second-machine plan, the same shape as the probe
-- history replica (ops/history-postgres-managed.sql). The writer machine
-- keeps its SQLite catalog file (the source of truth and the reader for
-- /preview, /catalog and the endpoint pages) and ships every committed
-- change here through a transactional outbox, so a second machine can read
-- the same listings, payment claims, source sweeps and claim events. Rows
-- keep the SQLite ids; there is one writer. The full-text index and the
-- short-lived finalist schema cache are derived data and are not copied.
--
-- Fly Managed Postgres rejects GRANT and REVOKE, so this file keeps
-- PostgreSQL's default PUBLIC EXECUTE on its functions and every write
-- function refuses every login except the replay runtime login pinned in
-- signal_replay.runtime_policy. The runtime login reads the tables through
-- its read-all role and cannot write them directly; a broadened runtime
-- login fences every write.
--
-- Install as the replay migration owner AFTER ops/replay-postgres-functions.sql.
-- Additive: no writer stop. Nothing changes at runtime until
-- LIVE402_CATALOG_BACKEND=dual. Re-running the file is harmless.
--
-- Everything here is catalog-claimed public listing data (seller URL,
-- claimed name, description, price, recipient, network); no wallet, no
-- request or response body.

BEGIN;

DO $$
BEGIN
    IF pg_catalog.to_regclass('signal_replay.runtime_policy') IS NULL THEN
        RAISE EXCEPTION 'install ops/replay-postgres-functions.sql first';
    END IF;
END;
$$;

CREATE SCHEMA IF NOT EXISTS signal_catalog;

CREATE TABLE IF NOT EXISTS signal_catalog.resources (
    id BIGINT PRIMARY KEY CHECK (id > 0),
    canonical_url TEXT NOT NULL UNIQUE CHECK (length(canonical_url) BETWEEN 1 AND 2048),
    service_name TEXT CHECK (service_name IS NULL OR length(service_name) <= 512),
    description TEXT CHECK (description IS NULL OR length(description) <= 8192),
    capability TEXT CHECK (capability IS NULL OR length(capability) <= 128),
    capability_version INTEGER NOT NULL DEFAULT 0,
    tool_name TEXT CHECK (tool_name IS NULL OR length(tool_name) <= 256),
    method TEXT CHECK (method IS NULL OR length(method) <= 16),
    tags TEXT CHECK (tags IS NULL OR length(tags) <= 2048),
    input_schema_present INTEGER NOT NULL DEFAULT 0,
    output_schema_present INTEGER NOT NULL DEFAULT 0,
    first_seen BIGINT NOT NULL,
    last_seen BIGINT NOT NULL,
    last_fetched BIGINT,
    last_verified BIGINT,
    last_searched BIGINT,
    last_routed BIGINT,
    last_probe_ok INTEGER,
    row_hash TEXT CHECK (row_hash IS NULL OR length(row_hash) <= 128),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
    retired_at BIGINT,
    reappeared_at BIGINT
);
CREATE INDEX IF NOT EXISTS resources_status_seen ON signal_catalog.resources(status, last_seen);

CREATE TABLE IF NOT EXISTS signal_catalog.resource_sources (
    id BIGINT PRIMARY KEY CHECK (id > 0),
    resource_id BIGINT NOT NULL,
    source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 32),
    source_resource_id TEXT CHECK (source_resource_id IS NULL OR length(source_resource_id) <= 256),
    source_generation BIGINT,
    source_last_seen BIGINT,
    UNIQUE (resource_id, source)
);

CREATE TABLE IF NOT EXISTS signal_catalog.accept_claims (
    id BIGINT PRIMARY KEY CHECK (id > 0),
    resource_id BIGINT NOT NULL,
    source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 32),
    rail TEXT CHECK (rail IS NULL OR length(rail) <= 64),
    network TEXT CHECK (network IS NULL OR length(network) <= 64),
    asset TEXT CHECK (asset IS NULL OR length(asset) <= 128),
    amount_atomic TEXT CHECK (amount_atomic IS NULL OR length(amount_atomic) <= 128),
    payto TEXT CHECK (payto IS NULL OR length(payto) <= 256),
    facilitator TEXT CHECK (facilitator IS NULL OR length(facilitator) <= 512)
);
CREATE INDEX IF NOT EXISTS accept_claims_resource ON signal_catalog.accept_claims(resource_id, source);

CREATE TABLE IF NOT EXISTS signal_catalog.source_state (
    source TEXT PRIMARY KEY CHECK (length(source) BETWEEN 1 AND 32),
    generation BIGINT NOT NULL DEFAULT 0,
    cursor BIGINT NOT NULL DEFAULT 0,
    upstream_total BIGINT,
    sweep_started_at BIGINT,
    last_complete_sweep_at BIGINT
);

CREATE TABLE IF NOT EXISTS signal_catalog.claim_events (
    id BIGINT PRIMARY KEY CHECK (id > 0),
    resource_id BIGINT,
    canonical_url TEXT CHECK (canonical_url IS NULL OR length(canonical_url) <= 2048),
    event TEXT NOT NULL CHECK (length(event) BETWEEN 1 AND 64),
    source TEXT CHECK (source IS NULL OR length(source) <= 32),
    detail TEXT CHECK (detail IS NULL OR length(detail) <= 512),
    ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS claim_events_ts ON signal_catalog.claim_events(ts);
CREATE INDEX IF NOT EXISTS claim_events_url ON signal_catalog.claim_events(canonical_url, ts);

CREATE TABLE IF NOT EXISTS signal_catalog.replica_meta (
    key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 64),
    value TEXT NOT NULL CHECK (octet_length(value) <= 4096),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE OR REPLACE FUNCTION signal_catalog.guard()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM signal_replay.runtime_policy p
                   WHERE p.singleton AND p.runtime_login = session_user::text) THEN
        RAISE EXCEPTION 'catalog replica unavailable';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN pg_catalog.pg_roles r
        WHERE n.nspname = 'signal_catalog' AND c.relkind = 'r'
          AND (r.rolname = session_user OR pg_catalog.pg_has_role(session_user, r.oid, 'MEMBER'))
          AND (pg_catalog.has_table_privilege(r.oid, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
               OR pg_catalog.has_any_column_privilege(r.oid, c.oid, 'INSERT,UPDATE')
               OR r.oid = c.relowner
               OR pg_catalog.has_schema_privilege(r.oid, n.oid, 'CREATE'))) THEN
        RAISE EXCEPTION 'catalog replica unavailable';
    END IF;
END;
$$;

-- One committed SQLite change set (or one backfill chunk), applied atomically.
-- resources, resource_sources and claim_events upsert by their SQLite id;
-- source_state by source; the payment claims of every resource named in
-- claims_for are replaced by the shipped rows (the writer replaces them per
-- source, so the shipped set is the whole current set for that resource);
-- deleted_events names capped-out event ids. Re-applying is harmless.
CREATE OR REPLACE FUNCTION signal_catalog.api_apply(p_payload JSONB)
RETURNS TABLE (resources BIGINT, resource_sources BIGINT, accept_claims BIGINT, source_state BIGINT,
               claim_events BIGINT, deleted_events BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n_res BIGINT; n_src BIGINT; n_claims BIGINT; n_state BIGINT; n_events BIGINT; n_del BIGINT;
BEGIN
    PERFORM signal_catalog.guard();
    IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object'
       OR pg_catalog.octet_length(p_payload::text) > 8388608 THEN
        RAISE EXCEPTION 'invalid catalog operation';
    END IF;
    WITH ins AS (
        INSERT INTO signal_catalog.resources
            (id, canonical_url, service_name, description, capability, capability_version, tool_name, method, tags,
             input_schema_present, output_schema_present, first_seen, last_seen, last_fetched, last_verified,
             last_searched, last_routed, last_probe_ok, row_hash, status, retired_at, reappeared_at)
        SELECT x.id, x.canonical_url, x.service_name, x.description, x.capability, coalesce(x.capability_version, 0),
               x.tool_name, x.method, x.tags, coalesce(x.input_schema_present, 0), coalesce(x.output_schema_present, 0),
               x.first_seen, x.last_seen, x.last_fetched, x.last_verified, x.last_searched, x.last_routed,
               x.last_probe_ok, x.row_hash, coalesce(x.status, 'active'), x.retired_at, x.reappeared_at
          FROM pg_catalog.jsonb_to_recordset(coalesce(p_payload->'resources', '[]'::jsonb)) AS x(
               id BIGINT, canonical_url TEXT, service_name TEXT, description TEXT, capability TEXT,
               capability_version INTEGER, tool_name TEXT, method TEXT, tags TEXT, input_schema_present INTEGER,
               output_schema_present INTEGER, first_seen BIGINT, last_seen BIGINT, last_fetched BIGINT,
               last_verified BIGINT, last_searched BIGINT, last_routed BIGINT, last_probe_ok INTEGER,
               row_hash TEXT, status TEXT, retired_at BIGINT, reappeared_at BIGINT)
        ON CONFLICT (id) DO UPDATE SET
            canonical_url = EXCLUDED.canonical_url, service_name = EXCLUDED.service_name,
            description = EXCLUDED.description, capability = EXCLUDED.capability,
            capability_version = EXCLUDED.capability_version, tool_name = EXCLUDED.tool_name,
            method = EXCLUDED.method, tags = EXCLUDED.tags, input_schema_present = EXCLUDED.input_schema_present,
            output_schema_present = EXCLUDED.output_schema_present, first_seen = EXCLUDED.first_seen,
            last_seen = EXCLUDED.last_seen, last_fetched = EXCLUDED.last_fetched, last_verified = EXCLUDED.last_verified,
            last_searched = EXCLUDED.last_searched, last_routed = EXCLUDED.last_routed,
            last_probe_ok = EXCLUDED.last_probe_ok, row_hash = EXCLUDED.row_hash, status = EXCLUDED.status,
            retired_at = EXCLUDED.retired_at, reappeared_at = EXCLUDED.reappeared_at
        RETURNING 1)
    SELECT count(*) INTO n_res FROM ins;
    WITH ins AS (
        INSERT INTO signal_catalog.resource_sources (id, resource_id, source, source_resource_id, source_generation, source_last_seen)
        SELECT x.id, x.resource_id, x.source, x.source_resource_id, x.source_generation, x.source_last_seen
          FROM pg_catalog.jsonb_to_recordset(coalesce(p_payload->'resource_sources', '[]'::jsonb)) AS x(
               id BIGINT, resource_id BIGINT, source TEXT, source_resource_id TEXT, source_generation BIGINT,
               source_last_seen BIGINT)
        ON CONFLICT (id) DO UPDATE SET
            resource_id = EXCLUDED.resource_id, source = EXCLUDED.source,
            source_resource_id = EXCLUDED.source_resource_id, source_generation = EXCLUDED.source_generation,
            source_last_seen = EXCLUDED.source_last_seen
        RETURNING 1)
    SELECT count(*) INTO n_src FROM ins;
    DELETE FROM signal_catalog.accept_claims c
     USING pg_catalog.jsonb_array_elements_text(coalesce(p_payload->'claims_for', '[]'::jsonb)) AS d(id)
     WHERE c.resource_id = d.id::bigint;
    WITH ins AS (
        INSERT INTO signal_catalog.accept_claims (id, resource_id, source, rail, network, asset, amount_atomic, payto, facilitator)
        SELECT x.id, x.resource_id, x.source, x.rail, x.network, x.asset, x.amount_atomic, x.payto, x.facilitator
          FROM pg_catalog.jsonb_to_recordset(coalesce(p_payload->'accept_claims', '[]'::jsonb)) AS x(
               id BIGINT, resource_id BIGINT, source TEXT, rail TEXT, network TEXT, asset TEXT, amount_atomic TEXT,
               payto TEXT, facilitator TEXT)
        ON CONFLICT (id) DO UPDATE SET
            resource_id = EXCLUDED.resource_id, source = EXCLUDED.source, rail = EXCLUDED.rail,
            network = EXCLUDED.network, asset = EXCLUDED.asset, amount_atomic = EXCLUDED.amount_atomic,
            payto = EXCLUDED.payto, facilitator = EXCLUDED.facilitator
        RETURNING 1)
    SELECT count(*) INTO n_claims FROM ins;
    WITH ins AS (
        INSERT INTO signal_catalog.source_state (source, generation, cursor, upstream_total, sweep_started_at, last_complete_sweep_at)
        SELECT x.source, coalesce(x.generation, 0), coalesce(x.cursor, 0), x.upstream_total, x.sweep_started_at,
               x.last_complete_sweep_at
          FROM pg_catalog.jsonb_to_recordset(coalesce(p_payload->'source_state', '[]'::jsonb)) AS x(
               source TEXT, generation BIGINT, cursor BIGINT, upstream_total BIGINT, sweep_started_at BIGINT,
               last_complete_sweep_at BIGINT)
        ON CONFLICT (source) DO UPDATE SET
            generation = EXCLUDED.generation, cursor = EXCLUDED.cursor, upstream_total = EXCLUDED.upstream_total,
            sweep_started_at = EXCLUDED.sweep_started_at, last_complete_sweep_at = EXCLUDED.last_complete_sweep_at
        RETURNING 1)
    SELECT count(*) INTO n_state FROM ins;
    WITH gone AS (
        DELETE FROM signal_catalog.claim_events e
         USING pg_catalog.jsonb_array_elements_text(coalesce(p_payload->'deleted_events', '[]'::jsonb)) AS d(id)
         WHERE e.id = d.id::bigint RETURNING 1)
    SELECT count(*) INTO n_del FROM gone;
    WITH ins AS (
        INSERT INTO signal_catalog.claim_events (id, resource_id, canonical_url, event, source, detail, ts)
        SELECT x.id, x.resource_id, x.canonical_url, x.event, x.source, x.detail, x.ts
          FROM pg_catalog.jsonb_to_recordset(coalesce(p_payload->'claim_events', '[]'::jsonb)) AS x(
               id BIGINT, resource_id BIGINT, canonical_url TEXT, event TEXT, source TEXT, detail TEXT, ts BIGINT)
        ON CONFLICT (id) DO NOTHING RETURNING 1)
    SELECT count(*) INTO n_events FROM ins;
    RETURN QUERY SELECT n_res, n_src, n_claims, n_state, n_events, n_del;
END;
$$;

CREATE OR REPLACE FUNCTION signal_catalog.api_meta_set(p_key TEXT, p_value TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    PERFORM signal_catalog.guard();
    INSERT INTO signal_catalog.replica_meta (key, value, updated_at)
    VALUES (p_key, p_value, pg_catalog.clock_timestamp())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = pg_catalog.clock_timestamp();
END;
$$;

COMMIT;
