"""Offline, one-way SQLite -> PostgreSQL replay migration. Dry-run by default.

Drain/stop all router writers and retain an off-host backup before --apply.
Short-lived private response bodies must have expired before cutover; every
permanent economic identity and pending/unknown state is retained. No payer,
receipt, DSN, credential, database row or exception detail is printed.
"""
from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import time
from itertools import islice

from live402.replay_store import StoreError
from live402.replay_postgres import STATES, validate_settings

COLUMNS = 'fp_hash,state,outcome_json,created_at,fingerprint_version,scope_hash,expires_at'
SCHEMA = Path(__file__).resolve().parents[1] / 'ops' / 'replay-postgres.sql'


def require_fence_aware_runtime(module):
    """Production apply must prove the imported runtime actually rejects a fence."""
    if not callable(getattr(module, '_store', None)):
        raise StoreError('runtime replay integration is absent')
    checker = getattr(module, '_identity_cutover_ready', None)
    if not callable(checker):
        raise StoreError('runtime replay fence is absent')
    with closing(sqlite3.connect(':memory:')) as probe:
        probe.executescript("CREATE TABLE settle_ledger (fingerprint_version INTEGER); "
                            "CREATE TABLE replay_meta (key TEXT PRIMARY KEY,value TEXT); "
                            "INSERT INTO replay_meta VALUES ('external_authority_id','fence-probe');")
        if checker(probe) is not False:
            raise StoreError('runtime does not honor the source migration fence')


def normalized(row, now):
    if len(row) != 7:
        raise StoreError('unsupported source row')
    key, state, outcome, created, version, scope, expires = row
    if not isinstance(key, str) or not re.fullmatch('[0-9a-f]{64}', key) or state not in STATES:
        raise StoreError('invalid source identity')
    if type(version) is not int or version not in (1, 2):
        raise StoreError('unsupported fingerprint version')
    if scope is not None and (not isinstance(scope, str) or not re.fullmatch('[0-9a-f]{64}', scope)):
        raise StoreError('invalid source scope')
    for value in (created, expires):
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))
                                  or not math.isfinite(value) or value < 0):
            raise StoreError('invalid source timestamp')
    if created is None:
        raise StoreError('missing creation timestamp')
    if outcome is not None and expires is not None and expires > now:
        raise StoreError('private response window has not expired; keep writers drained')
    return (key, state, None, float(created), version, scope, float(expires) if expires is not None else None)


def rows(conn, now):
    for row in conn.execute('SELECT ' + COLUMNS + ' FROM settle_ledger ORDER BY fp_hash'):
        yield normalized(row, now)


def digest_rows(values):
    count, digest = 0, hashlib.sha256()
    for row in values:
        digest.update(json.dumps(row, separators=(',', ':'), allow_nan=False).encode() + b'\n')
        count += 1
    return count, digest.hexdigest()


def migrate(source, environ, *, apply=False, writers_stopped=False, max_rows=1_000_000,
            max_bytes=268_435_456, fault=None):
    source = Path(source).resolve(strict=True)
    local_test = (environ.get('LIVE402_PG_TEST_SUPPORT') == '1' and not any(
        environ.get(k) for k in ('FLY_APP_NAME','FLY_ALLOC_ID','FLY_MACHINE_ID')))
    if apply and (not writers_stopped or (not local_test and str(source) != '/data/live402-replay.sqlite')):
        raise StoreError('apply requires drained writers and the authoritative volume ledger')
    if apply and not local_test:
        from live402 import replay
        require_fence_aware_runtime(replay)
    if type(max_rows) is not int or not 1 <= max_rows <= 10_000_000:
        raise StoreError('invalid row budget')
    if type(max_bytes) is not int or not 1048576 <= max_bytes <= 10 * 1024**3:
        raise StoreError('invalid storage budget')
    mode = 'rw' if apply else 'ro'
    conn = sqlite3.connect(source.as_uri() + '?mode=' + mode, uri=True, timeout=2.0)
    pg = None
    try:
        # Serialize the final inventory/fence with all SQLite reservations.
        if apply:
            conn.execute('PRAGMA synchronous=FULL')
        conn.execute('BEGIN IMMEDIATE' if apply else 'BEGIN')
        if conn.execute('PRAGMA quick_check').fetchone() != ('ok',):
            raise StoreError('source integrity check failed')
        if conn.execute("SELECT 1 FROM replay_meta WHERE key='external_authority_id'").fetchone():
            raise StoreError('source already fenced; inspect the existing authority, do not retry')
        now = time.time()
        count, digest = digest_rows(rows(conn, now))
        legacy = conn.execute('SELECT 1 FROM settle_ledger WHERE fingerprint_version < 2 LIMIT 1').fetchone()
        ack = conn.execute("SELECT 1 FROM replay_meta WHERE key='economic_fingerprint_v2_cutover'").fetchone()
        if legacy and not ack:
            raise StoreError('legacy fingerprint cutover is not acknowledged')
        if count >= max_rows:
            raise StoreError('destination admission budget has no headroom')
        result = dict(rows=count, digest=digest, source_fenced=False, target_active=False)
        if not apply:
            return result
        import psycopg
        from psycopg.conninfo import conninfo_to_dict
        config, authority = validate_settings(environ, conninfo_to_dict)
        pg = psycopg.connect(**config, autocommit=True, connect_timeout=2,
                             application_name='402signal-replay-migration')
        with pg.transaction():
            pg.execute("SET LOCAL synchronous_commit='on'")
            pg.execute("SET LOCAL statement_timeout='30000ms'")
            pg.execute("SET LOCAL lock_timeout='2000ms'")
            if pg.execute("SELECT NOT pg_is_in_recovery(),current_setting('fsync'),current_setting('full_page_writes')").fetchone() != (True,'on','on'):
                raise StoreError('destination is not a durable primary')
            pg.execute(SCHEMA.read_text())
            if pg.execute('SELECT 1 FROM signal_replay.authority').fetchone() or pg.execute('SELECT 1 FROM signal_replay.entries LIMIT 1').fetchone():
                raise StoreError('destination not empty; never overwrite or automatically retry import')
            iterator = iter(rows(conn, now))
            with pg.cursor() as cursor:
                while batch := list(islice(iterator, 1000)):
                    cursor.executemany('INSERT INTO signal_replay.entries (' + COLUMNS + ') VALUES (%s,%s,%s,%s,%s,%s,%s)', batch)
            with pg.cursor(name='migration_verify') as cursor:
                cursor.execute('SELECT ' + COLUMNS + ' FROM signal_replay.entries ORDER BY fp_hash')
                if digest_rows(cursor) != (count, digest):
                    raise StoreError('destination digest mismatch')
            if pg.execute("SELECT pg_total_relation_size('signal_replay.entries')").fetchone()[0] >= max_bytes - 262144:
                raise StoreError('destination byte budget has no headroom')
            pg.execute('INSERT INTO signal_replay.authority VALUES (TRUE,%s,1,FALSE,TRUE,%s,%s,%s,%s)',
                       (authority,count,max_rows,max_bytes,digest))
        if fault:
            fault('after_import_commit')
        conn.execute("INSERT INTO replay_meta(key,value) VALUES ('external_authority_id',?)", (authority,))
        conn.execute("INSERT INTO replay_meta(key,value) VALUES ('external_migration_digest',?)", (digest,))
        conn.commit()
        result['source_fenced'] = True
        if fault:
            fault('after_source_fence')
        with pg.transaction():
            pg.execute("SET LOCAL synchronous_commit='on'")
            changed = pg.execute('UPDATE signal_replay.authority SET active=TRUE WHERE singleton=TRUE '
                                 'AND authority_id=%s AND migration_digest=%s AND active=FALSE RETURNING active',
                                 (authority,digest)).fetchone()
            if changed != (True,):
                raise StoreError('activation failed; preserve both authorities for inspection')
        result['target_active'] = True
        return result
    except Exception:
        # This rollback cannot undo a previously committed source fence. That is
        # intentional: failure after fencing is unavailable, never double-active.
        conn.rollback()
        raise StoreError('migration not confirmed; preserve source and destination and inspect state') from None
    finally:
        conn.close()
        if pg is not None:
            pg.close()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', required=True)
    p.add_argument('--apply', action='store_true')
    p.add_argument('--writers-stopped', action='store_true')
    p.add_argument('--max-rows', type=int, default=1_000_000)
    p.add_argument('--max-bytes', type=int, default=268_435_456)
    args = p.parse_args()
    try:
        print(json.dumps(migrate(args.source, os.environ, apply=args.apply,
              writers_stopped=args.writers_stopped, max_rows=args.max_rows, max_bytes=args.max_bytes)))
    except (StoreError, OSError, ValueError):
        print(json.dumps({'ok': False, 'error': 'migration not confirmed; inspect retained authority state'}))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
