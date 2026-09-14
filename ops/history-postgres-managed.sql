-- Probe history replica on the managed replay PostgreSQL.
--
-- Third step of the second-machine plan. The writer machine keeps writing
-- its SQLite history file (the source of truth and the reader for the
-- endpoint pages, alerts and reputation) and ships every committed change
-- here through a transactional outbox, so a second machine can read the same
-- probes, observations and per-URL change clocks. Rows keep the SQLite ids;
-- there is one writer, so ids never collide. The endpoint pages switch to
-- this copy only after the parity log has held for seven days.
--
-- Fly Managed Postgres rejects GRANT and REVOKE, so this file keeps
-- PostgreSQL's default PUBLIC EXECUTE on its functions and every write
-- function refuses every login except the replay runtime login pinned in
-- signal_replay.runtime_policy, the model the replay, lease and session
-- functions use. The runtime login reads the tables through its read-all
-- role and cannot write them directly; a broadened runtime login fences
-- every write.
--
-- Install as the replay migration owner AFTER ops/replay-postgres-functions.sql.
-- Additive: no writer stop. Nothing changes at runtime until
-- LIVE402_HISTORY_BACKEND=dual. Re-running the file is harmless.
--
-- No column here holds a wallet key, a buyer address, a request or a
-- response body: probes carry the seller URL, the observed terms (price,
-- recipient, network) and flags; the same rows the endpoint pages already
-- publish in aggregate.

BEGIN;

DO $$
BEGIN
    IF pg_catalog.to_regclass('signal_replay.runtime_policy') IS NULL THEN
        RAISE EXCEPTION 'install ops/replay-postgres-functions.sql first';
    END IF;
END;
$$;

CREATE SCHEMA IF NOT EXISTS signal_history;

CREATE TABLE IF NOT EXISTS signal_history.probes (
    id BIGINT PRIMARY KEY CHECK (id > 0),
    url TEXT NOT NULL CHECK (length(url) BETWEEN 1 AND 2048),
    ts BIGINT NOT NULL CHECK (ts >= 0),
    live INTEGER NOT NULL DEFAULT 0 CHECK (live IN (0, 1)),
    payable INTEGER NOT NULL DEFAULT 0 CHECK (payable IN (0, 1)),
    invocable INTEGER NOT NULL DEFAULT 0 CHECK (invocable IN (0, 1)),
    latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
    payto TEXT CHECK (payto IS NULL OR length(payto) <= 256),
    amount TEXT CHECK (amount IS NULL OR length(amount) <= 128),
    miss_reason TEXT CHECK (miss_reason IS NULL OR length(miss_reason) <= 64),
    rail TEXT CHECK (rail IS NULL OR length(rail) <= 64),
    schema_present INTEGER CHECK (schema_present IS NULL OR schema_present IN (0, 1)),
    settled_route_observation INTEGER NOT NULL DEFAULT 1 CHECK (settled_route_observation IN (0, 1)),
    trust_class TEXT NOT NULL DEFAULT 'INDEPENDENT' CHECK (length(trust_class) BETWEEN 1 AND 32),
    traffic_class TEXT NOT NULL DEFAULT 'unclassified' CHECK (length(traffic_class) BETWEEN 1 AND 32)
);
CREATE INDEX IF NOT EXISTS probes_url_ts ON signal_history.probes(url, ts);
CREATE INDEX IF NOT EXISTS probes_ts ON signal_history.probes(ts);

CREATE TABLE IF NOT EXISTS signal_history.url_state (
    url TEXT PRIMARY KEY CHECK (length(url) BETWEEN 1 AND 2048),
    last_payto TEXT CHECK (last_payto IS NULL OR length(last_payto) <= 256),
    last_amount TEXT CHECK (last_amount IS NULL OR length(last_amount) <= 128),
    schema_present INTEGER CHECK (schema_present IS NULL OR schema_present IN (0, 1)),
    payto_changed_at BIGINT,
    price_changed_at BIGINT,
    schema_changed_at BIGINT,
    last_checked BIGINT,
    last_success_402 BIGINT,
    pending_payto TEXT CHECK (pending_payto IS NULL OR length(pending_payto) <= 256),
    last_trusted_ts BIGINT
);

CREATE TABLE IF NOT EXISTS signal_history.observations (
    id BIGINT PRIMARY KEY CHECK (id > 0),
    probe_id BIGINT,
    batch_id TEXT CHECK (batch_id IS NULL OR length(batch_id) <= 128),
    source_type TEXT NOT NULL CHECK (length(source_type) BETWEEN 1 AND 32),
    source TEXT CHECK (source IS NULL OR length(source) <= 128),
    rail TEXT CHECK (rail IS NULL OR length(rail) <= 64),
    url TEXT NOT NULL CHECK (length(url) BETWEEN 1 AND 2048),
    field TEXT NOT NULL CHECK (length(field) BETWEEN 1 AND 64),
    value TEXT CHECK (value IS NULL OR length(value) <= 4096),
    status TEXT CHECK (status IS NULL OR length(status) <= 32),
    ts BIGINT NOT NULL CHECK (ts >= 0),
    trust_class TEXT CHECK (trust_class IS NULL OR length(trust_class) <= 32)
);
CREATE INDEX IF NOT EXISTS observations_url_field_ts ON signal_history.observations(url, field, ts);
CREATE INDEX IF NOT EXISTS observations_probe_id ON signal_history.observations(probe_id);
CREATE INDEX IF NOT EXISTS observations_source_type_ts ON signal_history.observations(source_type, ts);
CREATE INDEX IF NOT EXISTS observations_batch_id ON signal_history.observations(batch_id);

CREATE TABLE IF NOT EXISTS signal_history.sealed_batches (
    batch_id TEXT PRIMARY KEY CHECK (length(batch_id) BETWEEN 1 AND 128),
    sealed_at BIGINT NOT NULL CHECK (sealed_at >= 0)
);

CREATE TABLE IF NOT EXISTS signal_history.scoring_models (
    model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 64),
    model_hash TEXT NOT NULL CHECK (model_hash ~ '^[0-9a-f]{64}$'),
    effective_ts BIGINT NOT NULL CHECK (effective_ts >= 0),
    spec_json TEXT NOT NULL CHECK (octet_length(spec_json) <= 65536),
    recorded_at BIGINT NOT NULL CHECK (recorded_at >= 0),
    PRIMARY KEY (model_id, model_hash)
);

-- Small operator-visible markers: the writer's replica source id, backfill
-- progress and the last parity result, so the copy can be inspected from any
-- database client without the machine.
CREATE TABLE IF NOT EXISTS signal_history.replica_meta (
    key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 64),
    value TEXT NOT NULL CHECK (octet_length(value) <= 4096),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

-- Every write function starts here: exact runtime login, no direct write
-- rights on the schema for that login or any role it can reach.
CREATE OR REPLACE FUNCTION signal_history.guard()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM signal_replay.runtime_policy p
                   WHERE p.singleton AND p.runtime_login = session_user::text) THEN
        RAISE EXCEPTION 'history replica unavailable';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN pg_catalog.pg_roles r
        WHERE n.nspname = 'signal_history' AND c.relkind = 'r'
          AND (r.rolname = session_user OR pg_catalog.pg_has_role(session_user, r.oid, 'MEMBER'))
          AND (pg_catalog.has_table_privilege(r.oid, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
               OR pg_catalog.has_any_column_privilege(r.oid, c.oid, 'INSERT,UPDATE')
               OR r.oid = c.relowner
               OR pg_catalog.has_schema_privilege(r.oid, n.oid, 'CREATE'))) THEN
        RAISE EXCEPTION 'history replica unavailable';
    END IF;
END;
$$;

-- One committed SQLite change set (or one backfill chunk), applied atomically.
-- Every section is optional; rows upsert by their SQLite id (or URL for
-- url_state), deletes name ids. Re-applying a payload is harmless, so the
-- outbox can retry after a failure and the backfill can overlap live traffic.
-- Returns the number of rows written or removed per section.
CREATE OR REPLACE FUNCTION signal_history.api_apply(p_payload JSONB)
RETURNS TABLE (probes BIGINT, observations BIGINT, url_state BIGINT, deleted_probes BIGINT,
               deleted_observations BIGINT, sealed BIGINT, scoring_models BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n_probes BIGINT; n_obs BIGINT; n_state BIGINT; n_dp BIGINT; n_do BIGINT; n_sealed BIGINT; n_models BIGINT;
BEGIN
    PERFORM signal_history.guard();
    IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object'
       OR pg_catalog.octet_length(p_payload::text) > 8388608 THEN
        RAISE EXCEPTION 'invalid history operation';
    END IF;
    -- Deletes first: a probe capped out in the same change set never reappears.
    WITH gone AS (
        DELETE FROM signal_history.observations o
         USING pg_catalog.jsonb_array_elements_text(coalesce(p_payload->'deleted_probes', '[]'::jsonb)) AS d(id)
         WHERE o.probe_id = d.id::bigint RETURNING 1)
    SELECT count(*) INTO n_do FROM gone;
    WITH gone AS (
        DELETE FROM signal_history.probes p
         USING pg_catalog.jsonb_array_elements_text(coalesce(p_payload->'deleted_probes', '[]'::jsonb)) AS d(id)
         WHERE p.id = d.id::bigint RETURNING 1)
    SELECT count(*) INTO n_dp FROM gone;
    WITH gone AS (
        DELETE FROM signal_history.observations o
         USING pg_catalog.jsonb_array_elements_text(coalesce(p_payload->'deleted_observations', '[]'::jsonb)) AS d(id)
         WHERE o.id = d.id::bigint RETURNING 1)
    SELECT count(*) INTO n_do FROM gone;
    WITH ins AS (
        INSERT INTO signal_history.probes
            (id, url, ts, live, payable, invocable, latency_ms, payto, amount, miss_reason, rail,
             schema_present, settled_route_observation, trust_class, traffic_class)
        SELECT x.id, x.url, x.ts, coalesce(x.live, 0), coalesce(x.payable, 0), coalesce(x.invocable, 0),
               x.latency_ms, x.payto, x.amount, x.miss_reason, x.rail, x.schema_present,
               coalesce(x.settled_route_observation, 1), coalesce(x.trust_class, 'INDEPENDENT'),
               coalesce(x.traffic_class, 'unclassified')
          FROM pg_catalog.jsonb_to_recordset(coalesce(p_payload->'probes', '[]'::jsonb)) AS x(
               id BIGINT, url TEXT, ts BIGINT, live INTEGER, payable INTEGER, invocable INTEGER,
               latency_ms INTEGER, payto TEXT, amount TEXT, miss_reason TEXT, rail TEXT,
               schema_present INTEGER, settled_route_observation INTEGER, trust_class TEXT, traffic_class TEXT)
        ON CONFLICT (id) DO UPDATE SET
            url = EXCLUDED.url, ts = EXCLUDED.ts, live = EXCLUDED.live, payable = EXCLUDED.payable,
            invocable = EXCLUDED.invocable, latency_ms = EXCLUDED.latency_ms, payto = EXCLUDED.payto,
            amount = EXCLUDED.amount, miss_reason = EXCLUDED.miss_reason, rail = EXCLUDED.rail,
            schema_present = EXCLUDED.schema_present,
            settled_route_observation = EXCLUDED.settled_route_observation,
            trust_class = EXCLUDED.trust_class, traffic_class = EXCLUDED.traffic_class
        RETURNING 1)
    SELECT count(*) INTO n_probes FROM ins;
    WITH ins AS (
        INSERT INTO signal_history.observations
            (id, probe_id, batch_id, source_type, source, rail, url, field, value, status, ts, trust_class)
        SELECT x.id, x.probe_id, x.batch_id, x.source_type, x.source, x.rail, x.url, x.field, x.value,
               x.status, x.ts, x.trust_class
          FROM pg_catalog.jsonb_to_recordset(coalesce(p_payload->'observations', '[]'::jsonb)) AS x(
               id BIGINT, probe_id BIGINT, batch_id TEXT, source_type TEXT, source TEXT, rail TEXT,
               url TEXT, field TEXT, value TEXT, status TEXT, ts BIGINT, trust_class TEXT)
        ON CONFLICT (id) DO UPDATE SET
            probe_id = EXCLUDED.probe_id, batch_id = EXCLUDED.batch_id, source_type = EXCLUDED.source_type,
            source = EXCLUDED.source, rail = EXCLUDED.rail, url = EXCLUDED.url, field = EXCLUDED.field,
            value = EXCLUDED.value, status = EXCLUDED.status, ts = EXCLUDED.ts, trust_class = EXCLUDED.trust_class
        RETURNING 1)
    SELECT count(*) INTO n_obs FROM ins;
    WITH ins AS (
        INSERT INTO signal_history.url_state
            (url, last_payto, last_amount, schema_present, payto_changed_at, price_changed_at,
             schema_changed_at, last_checked, last_success_402, pending_payto, last_trusted_ts)
        SELECT x.url, x.last_payto, x.last_amount, x.schema_present, x.payto_changed_at, x.price_changed_at,
               x.schema_changed_at, x.last_checked, x.last_success_402, x.pending_payto, x.last_trusted_ts
          FROM pg_catalog.jsonb_to_recordset(coalesce(p_payload->'url_state', '[]'::jsonb)) AS x(
               url TEXT, last_payto TEXT, last_amount TEXT, schema_present INTEGER, payto_changed_at BIGINT,
               price_changed_at BIGINT, schema_changed_at BIGINT, last_checked BIGINT, last_success_402 BIGINT,
               pending_payto TEXT, last_trusted_ts BIGINT)
        ON CONFLICT (url) DO UPDATE SET
            last_payto = EXCLUDED.last_payto, last_amount = EXCLUDED.last_amount,
            schema_present = EXCLUDED.schema_present, payto_changed_at = EXCLUDED.payto_changed_at,
            price_changed_at = EXCLUDED.price_changed_at, schema_changed_at = EXCLUDED.schema_changed_at,
            last_checked = EXCLUDED.last_checked, last_success_402 = EXCLUDED.last_success_402,
            pending_payto = EXCLUDED.pending_payto, last_trusted_ts = EXCLUDED.last_trusted_ts
        RETURNING 1)
    SELECT count(*) INTO n_state FROM ins;
    WITH ins AS (
        INSERT INTO signal_history.sealed_batches (batch_id, sealed_at)
        SELECT x.batch_id, x.sealed_at
          FROM pg_catalog.jsonb_to_recordset(coalesce(p_payload->'sealed', '[]'::jsonb)) AS x(batch_id TEXT, sealed_at BIGINT)
        ON CONFLICT (batch_id) DO NOTHING RETURNING 1)
    SELECT count(*) INTO n_sealed FROM ins;
    WITH ins AS (
        INSERT INTO signal_history.scoring_models (model_id, model_hash, effective_ts, spec_json, recorded_at)
        SELECT x.model_id, x.model_hash, x.effective_ts, x.spec_json, x.recorded_at
          FROM pg_catalog.jsonb_to_recordset(coalesce(p_payload->'scoring_models', '[]'::jsonb)) AS x(
               model_id TEXT, model_hash TEXT, effective_ts BIGINT, spec_json TEXT, recorded_at BIGINT)
        ON CONFLICT (model_id, model_hash) DO NOTHING RETURNING 1)
    SELECT count(*) INTO n_models FROM ins;
    RETURN QUERY SELECT n_probes, n_obs, n_state, n_dp, n_do, n_sealed, n_models;
END;
$$;

CREATE OR REPLACE FUNCTION signal_history.api_meta_set(p_key TEXT, p_value TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    PERFORM signal_history.guard();
    INSERT INTO signal_history.replica_meta (key, value, updated_at)
    VALUES (p_key, p_value, pg_catalog.clock_timestamp())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = pg_catalog.clock_timestamp();
END;
$$;

COMMIT;
