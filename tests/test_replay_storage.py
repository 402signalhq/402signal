"""Adapter security/functionality contracts; no live sellers or payments."""
import hashlib
import multiprocessing
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from live402.replay_store import SQLiteStore, StoreError, backend_name
from live402.replay_postgres import PostgresStore, validate_settings
from scripts.replay_migrate import normalized, digest_rows, migrate

SCHEMA = '''CREATE TABLE settle_ledger (
fp_hash TEXT UNIQUE,state TEXT,outcome_json TEXT,created_at REAL,
fingerprint_version INTEGER,scope_hash TEXT,expires_at REAL);
CREATE TABLE replay_meta(key TEXT PRIMARY KEY,value TEXT);'''
KEY = 'a' * 64
SCOPE = 'b' * 64
AUTHORITY = 'c' * 32


def sqlite_adapter(path, maximum=100):
    conn = sqlite3.connect(path, timeout=3.0)
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA synchronous=FULL')
    adapter = SQLiteStore(lambda: conn,
        lambda c: c.execute('SELECT count(*) FROM settle_ledger').fetchone()[0] < maximum,
        lambda c: not c.execute("SELECT 1 FROM replay_meta WHERE key='external_authority_id'").fetchone(),
        lambda: True)
    return conn, adapter


def sqlite_contender(path, event, queue):
    conn, adapter = sqlite_adapter(path)
    event.wait(5)
    try:
        queue.put(adapter.reserve(KEY, SCOPE, time.time()+120))
    except sqlite3.IntegrityError:
        queue.put(False)
    finally:
        conn.close()


def pg_contender(settings, event, queue):
    adapter = PostgresStore(environ=settings)
    event.wait(5)
    try:
        queue.put(adapter.reserve(KEY, SCOPE, time.time()+120))
    except StoreError:
        queue.put(False)
    finally:
        adapter.close()


class SQLiteContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.temp.name)/'replay.sqlite')
        self.conn, self.store = sqlite_adapter(self.path)
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        self.temp.cleanup()

    def test_committed_unique_reservation_survives_reconnect(self):
        self.assertTrue(self.store.reserve(KEY, SCOPE, time.time()+120))
        other, store = sqlite_adapter(self.path)
        try:
            with self.assertRaises(sqlite3.IntegrityError):
                store.reserve(KEY, SCOPE, time.time()+120)
            self.assertEqual(store.lookup(KEY)[0], 'settlement_pending')
        finally:
            other.close()

    def test_cross_process_duplicate_has_one_winner(self):
        ctx = multiprocessing.get_context('spawn')
        event, queue = ctx.Event(), ctx.Queue()
        jobs = [ctx.Process(target=sqlite_contender, args=(self.path,event,queue)) for _ in range(4)]
        for job in jobs:
            job.start()
        event.set()
        results = [queue.get(timeout=15) for _ in jobs]
        for job in jobs:
            job.join(timeout=5)
            self.assertEqual(job.exitcode, 0)
        self.assertEqual(results.count(True), 1)

    def test_capacity_refuses_without_deleting_identity(self):
        self.store.capacity = lambda c: False
        self.assertFalse(self.store.reserve(KEY,SCOPE,time.time()+120))
        self.assertIsNone(self.store.lookup(KEY))

    def test_source_fence_blocks_new_reservations(self):
        self.conn.execute("INSERT INTO replay_meta VALUES('external_authority_id',?)",(AUTHORITY,))
        self.conn.commit()
        self.assertFalse(self.store.reserve(KEY,SCOPE,time.time()+120))

    def test_unknown_is_retained_beyond_response_expiry(self):
        self.store.reserve(KEY,SCOPE,1)
        self.store.abandon(KEY)
        self.store.reserve('d'*64,SCOPE,time.time()+120)
        self.assertEqual(self.store.lookup(KEY)[0],'unknown')
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.reserve(KEY,SCOPE,time.time()+120)

    def test_anonymous_response_not_persisted(self):
        self.store.reserve(KEY,None,time.time()+120)
        self.store.finish(KEY,'settled','private response',True)
        self.assertIsNone(self.store.lookup(KEY)[1])

    def test_pre_economic_invalid_input_can_retry(self):
        self.store.reserve(KEY,SCOPE,time.time()+120)
        self.store.finish(KEY,'rejected',None,False)
        self.assertTrue(self.store.reserve(KEY,SCOPE,time.time()+120))

    def test_expiry_clears_response_only(self):
        self.store.reserve(KEY,SCOPE,1)
        self.store.finish(KEY,'settled','expired response',True)
        self.store.reserve('d'*64,SCOPE,time.time()+120)
        self.assertEqual(self.store.lookup(KEY)[:2],('settled',None))

    def test_lost_commit_ack_does_not_reopen_authorization(self):
        real = self.conn
        class LostAck:
            def __getattr__(self,name):
                return getattr(real,name)
            def commit(self):
                real.commit()
                raise sqlite3.OperationalError('simulated lost commit acknowledgement')
        self.store.connect = lambda: LostAck()
        with self.assertRaises(sqlite3.OperationalError):
            self.store.reserve(KEY,SCOPE,time.time()+120)
        self.store.connect = lambda: real
        self.assertEqual(self.store.lookup(KEY)[0],'settlement_pending')
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.reserve(KEY,SCOPE,time.time()+120)

    def test_sql_parameters_are_not_executed(self):
        evil = "'; DROP TABLE settle_ledger; --"
        self.assertTrue(self.store.reserve(evil,None,time.time()+120))
        self.assertEqual(self.conn.execute('SELECT count(*) FROM settle_ledger').fetchone()[0],1)


class ConfigurationContracts(unittest.TestCase):
    def config(self, **changes):
        values = {'host':'db.example','user':'router','dbname':'replay','password':'NEVER_LOG',
                  'sslmode':'verify-full'}
        values.update(changes)
        return values

    def settings(self, **changes):
        values = {'LIVE402_REPLAY_AUTHORITY_ID':AUTHORITY,'LIVE402_REPLAY_POSTGRES_DSN':'not logged'}
        values.update(changes)
        return values

    def test_unknown_backend_does_not_fall_back(self):
        for name in ('', 'POSTGRES', 'postgre', 'libsql'):
            with patch.dict(os.environ, {'LIVE402_REPLAY_BACKEND':name}):
                with self.assertRaises(StoreError):
                    backend_name()

    def test_certificate_verification_required(self):
        for mode in ('disable','prefer','require','verify-ca'):
            with self.assertRaises(StoreError):
                validate_settings(self.settings(),lambda _:self.config(sslmode=mode))

    def test_dsn_service_options_and_host_override_rejected(self):
        for key in ('service','hostaddr','options'):
            with self.assertRaises(StoreError):
                validate_settings(self.settings(),lambda _:self.config(**{key:'unsafe'}))

    def test_test_bypass_is_loopback_only_and_forbidden_on_fly(self):
        settings = self.settings(LIVE402_PG_TEST_SUPPORT='1')
        with self.assertRaises(StoreError):
            validate_settings(settings, lambda _:self.config(sslmode='disable'))
        self.assertEqual(validate_settings(settings,lambda _:self.config(host='127.0.0.1',sslmode='disable'))[1],AUTHORITY)
        with self.assertRaises(StoreError):
            validate_settings(dict(settings,FLY_APP_NAME='402signal'), lambda _:self.config(host='127.0.0.1',sslmode='disable'))

    def test_shared_backend_is_not_horizontal_log_permission(self):
        with self.assertRaises(StoreError):
            validate_settings(self.settings(LIVE402_ROUTER_WRITERS='2'),lambda _:self.config())

    def test_errors_do_not_include_credentials(self):
        with self.assertRaises(StoreError) as error:
            validate_settings(self.settings(),lambda _:(_ for _ in ()).throw(ValueError('NEVER_LOG')))
        self.assertNotIn('NEVER_LOG',str(error.exception))

    def test_missing_authority_refuses_empty_database_start(self):
        with self.assertRaises(StoreError):
            validate_settings(self.settings(LIVE402_REPLAY_AUTHORITY_ID=''),lambda _:self.config())

    def test_unsafe_host_and_port_rejected(self):
        for cfg in (self.config(host='/tmp/socket'),self.config(host='one,two'),self.config(port='0')):
            with self.assertRaises(StoreError):
                validate_settings(self.settings(),lambda _:cfg)


class MigrationContracts(unittest.TestCase):
    def test_expired_private_body_removed_not_economic_identity(self):
        row = normalized((KEY,'unknown','expired private bytes',1,2,SCOPE,2),3)
        self.assertEqual(row,(KEY,'unknown',None,1.0,2,SCOPE,2.0))

    def test_unexpired_response_window_blocks_cutover(self):
        with self.assertRaises(StoreError):
            normalized((KEY,'settled','private bytes',1,2,SCOPE,10),3)

    def test_invalid_timestamps_and_versions_block_cutover(self):
        for created in (None,True,float('nan'),float('inf'),-1):
            with self.assertRaises(StoreError):
                normalized((KEY,'settled',None,created,2,SCOPE,2),3)
        with self.assertRaises(StoreError):
            normalized((KEY,'settled',None,1,True,SCOPE,2),3)

    def test_digest_commits_states_scopes_and_every_identity(self):
        row = (KEY,'settled',None,1.0,2,SCOPE,2.0)
        self.assertNotEqual(digest_rows([row]),digest_rows([tuple([KEY,'unknown',*row[2:]])]))
        self.assertNotEqual(digest_rows([row]),digest_rows([row,row]))


@unittest.skipUnless(os.environ.get('LIVE402_PG_TEST_DESTRUCTIVE') == 'isolated-ci-only',
                     'requires explicitly isolated PostgreSQL CI database')
class PostgreSQLContracts(unittest.TestCase):
    def setUp(self):
        import psycopg
        from psycopg.conninfo import conninfo_to_dict
        self.settings = {'LIVE402_REPLAY_AUTHORITY_ID':AUTHORITY,
                         'LIVE402_REPLAY_POSTGRES_DSN':os.environ['LIVE402_PG_TEST_DSN'],
                         'LIVE402_PG_TEST_SUPPORT':'1'}
        config, _ = validate_settings(self.settings,conninfo_to_dict)
        if config['host'] != '127.0.0.1' or config['dbname'] != '402signal_ci':
            raise RuntimeError('refusing destructive tests outside loopback CI database')
        self.admin = psycopg.connect(**config,autocommit=True)
        self.admin.execute('DROP SCHEMA IF EXISTS signal_replay CASCADE')
        self.admin.execute((Path(__file__).resolve().parents[1]/'ops/replay-postgres.sql').read_text())
        self.admin.execute("INSERT INTO signal_replay.authority VALUES(TRUE,%s,1,TRUE,TRUE,0,1000,268435456,%s)",
                           (AUTHORITY,'0'*64))
        self.store = PostgresStore(environ=self.settings)

    def tearDown(self):
        self.store.close()
        self.admin.close()

    def test_ready_requires_active_matching_manifest(self):
        self.assertTrue(self.store.ready())
        self.admin.execute('UPDATE signal_replay.authority SET active=FALSE')
        self.assertFalse(self.store.ready())
        with self.assertRaises(StoreError):
            self.store.reserve(KEY,SCOPE,time.time()+120)

    def test_cross_process_duplicate_has_one_winner(self):
        ctx=multiprocessing.get_context('spawn')
        event,queue=ctx.Event(),ctx.Queue()
        jobs=[ctx.Process(target=pg_contender,args=(self.settings,event,queue)) for _ in range(4)]
        for job in jobs: job.start()
        event.set()
        results=[queue.get(timeout=15) for _ in jobs]
        for job in jobs:
            job.join(timeout=5)
            self.assertEqual(job.exitcode,0)
        self.assertEqual(results.count(True),1)
        self.assertEqual(self.admin.execute('SELECT admitted FROM signal_replay.authority').fetchone()[0],1)

    def test_pending_survives_lost_client_connection(self):
        self.assertTrue(self.store.reserve(KEY,SCOPE,time.time()+120))
        self.store.close()
        self.assertFalse(self.store.reserve(KEY,SCOPE,time.time()+120))
        self.assertEqual(self.store.lookup(KEY)[0],'settlement_pending')

    def test_unknown_never_reopens_after_expiry(self):
        self.store.reserve(KEY,SCOPE,1)
        self.store.abandon(KEY)
        self.store.prune_outcomes()
        self.assertFalse(self.store.reserve(KEY,SCOPE,time.time()+120))
        self.assertEqual(self.store.lookup(KEY)[0],'unknown')

    def test_capacity_rolls_back_new_admission(self):
        self.admin.execute('UPDATE signal_replay.authority SET max_rows=1')
        self.store.reserve(KEY,SCOPE,time.time()+120)
        with self.assertRaises(StoreError):
            self.store.reserve('d'*64,SCOPE,time.time()+120)
        self.assertIsNone(self.store.lookup('d'*64))
        self.assertFalse(self.store.ready())

    def test_pre_economic_release_keeps_retry_contract(self):
        self.store.reserve(KEY,SCOPE,time.time()+120)
        self.store.finish(KEY,'rejected',None,False)
        self.assertTrue(self.store.reserve(KEY,SCOPE,time.time()+120))
        self.assertEqual(self.admin.execute('SELECT admitted FROM signal_replay.authority').fetchone()[0],1)

    def test_private_body_requires_scope_and_is_pruned(self):
        self.store.reserve(KEY,None,time.time()+120)
        self.store.finish(KEY,'settled','secret body',True)
        self.assertIsNone(self.store.lookup(KEY)[1])
        self.store.reserve('d'*64,SCOPE,time.time()+120)
        self.store.finish('d'*64,'settled','private body',True)
        self.admin.execute('UPDATE signal_replay.entries SET expires_at=1')
        self.store.prune_outcomes()
        self.assertEqual(self.store.lookup('d'*64)[:2],('settled',None))
        self.assertEqual(self.admin.execute('SELECT count(*) FROM signal_replay.entries').fetchone()[0],2)

    def test_lost_commit_ack_never_returns_a_second_admission(self):
        from contextlib import contextmanager
        import psycopg
        real_connect = psycopg.connect
        class LostAckConnection:
            def __init__(self, conn):
                self.real = conn
            def __getattr__(self, name):
                return getattr(self.real, name)
            @contextmanager
            def transaction(self, **kwargs):
                with self.real.transaction(**kwargs):
                    yield
                raise psycopg.OperationalError('simulated lost acknowledgement after COMMIT')
        class Driver:
            used = False
            def connect(self, **kwargs):
                conn = real_connect(**kwargs)
                if not self.used:
                    self.used = True
                    return LostAckConnection(conn)
                return conn
        store = PostgresStore(environ=self.settings, driver=Driver())
        try:
            with self.assertRaises(StoreError):
                store.reserve(KEY,SCOPE,time.time()+120)
            self.assertFalse(store.reserve(KEY,SCOPE,time.time()+120))
            self.assertEqual(store.lookup(KEY)[0],'settlement_pending')
        finally:
            store.close()

    def test_runtime_role_cannot_change_identity_or_activate_database(self):
        # This test is inside the explicitly guarded loopback-only CI class.
        import psycopg
        from psycopg.conninfo import conninfo_to_dict, make_conninfo
        self.admin.execute('DROP ROLE IF EXISTS signal_replay_ci_runtime')
        self.admin.execute("CREATE ROLE signal_replay_ci_runtime LOGIN PASSWORD 'ci-role-only'")
        self.admin.execute('GRANT USAGE ON SCHEMA signal_replay TO signal_replay_ci_runtime')
        self.admin.execute('GRANT SELECT,INSERT,UPDATE,DELETE ON signal_replay.entries TO signal_replay_ci_runtime')
        self.admin.execute('GRANT SELECT ON signal_replay.authority TO signal_replay_ci_runtime')
        self.admin.execute('GRANT UPDATE(admitted) ON signal_replay.authority TO signal_replay_ci_runtime')
        cfg=conninfo_to_dict(self.settings['LIVE402_REPLAY_POSTGRES_DSN'])
        cfg.update(user='signal_replay_ci_runtime',password='ci-role-only')
        store=PostgresStore(environ=dict(self.settings,LIVE402_REPLAY_POSTGRES_DSN=make_conninfo(**cfg)))
        try:
            self.assertTrue(store.ready())
            self.assertTrue(store.reserve(KEY,SCOPE,time.time()+120))
            store.finish(KEY,'settled',None,True)
            self.assertEqual(store.lookup(KEY)[0],'settled')
            with psycopg.connect(**cfg,autocommit=True) as client:
                for statement in (
                    'UPDATE signal_replay.authority SET active=FALSE',
                    'UPDATE signal_replay.authority SET max_rows=99999999',
                    'TRUNCATE signal_replay.entries',
                    'DROP TABLE signal_replay.entries'):
                    with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                        client.execute(statement)
        finally:
            store.close()
            self.admin.execute('DROP OWNED BY signal_replay_ci_runtime')
            self.admin.execute('DROP ROLE signal_replay_ci_runtime')

    def _source(self, directory):
        path=Path(directory)/'source.sqlite'
        conn=sqlite3.connect(path)
        conn.executescript(SCHEMA)
        conn.execute('INSERT INTO settle_ledger VALUES(?,?,?,?,?,?,?)',(KEY,'unknown',None,1,2,SCOPE,2))
        conn.commit();conn.close()
        self.admin.execute('DROP SCHEMA signal_replay CASCADE')
        return path

    def test_migration_verifies_digest_then_fences_then_activates(self):
        with tempfile.TemporaryDirectory() as directory:
            source=self._source(directory)
            report=migrate(source,self.settings,apply=True,writers_stopped=True)
            self.assertTrue(report['source_fenced'] and report['target_active'])
            self.assertEqual(report['rows'],1)
            with sqlite3.connect(source) as conn:
                self.assertEqual(conn.execute("SELECT value FROM replay_meta WHERE key='external_authority_id'").fetchone()[0],AUTHORITY)
            self.assertEqual(self.store.lookup(KEY)[0],'unknown')
            self.assertFalse(self.store.reserve(KEY,SCOPE,time.time()+120))

    def test_crash_after_source_fence_leaves_both_sides_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            source=self._source(directory)
            def fault(stage):
                if stage == 'after_source_fence':
                    raise RuntimeError('simulated crash')
            with self.assertRaises(StoreError):
                migrate(source,self.settings,apply=True,writers_stopped=True,fault=fault)
            conn,adapter=sqlite_adapter(source)
            try:
                self.assertFalse(adapter.reserve('d'*64,SCOPE,time.time()+120))
            finally:
                conn.close()
            self.assertFalse(self.store.ready())
            self.assertEqual(self.admin.execute('SELECT count(*) FROM signal_replay.entries').fetchone()[0],1)

    def test_crash_before_source_fence_cannot_activate_partial_import(self):
        with tempfile.TemporaryDirectory() as directory:
            source=self._source(directory)
            def fault(stage):
                if stage == 'after_import_commit':
                    raise RuntimeError('simulated crash')
            with self.assertRaises(StoreError):
                migrate(source,self.settings,apply=True,writers_stopped=True,fault=fault)
            with sqlite3.connect(source) as conn:
                self.assertIsNone(conn.execute("SELECT value FROM replay_meta WHERE key='external_authority_id'").fetchone())
            self.assertFalse(self.store.ready())
            self.assertEqual(self.admin.execute('SELECT count(*) FROM signal_replay.entries').fetchone()[0],1)


if __name__ == '__main__':
    unittest.main()
