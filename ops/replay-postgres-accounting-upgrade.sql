-- Owner-only upgrade for an existing replay authority. Keep all router writers
-- stopped until this transaction AND the selected current schema script finish.
-- Explicit operator assertion required in this session:
-- SET live402.upgrade_writers_stopped = '1';
-- Then run this file and replay-postgres[-functions].sql before restarting.
-- No row, response, authority setting, or database-instance pin is replaced.
BEGIN;
SET LOCAL synchronous_commit = 'on';
SET LOCAL lock_timeout = '5000ms';
SET LOCAL statement_timeout = '60000ms';
DO $$ BEGIN
    IF current_setting('live402.upgrade_writers_stopped',true) IS DISTINCT FROM '1' THEN
        RAISE EXCEPTION 'stop all replay writers before accounting upgrade';
    END IF;
END $$;
LOCK TABLE signal_replay.authority,signal_replay.entries IN ACCESS EXCLUSIVE MODE;
ALTER TABLE signal_replay.authority ADD COLUMN IF NOT EXISTS outcome_bytes
    BIGINT NOT NULL DEFAULT 0 CHECK(outcome_bytes>=0);
DO $$ BEGIN
    IF (SELECT count(*) FROM signal_replay.authority)<>1
       OR (SELECT admitted FROM signal_replay.authority)<>(SELECT count(*) FROM signal_replay.entries) THEN
        RAISE EXCEPTION 'reconcile replay identity counts before accounting upgrade';
    END IF;
END $$;
UPDATE signal_replay.authority SET outcome_bytes=
    (SELECT coalesce(sum(octet_length(outcome_json)),0) FROM signal_replay.entries);
DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM signal_replay.authority WHERE admitted*512+outcome_bytes>max_bytes) THEN
        RAISE EXCEPTION 'operator must provision adequate logical quota before upgrade';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid='signal_replay.authority'::regclass AND conname='replay_logical_byte_quota') THEN
        ALTER TABLE signal_replay.authority ADD CONSTRAINT replay_logical_byte_quota
            CHECK(admitted*512+outcome_bytes<=max_bytes);
    END IF;
END $$;
COMMIT;
