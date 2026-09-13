-- Shared session store on the managed replay PostgreSQL.
--
-- Hosted windows, issued check credits, the private counters and payer days,
-- and alert subscriptions with their deliveries move here from the per-machine
-- SQLite file so that a second router machine finds the same window, credit
-- or subscription. The observation cache stays per machine.
--
-- Fly Managed Postgres rejects GRANT and REVOKE, so this file keeps
-- PostgreSQL's default PUBLIC EXECUTE on its functions and every write
-- function refuses every login except the replay runtime login pinned in
-- signal_replay.runtime_policy, the model the replay and lease functions use.
-- The runtime login reads the tables through its read-all role and cannot
-- write them directly; a broadened runtime login fences every write.
--
-- Install as the replay migration owner AFTER ops/replay-postgres-functions.sql.
-- Additive: no writer stop. Nothing changes at runtime until
-- LIVE402_SESSION_BACKEND=postgres. Re-running the file is harmless.
--
-- No column here holds a wallet, a payer address, a request or a response
-- body: windows keep the public offer the buyer already received, credits and
-- payer days are SHA-256 digests, alert secrets are the per-subscription
-- signing secrets the customer was shown once.

BEGIN;

DO $$
BEGIN
    IF pg_catalog.to_regclass('signal_replay.runtime_policy') IS NULL THEN
        RAISE EXCEPTION 'install ops/replay-postgres-functions.sql first';
    END IF;
END;
$$;

CREATE SCHEMA IF NOT EXISTS signal_session;

CREATE TABLE IF NOT EXISTS signal_session.windows (
    id_hash TEXT PRIMARY KEY CHECK (id_hash ~ '^[0-9a-f]{64}$'),
    created_at BIGINT NOT NULL CHECK (created_at >= 0),
    expires_at BIGINT NOT NULL CHECK (expires_at >= 0),
    observed_at BIGINT NOT NULL CHECK (observed_at >= 0),
    hop_count INTEGER NOT NULL DEFAULT 0 CHECK (hop_count >= 0),
    hop_ceiling INTEGER NOT NULL DEFAULT 20 CHECK (hop_ceiling BETWEEN 1 AND 1000),
    url TEXT CHECK (url IS NULL OR length(url) <= 2048),
    rail TEXT CHECK (rail IS NULL OR length(rail) <= 64),
    scheme TEXT CHECK (scheme IS NULL OR length(scheme) <= 64),
    fingerprint TEXT NOT NULL CHECK (length(fingerprint) <= 128),
    mandate_hash TEXT CHECK (mandate_hash IS NULL OR mandate_hash ~ '^[0-9a-f]{64}$'),
    offer_json TEXT NOT NULL CHECK (octet_length(offer_json) <= 262144),
    traffic_class TEXT CHECK (traffic_class IS NULL OR length(traffic_class) <= 32),
    trial_hash TEXT CHECK (trial_hash IS NULL OR trial_hash ~ '^[0-9a-f]{64}$'),
    sku TEXT CHECK (sku IS NULL OR length(sku) <= 32)
);
CREATE INDEX IF NOT EXISTS windows_expires ON signal_session.windows(expires_at);
CREATE INDEX IF NOT EXISTS windows_created ON signal_session.windows(created_at);

CREATE TABLE IF NOT EXISTS signal_session.trial_credits (
    token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    created_at BIGINT NOT NULL CHECK (created_at >= 0),
    expires_at BIGINT NOT NULL CHECK (expires_at >= 0),
    opens_used INTEGER NOT NULL DEFAULT 0 CHECK (opens_used >= 0),
    open_ceiling INTEGER NOT NULL DEFAULT 5 CHECK (open_ceiling BETWEEN 1 AND 1000)
);

CREATE TABLE IF NOT EXISTS signal_session.metric_counters (
    day TEXT NOT NULL CHECK (day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
    n BIGINT NOT NULL DEFAULT 0 CHECK (n >= 0),
    PRIMARY KEY (day, name)
);

CREATE TABLE IF NOT EXISTS signal_session.payer_days (
    day TEXT NOT NULL CHECK (day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    payer_hash TEXT NOT NULL CHECK (payer_hash ~ '^[0-9a-f]{64}$'),
    traffic TEXT NOT NULL DEFAULT 'unclassified' CHECK (length(traffic) BETWEEN 1 AND 32),
    PRIMARY KEY (day, payer_hash)
);

CREATE TABLE IF NOT EXISTS signal_session.alert_subscriptions (
    id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{16}$'),
    owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 128),
    url TEXT NOT NULL CHECK (length(url) BETWEEN 1 AND 512),
    hosts_json TEXT NOT NULL CHECK (octet_length(hosts_json) <= 8192),
    events_json TEXT NOT NULL CHECK (octet_length(events_json) <= 256),
    secret TEXT NOT NULL CHECK (length(secret) BETWEEN 1 AND 128),
    created_at BIGINT NOT NULL CHECK (created_at >= 0),
    cursor_ts BIGINT NOT NULL CHECK (cursor_ts >= 0),
    state_json TEXT NOT NULL DEFAULT '{}' CHECK (octet_length(state_json) <= 1048576),
    last_delivery_at BIGINT,
    last_status INTEGER,
    failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
    next_attempt_at BIGINT NOT NULL DEFAULT 0 CHECK (next_attempt_at >= 0),
    disabled_at BIGINT,
    disabled_reason TEXT CHECK (disabled_reason IS NULL OR length(disabled_reason) <= 64)
);
CREATE INDEX IF NOT EXISTS alert_subscriptions_owner ON signal_session.alert_subscriptions(owner);

CREATE TABLE IF NOT EXISTS signal_session.alert_deliveries (
    id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{16}$'),
    subscription_id TEXT NOT NULL CHECK (subscription_id ~ '^[0-9a-f]{16}$'),
    ts BIGINT NOT NULL CHECK (ts >= 0),
    kind TEXT NOT NULL CHECK (kind IN ('alerts', 'ping')),
    status INTEGER,
    events INTEGER NOT NULL DEFAULT 0 CHECK (events >= 0),
    error TEXT CHECK (error IS NULL OR length(error) <= 128)
);
CREATE INDEX IF NOT EXISTS alert_deliveries_sub_ts ON signal_session.alert_deliveries(subscription_id, ts);

-- One row per SQLite file that was copied in, so the copy runs exactly once.
CREATE TABLE IF NOT EXISTS signal_session.imports (
    source TEXT PRIMARY KEY CHECK (length(source) BETWEEN 1 AND 128),
    imported_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    rows_json TEXT NOT NULL CHECK (octet_length(rows_json) <= 4096)
);

-- Every write function starts here: exact runtime login, no direct write
-- rights on the schema for that login or any role it can reach.
CREATE OR REPLACE FUNCTION signal_session.guard()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM signal_replay.runtime_policy p
                   WHERE p.singleton AND p.runtime_login = session_user::text) THEN
        RAISE EXCEPTION 'session store unavailable';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN pg_catalog.pg_roles r
        WHERE n.nspname = 'signal_session' AND c.relkind = 'r'
          AND (r.rolname = session_user OR pg_catalog.pg_has_role(session_user, r.oid, 'MEMBER'))
          AND (pg_catalog.has_table_privilege(r.oid, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
               OR pg_catalog.has_any_column_privilege(r.oid, c.oid, 'INSERT,UPDATE')
               OR r.oid = c.relowner
               OR pg_catalog.has_schema_privilege(r.oid, n.oid, 'CREATE'))) THEN
        RAISE EXCEPTION 'session store unavailable';
    END IF;
END;
$$;

-- Windows -------------------------------------------------------------------

CREATE OR REPLACE FUNCTION signal_session.api_window_open(
    p_id_hash TEXT, p_created_at BIGINT, p_expires_at BIGINT, p_hop_ceiling INTEGER,
    p_url TEXT, p_rail TEXT, p_scheme TEXT, p_fingerprint TEXT, p_mandate_hash TEXT,
    p_offer_json TEXT, p_traffic_class TEXT, p_trial_hash TEXT, p_sku TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    PERFORM signal_session.guard();
    INSERT INTO signal_session.windows
        (id_hash, created_at, expires_at, observed_at, hop_count, hop_ceiling, url, rail, scheme,
         fingerprint, mandate_hash, offer_json, traffic_class, trial_hash, sku)
    VALUES (p_id_hash, p_created_at, p_expires_at, p_created_at, 0, p_hop_ceiling, p_url, p_rail, p_scheme,
            p_fingerprint, p_mandate_hash, p_offer_json, p_traffic_class, p_trial_hash, p_sku);
END;
$$;

-- One hop. Returns the new hop count, or NULL when the window is unknown,
-- expired or spent (the caller answers window_spent and never retries).
CREATE OR REPLACE FUNCTION signal_session.api_window_hop(p_id_hash TEXT, p_now BIGINT)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE new_count INTEGER;
BEGIN
    PERFORM signal_session.guard();
    UPDATE signal_session.windows SET hop_count = hop_count + 1
     WHERE id_hash = p_id_hash AND hop_count < hop_ceiling AND expires_at >= p_now
     RETURNING hop_count INTO new_count;
    RETURN new_count;
END;
$$;

-- Check credits ---------------------------------------------------------------

-- Re-issuing refreshes the expiry and can only raise the ceiling; the opens
-- already used are never reset (an operator top-up, not a new credit).
CREATE OR REPLACE FUNCTION signal_session.api_trial_issue(
    p_token_hash TEXT, p_now BIGINT, p_expires_at BIGINT, p_ceiling INTEGER)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    PERFORM signal_session.guard();
    INSERT INTO signal_session.trial_credits (token_hash, created_at, expires_at, opens_used, open_ceiling)
    VALUES (p_token_hash, p_now, p_expires_at, 0, p_ceiling)
    ON CONFLICT (token_hash) DO UPDATE
        SET expires_at = EXCLUDED.expires_at,
            open_ceiling = GREATEST(signal_session.trial_credits.open_ceiling, EXCLUDED.open_ceiling);
END;
$$;

CREATE OR REPLACE FUNCTION signal_session.api_trial_consume(p_token_hash TEXT, p_now BIGINT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    PERFORM signal_session.guard();
    UPDATE signal_session.trial_credits SET opens_used = opens_used + 1
     WHERE token_hash = p_token_hash AND expires_at >= p_now AND opens_used < open_ceiling;
    RETURN FOUND;
END;
$$;

-- Private counters and payer days --------------------------------------------

CREATE OR REPLACE FUNCTION signal_session.api_counter_add(p_day TEXT, p_name TEXT, p_n BIGINT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    PERFORM signal_session.guard();
    IF p_n IS NULL OR p_n <= 0 THEN
        RAISE EXCEPTION 'invalid session operation';
    END IF;
    INSERT INTO signal_session.metric_counters (day, name, n) VALUES (p_day, p_name, p_n)
    ON CONFLICT (day, name) DO UPDATE SET n = signal_session.metric_counters.n + EXCLUDED.n;
END;
$$;

-- True the first time a payer digest is seen on a day.
CREATE OR REPLACE FUNCTION signal_session.api_payer_record(p_day TEXT, p_payer_hash TEXT, p_traffic TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    PERFORM signal_session.guard();
    INSERT INTO signal_session.payer_days (day, payer_hash, traffic) VALUES (p_day, p_payer_hash, p_traffic)
    ON CONFLICT (day, payer_hash) DO NOTHING;
    RETURN FOUND;
END;
$$;

-- Alert subscriptions ---------------------------------------------------------

-- False when the owner already holds p_max subscriptions (the caller answers
-- too_many_subscriptions). The per-owner lock makes the count exact.
CREATE OR REPLACE FUNCTION signal_session.api_alert_sub_create(
    p_id TEXT, p_owner TEXT, p_url TEXT, p_hosts_json TEXT, p_events_json TEXT, p_secret TEXT,
    p_ts BIGINT, p_state_json TEXT, p_max INTEGER)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE held INTEGER;
BEGIN
    PERFORM signal_session.guard();
    IF p_max IS NULL OR p_max < 1 THEN
        RAISE EXCEPTION 'invalid session operation';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('signal_session.alert_subscriptions:' || p_owner));
    SELECT count(*) INTO held FROM signal_session.alert_subscriptions WHERE owner = p_owner;
    IF held >= p_max THEN
        RETURN FALSE;
    END IF;
    INSERT INTO signal_session.alert_subscriptions
        (id, owner, url, hosts_json, events_json, secret, created_at, cursor_ts, state_json)
    VALUES (p_id, p_owner, p_url, p_hosts_json, p_events_json, p_secret, p_ts, p_ts, p_state_json);
    RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION signal_session.api_alert_sub_cursor(p_id TEXT, p_cursor_ts BIGINT, p_state_json TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    PERFORM signal_session.guard();
    UPDATE signal_session.alert_subscriptions SET cursor_ts = p_cursor_ts, state_json = p_state_json
     WHERE id = p_id AND disabled_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION signal_session.api_alert_sub_delivered(
    p_id TEXT, p_ts BIGINT, p_status INTEGER, p_cursor_ts BIGINT, p_state_json TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    PERFORM signal_session.guard();
    UPDATE signal_session.alert_subscriptions
       SET failures = 0, next_attempt_at = 0, last_delivery_at = p_ts, last_status = p_status,
           disabled_at = NULL, disabled_reason = NULL,
           cursor_ts = coalesce(p_cursor_ts, cursor_ts),
           state_json = coalesce(p_state_json, state_json)
     WHERE id = p_id;
END;
$$;

CREATE OR REPLACE FUNCTION signal_session.api_alert_sub_failed(
    p_id TEXT, p_failures INTEGER, p_next_attempt_at BIGINT, p_status INTEGER, p_disabled_at BIGINT, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    PERFORM signal_session.guard();
    UPDATE signal_session.alert_subscriptions
       SET failures = p_failures, next_attempt_at = p_next_attempt_at, last_status = p_status,
           disabled_at = coalesce(disabled_at, p_disabled_at),
           disabled_reason = coalesce(disabled_reason, p_reason)
     WHERE id = p_id;
END;
$$;

CREATE OR REPLACE FUNCTION signal_session.api_alert_sub_delete(p_id TEXT, p_owner TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    PERFORM signal_session.guard();
    IF NOT EXISTS (SELECT 1 FROM signal_session.alert_subscriptions WHERE id = p_id AND owner = p_owner) THEN
        RETURN FALSE;
    END IF;
    DELETE FROM signal_session.alert_deliveries WHERE subscription_id = p_id;
    DELETE FROM signal_session.alert_subscriptions WHERE id = p_id AND owner = p_owner;
    RETURN FOUND;
END;
$$;

-- Record one delivery attempt and keep only the newest p_keep per subscription.
CREATE OR REPLACE FUNCTION signal_session.api_alert_delivery_add(
    p_id TEXT, p_subscription_id TEXT, p_ts BIGINT, p_kind TEXT, p_status INTEGER, p_events INTEGER,
    p_error TEXT, p_keep INTEGER)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    PERFORM signal_session.guard();
    IF p_keep IS NULL OR p_keep < 1 THEN
        RAISE EXCEPTION 'invalid session operation';
    END IF;
    INSERT INTO signal_session.alert_deliveries (id, subscription_id, ts, kind, status, events, error)
    VALUES (p_id, p_subscription_id, p_ts, p_kind, p_status, p_events, p_error);
    DELETE FROM signal_session.alert_deliveries d
     WHERE d.subscription_id = p_subscription_id
       AND d.id NOT IN (SELECT k.id FROM signal_session.alert_deliveries k
                         WHERE k.subscription_id = p_subscription_id
                         ORDER BY k.ts DESC, k.id DESC LIMIT p_keep);
END;
$$;

CREATE OR REPLACE FUNCTION signal_session.api_alert_deliveries_prune(p_before BIGINT)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE removed BIGINT;
BEGIN
    PERFORM signal_session.guard();
    WITH gone AS (DELETE FROM signal_session.alert_deliveries WHERE ts < p_before RETURNING 1)
    SELECT count(*) INTO removed FROM gone;
    RETURN removed;
END;
$$;

-- Housekeeping ----------------------------------------------------------------

CREATE OR REPLACE FUNCTION signal_session.api_prune(
    p_now BIGINT, p_window_grace BIGINT, p_trial_grace BIGINT, p_cutoff_day TEXT)
RETURNS TABLE (windows BIGINT, trial_credits BIGINT, metric_counters BIGINT, payer_days BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w BIGINT; t BIGINT; m BIGINT; p BIGINT;
BEGIN
    PERFORM signal_session.guard();
    WITH gone AS (DELETE FROM signal_session.windows WHERE expires_at < p_now - p_window_grace RETURNING 1)
    SELECT count(*) INTO w FROM gone;
    WITH gone AS (DELETE FROM signal_session.trial_credits WHERE expires_at < p_now - p_trial_grace RETURNING 1)
    SELECT count(*) INTO t FROM gone;
    WITH gone AS (DELETE FROM signal_session.metric_counters WHERE day < p_cutoff_day RETURNING 1)
    SELECT count(*) INTO m FROM gone;
    WITH gone AS (DELETE FROM signal_session.payer_days WHERE day < p_cutoff_day RETURNING 1)
    SELECT count(*) INTO p FROM gone;
    RETURN QUERY SELECT w, t, m, p;
END;
$$;

-- One-time copy of a machine's SQLite session state. The source id is written
-- into the SQLite file before the call, so a machine recreated on the same
-- volume presents the same id and the copy never runs twice. All or nothing.
CREATE OR REPLACE FUNCTION signal_session.api_import(p_source TEXT, p_payload JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n_windows BIGINT; n_trials BIGINT; n_counters BIGINT; n_payers BIGINT; n_subs BIGINT; n_deliveries BIGINT;
BEGIN
    PERFORM signal_session.guard();
    IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object' THEN
        RAISE EXCEPTION 'invalid session operation';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('signal_session.imports'));
    IF EXISTS (SELECT 1 FROM signal_session.imports WHERE source = p_source) THEN
        RETURN FALSE;
    END IF;
    WITH ins AS (
        INSERT INTO signal_session.windows
            (id_hash, created_at, expires_at, observed_at, hop_count, hop_ceiling, url, rail, scheme,
             fingerprint, mandate_hash, offer_json, traffic_class, trial_hash, sku)
        SELECT x.id_hash, x.created_at, x.expires_at, x.observed_at, x.hop_count, x.hop_ceiling, x.url, x.rail,
               x.scheme, x.fingerprint, x.mandate_hash, x.offer_json, x.traffic_class, x.trial_hash, x.sku
          FROM pg_catalog.jsonb_to_recordset(coalesce(p_payload->'windows', '[]'::jsonb)) AS x(
               id_hash TEXT, created_at BIGINT, expires_at BIGINT, observed_at BIGINT, hop_count INTEGER,
               hop_ceiling INTEGER, url TEXT, rail TEXT, scheme TEXT, fingerprint TEXT, mandate_hash TEXT,
               offer_json TEXT, traffic_class TEXT, trial_hash TEXT, sku TEXT)
        ON CONFLICT (id_hash) DO NOTHING RETURNING 1)
    SELECT count(*) INTO n_windows FROM ins;
    WITH ins AS (
        INSERT INTO signal_session.trial_credits (token_hash, created_at, expires_at, opens_used, open_ceiling)
        SELECT x.token_hash, x.created_at, x.expires_at, x.opens_used, x.open_ceiling
          FROM pg_catalog.jsonb_to_recordset(coalesce(p_payload->'trial_credits', '[]'::jsonb)) AS x(
               token_hash TEXT, created_at BIGINT, expires_at BIGINT, opens_used INTEGER, open_ceiling INTEGER)
        ON CONFLICT (token_hash) DO UPDATE
            SET expires_at = GREATEST(signal_session.trial_credits.expires_at, EXCLUDED.expires_at),
                opens_used = GREATEST(signal_session.trial_credits.opens_used, EXCLUDED.opens_used),
                open_ceiling = GREATEST(signal_session.trial_credits.open_ceiling, EXCLUDED.open_ceiling)
        RETURNING 1)
    SELECT count(*) INTO n_trials FROM ins;
    WITH ins AS (
        INSERT INTO signal_session.metric_counters (day, name, n)
        SELECT x.day, x.name, x.n
          FROM pg_catalog.jsonb_to_recordset(coalesce(p_payload->'metric_counters', '[]'::jsonb)) AS x(
               day TEXT, name TEXT, n BIGINT)
         WHERE x.n > 0
        ON CONFLICT (day, name) DO UPDATE SET n = signal_session.metric_counters.n + EXCLUDED.n
        RETURNING 1)
    SELECT count(*) INTO n_counters FROM ins;
    WITH ins AS (
        INSERT INTO signal_session.payer_days (day, payer_hash, traffic)
        SELECT x.day, x.payer_hash, x.traffic
          FROM pg_catalog.jsonb_to_recordset(coalesce(p_payload->'payer_days', '[]'::jsonb)) AS x(
               day TEXT, payer_hash TEXT, traffic TEXT)
        ON CONFLICT (day, payer_hash) DO NOTHING RETURNING 1)
    SELECT count(*) INTO n_payers FROM ins;
    WITH ins AS (
        INSERT INTO signal_session.alert_subscriptions
            (id, owner, url, hosts_json, events_json, secret, created_at, cursor_ts, state_json,
             last_delivery_at, last_status, failures, next_attempt_at, disabled_at, disabled_reason)
        SELECT x.id, x.owner, x.url, x.hosts_json, x.events_json, x.secret, x.created_at, x.cursor_ts,
               coalesce(x.state_json, '{}'), x.last_delivery_at, x.last_status, coalesce(x.failures, 0),
               coalesce(x.next_attempt_at, 0), x.disabled_at, x.disabled_reason
          FROM pg_catalog.jsonb_to_recordset(coalesce(p_payload->'alert_subscriptions', '[]'::jsonb)) AS x(
               id TEXT, owner TEXT, url TEXT, hosts_json TEXT, events_json TEXT, secret TEXT, created_at BIGINT,
               cursor_ts BIGINT, state_json TEXT, last_delivery_at BIGINT, last_status INTEGER, failures INTEGER,
               next_attempt_at BIGINT, disabled_at BIGINT, disabled_reason TEXT)
        ON CONFLICT (id) DO NOTHING RETURNING 1)
    SELECT count(*) INTO n_subs FROM ins;
    WITH ins AS (
        INSERT INTO signal_session.alert_deliveries (id, subscription_id, ts, kind, status, events, error)
        SELECT x.id, x.subscription_id, x.ts, x.kind, x.status, coalesce(x.events, 0), x.error
          FROM pg_catalog.jsonb_to_recordset(coalesce(p_payload->'alert_deliveries', '[]'::jsonb)) AS x(
               id TEXT, subscription_id TEXT, ts BIGINT, kind TEXT, status INTEGER, events INTEGER, error TEXT)
        ON CONFLICT (id) DO NOTHING RETURNING 1)
    SELECT count(*) INTO n_deliveries FROM ins;
    INSERT INTO signal_session.imports (source, rows_json) VALUES (p_source, pg_catalog.format(
        '{"windows":%s,"trial_credits":%s,"metric_counters":%s,"payer_days":%s,"alert_subscriptions":%s,"alert_deliveries":%s}',
        n_windows, n_trials, n_counters, n_payers, n_subs, n_deliveries));
    RETURN TRUE;
END;
$$;

COMMIT;
