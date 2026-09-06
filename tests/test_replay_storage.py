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


    def test_repeated_queries_do_not_create_named_prepared_statements(self):
        self.assertTrue(self.store.reserve(KEY,SCOPE,time.time()+120))
        for _ in range(12):
            self.assertEqual(self.store.lookup(KEY)[0],'settlement_pending')
        self.assertEqual(self.store.conn.execute(
            'SELECT count(*) FROM pg_prepared_statements').fetchone()[0],0)

    def test_connection_age_recycles_busy_connection_without_reopening_identity(self):
        with patch('live402.replay_postgres.time.monotonic',return_value=1000.0) as clock:
            self.assertTrue(self.store.reserve(KEY,SCOPE,time.time()+120))
            first = self.store.conn
            first_pid = first.info.backend_pid
            for now in (1299.0,1599.0):
                clock.return_value = now
                self.assertEqual(self.store.lookup(KEY)[0],'settlement_pending')
                self.assertIs(self.store.conn,first)
            clock.return_value = 1600.0
            self.assertEqual(self.store.lookup(KEY)[0],'settlement_pending')
            self.assertTrue(first.closed)
            self.assertNotEqual(self.store.conn.info.backend_pid,first_pid)
            self.assertFalse(self.store.reserve(KEY,SCOPE,time.time()+120))

    def test_idle_connection_recycles_before_reuse(self):
        with patch('live402.replay_postgres.time.monotonic',return_value=1000.0) as clock:
            self.assertTrue(self.store.reserve(KEY,SCOPE,time.time()+120))
            first = self.store.conn
            clock.return_value = 1299.0
            self.assertEqual(self.store.lookup(KEY)[0],'settlement_pending')
            self.assertIs(self.store.conn,first)
            clock.return_value = 1599.0
            self.assertEqual(self.store.lookup(KEY)[0],'settlement_pending')
            self.assertTrue(first.closed)
            self.assertIsNot(self.store.conn,first)
            self.assertFalse(self.store.reserve(KEY,SCOPE,time.time()+120))

    def test_failed_connection_renewal_is_not_retried(self):
        import psycopg
        from types import SimpleNamespace
        from unittest.mock import Mock
        with patch('live402.replay_postgres.time.monotonic',return_value=1000.0) as clock:
            self.assertTrue(self.store.reserve(KEY,SCOPE,time.time()+120))
            first = self.store.conn
            clock.return_value = 1300.0
            connect = Mock(side_effect=psycopg.OperationalError('PRIVATE_DSN_DETAIL'))
            self.store.driver = SimpleNamespace(connect=connect)
            with self.assertRaisesRegex(StoreError,'^replay authority unavailable        self.store.reserve(KEY,SCOPE,1)
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

    def test_full_authority_still_prunes_expired_private_outcomes(self):
        self.admin.execute('UPDATE signal_replay.authority SET max_rows=1')
        self.store.reserve(KEY,SCOPE,time.time()+120)
        self.store.finish(KEY,'settled','private response',True)
        self.admin.execute('UPDATE signal_replay.entries SET expires_at=1')
        self.store.last_prune=0
        self.assertFalse(self.store.ready(), 'capacity must still refuse admission')
        self.assertEqual(self.store.lookup(KEY)[:2],('settled',None))
        self.assertEqual(self.admin.execute('SELECT admitted FROM signal_replay.authority').fetchone()[0],1)
        with self.assertRaises(StoreError):
            self.store.reserve('d'*64,SCOPE,time.time()+120)

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


# Runtime tests deliberately use the application's public replay API and route
# handler. Only external seller/facilitator I/O is replaced by synthetic fixtures.
def runtime_contender(settings, event, queue):
    from live402 import replay
    with patch.dict(os.environ, dict(settings, LIVE402_FIXTURE='1', LIVE402_REPLAY_BACKEND='postgres')):
        replay.reset_memory()
        event.wait(5)
        status, _ = replay.begin('runtime-duplicate', scope='private', reserve=False)
        admitted = status == 'run' and replay.authorize('runtime-duplicate')
        queue.put(admitted)
        replay.reset_memory()



def route_contender(settings, event, queue):
    from live402 import replay
    from live402.route import handle_route
    from test_success_only_billing import RESOURCE, _headers, _payload, _verified, _settled, _winner
    with patch.dict(os.environ, dict(settings,LIVE402_FIXTURE='1',
                                    LIVE402_REPLAY_BACKEND='postgres',LOCAL_FREE='0')):
        replay.reset_memory()
        with patch('live402.facilitator.verify',return_value=_verified()), \
             patch('live402.route.run_probe',return_value=(200,_winner())), \
             patch('live402.facilitator.settle',return_value=_settled()) as settle, \
             patch('live402.history.mark_batch_settled'), \
             patch('live402.route._attach_pq_trust',side_effect=lambda _c,r,_b:r):
            event.wait(5)
            result=handle_route({'need':'weather'},_headers(_payload('multiprocess-route')),RESOURCE)
            queue.put((result[0],settle.call_count))
        replay.reset_memory()

class RuntimeSQLiteContracts(unittest.TestCase):
    def setUp(self):
        from live402 import replay
        self.replay = replay
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {
            'LIVE402_FIXTURE':'1', 'LIVE402_REPLAY_BACKEND':'sqlite',
            'LIVE402_REPLAY_POSTGRES_DSN':'', 'LIVE402_REPLAY_AUTHORITY_ID':'',
            'LIVE402_REPLAY_DB':self.temp.name+'/runtime.sqlite'})
        self.env.start()
        replay.reset_memory()

    def tearDown(self):
        self.replay.reset_memory()
        self.env.stop()
        self.temp.cleanup()

    def test_readiness_does_not_recursively_lock(self):
        result = []
        worker = threading.Thread(target=lambda: result.append(self.replay.durable_ready()), daemon=True)
        worker.start()
        worker.join(3)
        self.assertFalse(worker.is_alive(), 'readiness deadlocked on the module lock')
        self.assertEqual(result, [True])

    def test_fence_after_lookup_blocks_delayed_admission_and_reset(self):
        r = self.replay
        self.assertEqual(r.begin('delayed',scope='private',reserve=False)[0],'run')
        path = r.db_path()
        with sqlite3.connect(path) as conn:
            conn.execute("INSERT INTO replay_meta VALUES('external_authority_id',?)",(AUTHORITY,))
        self.assertFalse(r.authorize('delayed'))
        self.assertFalse(r.durable_ready())
        r.reset()
        with sqlite3.connect(path) as conn:
            self.assertIsNotNone(conn.execute("SELECT 1 FROM replay_meta WHERE key='external_authority_id'").fetchone())
        self.assertEqual(r.begin('new',scope='private')[0],'reject')

    def test_configuration_conflicts_never_create_fallback(self):
        r = self.replay
        for config in ({'LIVE402_REPLAY_BACKEND':'invalid'},
                       {'LIVE402_REPLAY_POSTGRES_DSN':'not-a-dsn'},
                       {'LIVE402_REPLAY_BACKEND':'postgres','LIVE402_REPLAY_AUTHORITY_ID':''}):
            r.reset_memory()
            with patch.dict(os.environ, config):
                self.assertFalse(r.durable_ready())
                self.assertEqual(r.begin('config',scope='private')[0],'reject')
                self.assertIsNone(r._conn)

    def test_missing_driver_fails_closed(self):
        import sys
        r = self.replay
        with patch.dict(os.environ, LIVE402_REPLAY_BACKEND='postgres'), patch.dict(sys.modules, {'psycopg':None}):
            self.assertFalse(r.durable_ready())
            self.assertEqual(r.begin('driver',scope='private')[0],'reject')
            self.assertIsNone(r._conn)

    def test_backend_change_requires_restart(self):
        r = self.replay
        self.assertTrue(r.durable_ready())
        with patch.dict(os.environ, LIVE402_REPLAY_BACKEND='postgres'):
            self.assertFalse(r.durable_ready())
            self.assertEqual(r.begin('switch',scope='private')[0],'reject')

    def test_runtime_lost_commit_ack_retains_pending_across_restart(self):
        r = self.replay
        real = r._connect()
        class LostAck:
            def __getattr__(self,name):
                return getattr(real,name)
            def commit(self):
                real.commit()
                raise sqlite3.OperationalError('lost acknowledgement')
        with patch.object(r, '_connect', return_value=LostAck()):
            self.assertEqual(r.begin('lost',scope='private')[0],'reject')
        r.reset_memory()
        self.assertEqual(r.ledger_state('lost'),r.STATE_PENDING)
        self.assertEqual(r.begin('lost',scope='private')[0],'reject')

    def test_legacy_identity_still_blocks_admission(self):
        r = self.replay
        conn = r._connect()
        conn.execute("INSERT INTO settle_ledger VALUES(?,?,?,?,?,?,?)",
                     (r.durable_hash('old'),'settled',None,1,1,None,None))
        conn.execute("INSERT INTO replay_meta VALUES(?,?)",(r._CUTOVER_META_KEY,'ack'))
        conn.commit()
        self.assertEqual(r.begin('new',legacy_fp='old',scope='private')[0],'reject')


@unittest.skipUnless(os.environ.get('LIVE402_PG_TEST_DESTRUCTIVE') == 'isolated-ci-only',
                     'requires explicitly isolated PostgreSQL CI database')
class PostgreSQLRuntimeContracts(unittest.TestCase):
    def setUp(self):
        # Reuse the existing guarded fixture, not its standalone test methods.
        self.fixture = PostgreSQLContracts()
        self.fixture.setUp()
        self.admin = self.fixture.admin
        self.settings = self.fixture.settings
        self.env = patch.dict(os.environ, dict(self.settings,
            LIVE402_REPLAY_BACKEND='postgres', LIVE402_FIXTURE='1', LOCAL_FREE='0'))
        self.env.start()
        from live402 import replay
        self.replay = replay
        replay.reset_memory()

    def tearDown(self):
        self.replay.reset_memory()
        self.env.stop()
        self.fixture.tearDown()

    def route(self, nonce, result=None, verified=True):
        from live402 import facilitator
        from live402.route import handle_route
        from test_success_only_billing import RESOURCE, _headers, _payload, _verified, _settled, _winner
        with patch('live402.facilitator.verify', return_value=_verified() if verified else facilitator.FacilitatorResult(ok=False)) as verify, \
             patch('live402.route.run_probe', return_value=result or (200,_winner())) as probe, \
             patch('live402.facilitator.settle',return_value=_settled()) as settle, \
             patch('live402.history.mark_batch_settled'), \
             patch('live402.route._attach_pq_trust',side_effect=lambda _c,r,_b:r):
            out = handle_route({'need':'weather'},_headers(_payload(nonce)),RESOURCE)
        return out, (verify.call_count,probe.call_count,settle.call_count)

    def test_application_success_and_private_restart_replay(self):
        from live402.route import handle_route
        from test_success_only_billing import RESOURCE, _headers, _payload
        first, calls = self.route('pg-winner')
        self.assertEqual(first[0],200)
        self.assertEqual(calls,(1,1,1))
        self.assertEqual(first[1]['billing']['amount_atomic'],'3000')
        self.assertTrue(first[1]['billing']['settled'])
        self.assertIsNone(self.replay._conn, 'PostgreSQL must never open SQLite')
        self.replay.reset_memory()
        second, calls = self.route('pg-winner')
        self.assertEqual(second,first)
        self.assertEqual(calls,(0,0,0))
        headers = _headers(_payload('pg-winner'))
        headers['Replay-Key'] = 'b2'*32
        with patch('live402.facilitator.settle') as settle:
            denied = handle_route({'need':'weather'},headers,RESOURCE)
        self.assertEqual(denied[0],503)
        self.assertNotIn('url',denied[1])
        settle.assert_not_called()

    def test_application_all_normal_misses_are_free_and_durable(self):
        from test_success_only_billing import TYPED_MISSES, _miss
        from live402.route_outcomes import NORMAL_MISS_REASONS
        for reason in TYPED_MISSES:
            first,calls = self.route(reason,(503,_miss(reason)))
            self.assertEqual(first[0],200 if reason in NORMAL_MISS_REASONS else 503)
            self.assertEqual(calls,(1,1,0))
            self.assertFalse(first[1]['billing']['settled'])
            self.replay.reset_memory()
            second,calls = self.route(reason,(503,_miss(reason)))
            self.assertEqual(second,first)
            self.assertEqual(calls,(0,0,0))
        self.assertEqual(self.admin.execute("SELECT count(*) FROM signal_replay.entries WHERE state='not_settled'").fetchone()[0],len(TYPED_MISSES))

    def test_invalid_verification_has_no_admission_or_seller_call(self):
        out,calls = self.route('invalid',verified=False)
        self.assertEqual(out[0],402)
        self.assertEqual(calls,(1,0,0))
        self.assertEqual(self.admin.execute('SELECT count(*) FROM signal_replay.entries').fetchone()[0],0)

    def test_authority_outage_blocks_application_before_economic_action(self):
        self.admin.execute('UPDATE signal_replay.authority SET active=FALSE')
        out,calls = self.route('inactive')
        self.assertEqual(out[0],503)
        self.assertEqual(calls,(0,0,0))
        self.assertIsNone(self.replay._conn)

    def test_shared_reset_never_deletes_authorizations(self):
        r = self.replay
        self.assertEqual(r.begin('retained',scope='private')[0],'run')
        r.reset()
        self.assertEqual(r.ledger_state('retained'),r.STATE_PENDING)
        self.assertEqual(r.begin('retained',scope='private')[0],'reject')

    def test_runtime_multiprocess_duplicate_payment_has_one_admission(self):
        ctx = multiprocessing.get_context('spawn')
        event,queue = ctx.Event(),ctx.Queue()
        jobs=[ctx.Process(target=runtime_contender,args=(self.settings,event,queue)) for _ in range(4)]
        for job in jobs: job.start()
        event.set()
        results=[queue.get(timeout=20) for _ in jobs]
        for job in jobs:
            job.join(5)
            self.assertEqual(job.exitcode,0)
        self.assertEqual(results.count(True),1)
        self.assertEqual(self.admin.execute('SELECT admitted FROM signal_replay.authority').fetchone()[0],1)


    def test_multiprocess_route_calls_settle_exactly_once(self):
        ctx=multiprocessing.get_context('spawn')
        event,queue=ctx.Event(),ctx.Queue()
        jobs=[ctx.Process(target=route_contender,args=(self.settings,event,queue)) for _ in range(4)]
        for job in jobs: job.start()
        event.set()
        results=[queue.get(timeout=20) for _ in jobs]
        for job in jobs:
            job.join(5)
            self.assertEqual(job.exitcode,0)
        self.assertEqual(sum(calls for _code,calls in results),1)
        self.assertIn(200,[code for code,_calls in results])
        self.assertTrue(all(code in (200,503) for code,_calls in results))
        self.assertEqual(self.admin.execute('SELECT admitted FROM signal_replay.authority').fetchone()[0],1)

    def test_runtime_expiry_and_abandon_never_release_identity(self):
        r = self.replay
        self.assertEqual(r.begin('abandoned',scope='private')[0],'run')
        r.abandon('abandoned')
        self.admin.execute('UPDATE signal_replay.entries SET expires_at=1')
        r.reset_memory()
        self.assertEqual(r.ledger_state('abandoned'),r.STATE_UNKNOWN)
        self.assertEqual(r.begin('abandoned',scope='private')[0],'reject')

    def test_runtime_sqlite_to_postgres_rehearsal(self):
        r = self.replay
        r.reset_memory()
        with tempfile.TemporaryDirectory() as directory:
            source = str(Path(directory)/'runtime.sqlite')
            with patch.dict(os.environ, LIVE402_REPLAY_BACKEND='sqlite',
                            LIVE402_REPLAY_POSTGRES_DSN='',LIVE402_REPLAY_AUTHORITY_ID='',
                            LIVE402_REPLAY_DB=source):
                self.assertTrue(r.durable_ready())
                self.assertEqual(r.begin('migrated',scope='private')[0],'run')
                r.abandon('migrated')
                r.reset_memory()
                self.admin.execute('DROP SCHEMA signal_replay CASCADE')
                from scripts.replay_migrate import require_fence_aware_runtime
                require_fence_aware_runtime(r)
                report=migrate(source,self.settings,apply=True,writers_stopped=True)
                self.assertTrue(report['source_fenced'] and report['target_active'])
                self.assertFalse(r.durable_ready())
                self.assertEqual(r.begin('source-new',scope='private')[0],'reject')
                r.reset_memory()
            self.assertTrue(r.durable_ready())
            self.assertEqual(r.ledger_state('migrated'),r.STATE_UNKNOWN)
            self.assertEqual(r.begin('migrated',scope='private')[0],'reject')
            self.assertEqual(r.begin('target-new',scope='private')[0],'run')

    def test_application_lost_admission_ack_does_not_probe_or_settle(self):
        original = PostgresStore.reserve
        def lost_ack(store, *args):
            admitted = original(store,*args)
            if admitted:
                raise StoreError('simulated lost COMMIT acknowledgement')
            return admitted
        with patch.object(PostgresStore,'reserve',lost_ack):
            out,calls = self.route('admission-ack')
        self.assertEqual(out[0],503)
        self.assertEqual(calls,(1,0,0))
        self.replay.reset_memory()
        out,calls = self.route('admission-ack')
        self.assertEqual(out[0],503)
        self.assertEqual(calls,(0,0,0))
        self.assertEqual(self.admin.execute('SELECT state FROM signal_replay.entries').fetchone()[0],'settlement_pending')

    def test_application_lost_finish_ack_never_settles_twice(self):
        original = PostgresStore.finish
        def lost_ack(store,*args):
            original(store,*args)
            raise StoreError('simulated lost finish acknowledgement')
        with patch.object(PostgresStore,'finish',lost_ack):
            first,calls = self.route('finish-ack')
        self.assertEqual(calls,(1,1,1))
        self.replay.reset_memory()
        second,calls = self.route('finish-ack')
        self.assertEqual(first,second)
        self.assertEqual(calls,(0,0,0))

    def test_application_failed_finish_retains_pending_on_restart(self):
        with patch.object(PostgresStore,'finish',side_effect=StoreError('unavailable')):
            first,calls = self.route('finish-failed')
        self.assertEqual(calls,(1,1,1))
        self.assertTrue(first[1]['billing']['settled'])
        self.replay.reset_memory()
        second,calls = self.route('finish-failed')
        self.assertEqual(second[0],503)
        self.assertEqual(calls,(0,0,0))
        self.assertEqual(self.admin.execute('SELECT state FROM signal_replay.entries').fetchone()[0],'settlement_pending')


import test_route_binding as binding_contracts


@unittest.skipUnless(os.environ.get('LIVE402_PG_TEST_DESTRUCTIVE') == 'isolated-ci-only',
                     'requires explicitly isolated PostgreSQL CI database')
class PostgreSQLBindingContracts(binding_contracts.BindingTests):
    """Run all existing V4/PQ adversarial contracts with the real PG authority."""
    def setUp(self):
        super().setUp()
        self.pg_fixture = PostgreSQLContracts()
        self.pg_fixture.setUp()
        self.addCleanup(self.pg_fixture.tearDown)
        self.pg_env = patch.dict(os.environ,dict(self.pg_fixture.settings,
                                                LIVE402_REPLAY_BACKEND='postgres'))
        self.pg_env.start()
        self.addCleanup(self.pg_env.stop)
        from live402 import replay
        replay.reset_memory()
        self.addCleanup(replay.reset_memory)
):
                self.store.reserve('d'*64,SCOPE,time.time()+120)
            self.assertEqual(connect.call_count,1)
            self.assertTrue(first.closed)
            self.assertIsNone(self.store.conn)
            self.assertIsNone(self.admin.execute(
                'SELECT fp_hash FROM signal_replay.entries WHERE fp_hash=%s',('d'*64,)).fetchone())
            # A later independent lookup can reconnect; it cannot repeat the
            # previously acknowledged admission or recover an uncertain write.
            self.store.driver = psycopg
            self.assertEqual(self.store.lookup(KEY)[0],'settlement_pending')
            self.assertFalse(self.store.reserve(KEY,SCOPE,time.time()+120))

    def test_connection_is_not_recycled_inside_transaction(self):
        with patch('live402.replay_postgres.time.monotonic',return_value=1000.0) as clock:
            self.assertTrue(self.store.reserve(KEY,SCOPE,time.time()+120))
            first = self.store.conn
            with self.store._transaction() as conn:
                clock.return_value = 1601.0
                conn.execute("UPDATE signal_replay.entries SET state='unknown' WHERE fp_hash=%s",(KEY,))
                self.assertIs(conn,first)
                self.assertFalse(first.closed)
            self.assertFalse(first.closed)
            self.assertEqual(self.store.lookup(KEY)[0],'unknown')
            self.assertTrue(first.closed)
            self.assertFalse(self.store.reserve(KEY,SCOPE,time.time()+120))

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

    def test_full_authority_still_prunes_expired_private_outcomes(self):
        self.admin.execute('UPDATE signal_replay.authority SET max_rows=1')
        self.store.reserve(KEY,SCOPE,time.time()+120)
        self.store.finish(KEY,'settled','private response',True)
        self.admin.execute('UPDATE signal_replay.entries SET expires_at=1')
        self.store.last_prune=0
        self.assertFalse(self.store.ready(), 'capacity must still refuse admission')
        self.assertEqual(self.store.lookup(KEY)[:2],('settled',None))
        self.assertEqual(self.admin.execute('SELECT admitted FROM signal_replay.authority').fetchone()[0],1)
        with self.assertRaises(StoreError):
            self.store.reserve('d'*64,SCOPE,time.time()+120)

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


# Runtime tests deliberately use the application's public replay API and route
# handler. Only external seller/facilitator I/O is replaced by synthetic fixtures.
def runtime_contender(settings, event, queue):
    from live402 import replay
    with patch.dict(os.environ, dict(settings, LIVE402_FIXTURE='1', LIVE402_REPLAY_BACKEND='postgres')):
        replay.reset_memory()
        event.wait(5)
        status, _ = replay.begin('runtime-duplicate', scope='private', reserve=False)
        admitted = status == 'run' and replay.authorize('runtime-duplicate')
        queue.put(admitted)
        replay.reset_memory()



def route_contender(settings, event, queue):
    from live402 import replay
    from live402.route import handle_route
    from test_success_only_billing import RESOURCE, _headers, _payload, _verified, _settled, _winner
    with patch.dict(os.environ, dict(settings,LIVE402_FIXTURE='1',
                                    LIVE402_REPLAY_BACKEND='postgres',LOCAL_FREE='0')):
        replay.reset_memory()
        with patch('live402.facilitator.verify',return_value=_verified()), \
             patch('live402.route.run_probe',return_value=(200,_winner())), \
             patch('live402.facilitator.settle',return_value=_settled()) as settle, \
             patch('live402.history.mark_batch_settled'), \
             patch('live402.route._attach_pq_trust',side_effect=lambda _c,r,_b:r):
            event.wait(5)
            result=handle_route({'need':'weather'},_headers(_payload('multiprocess-route')),RESOURCE)
            queue.put((result[0],settle.call_count))
        replay.reset_memory()

class RuntimeSQLiteContracts(unittest.TestCase):
    def setUp(self):
        from live402 import replay
        self.replay = replay
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {
            'LIVE402_FIXTURE':'1', 'LIVE402_REPLAY_BACKEND':'sqlite',
            'LIVE402_REPLAY_POSTGRES_DSN':'', 'LIVE402_REPLAY_AUTHORITY_ID':'',
            'LIVE402_REPLAY_DB':self.temp.name+'/runtime.sqlite'})
        self.env.start()
        replay.reset_memory()

    def tearDown(self):
        self.replay.reset_memory()
        self.env.stop()
        self.temp.cleanup()

    def test_readiness_does_not_recursively_lock(self):
        result = []
        worker = threading.Thread(target=lambda: result.append(self.replay.durable_ready()), daemon=True)
        worker.start()
        worker.join(3)
        self.assertFalse(worker.is_alive(), 'readiness deadlocked on the module lock')
        self.assertEqual(result, [True])

    def test_fence_after_lookup_blocks_delayed_admission_and_reset(self):
        r = self.replay
        self.assertEqual(r.begin('delayed',scope='private',reserve=False)[0],'run')
        path = r.db_path()
        with sqlite3.connect(path) as conn:
            conn.execute("INSERT INTO replay_meta VALUES('external_authority_id',?)",(AUTHORITY,))
        self.assertFalse(r.authorize('delayed'))
        self.assertFalse(r.durable_ready())
        r.reset()
        with sqlite3.connect(path) as conn:
            self.assertIsNotNone(conn.execute("SELECT 1 FROM replay_meta WHERE key='external_authority_id'").fetchone())
        self.assertEqual(r.begin('new',scope='private')[0],'reject')

    def test_configuration_conflicts_never_create_fallback(self):
        r = self.replay
        for config in ({'LIVE402_REPLAY_BACKEND':'invalid'},
                       {'LIVE402_REPLAY_POSTGRES_DSN':'not-a-dsn'},
                       {'LIVE402_REPLAY_BACKEND':'postgres','LIVE402_REPLAY_AUTHORITY_ID':''}):
            r.reset_memory()
            with patch.dict(os.environ, config):
                self.assertFalse(r.durable_ready())
                self.assertEqual(r.begin('config',scope='private')[0],'reject')
                self.assertIsNone(r._conn)

    def test_missing_driver_fails_closed(self):
        import sys
        r = self.replay
        with patch.dict(os.environ, LIVE402_REPLAY_BACKEND='postgres'), patch.dict(sys.modules, {'psycopg':None}):
            self.assertFalse(r.durable_ready())
            self.assertEqual(r.begin('driver',scope='private')[0],'reject')
            self.assertIsNone(r._conn)

    def test_backend_change_requires_restart(self):
        r = self.replay
        self.assertTrue(r.durable_ready())
        with patch.dict(os.environ, LIVE402_REPLAY_BACKEND='postgres'):
            self.assertFalse(r.durable_ready())
            self.assertEqual(r.begin('switch',scope='private')[0],'reject')

    def test_runtime_lost_commit_ack_retains_pending_across_restart(self):
        r = self.replay
        real = r._connect()
        class LostAck:
            def __getattr__(self,name):
                return getattr(real,name)
            def commit(self):
                real.commit()
                raise sqlite3.OperationalError('lost acknowledgement')
        with patch.object(r, '_connect', return_value=LostAck()):
            self.assertEqual(r.begin('lost',scope='private')[0],'reject')
        r.reset_memory()
        self.assertEqual(r.ledger_state('lost'),r.STATE_PENDING)
        self.assertEqual(r.begin('lost',scope='private')[0],'reject')

    def test_legacy_identity_still_blocks_admission(self):
        r = self.replay
        conn = r._connect()
        conn.execute("INSERT INTO settle_ledger VALUES(?,?,?,?,?,?,?)",
                     (r.durable_hash('old'),'settled',None,1,1,None,None))
        conn.execute("INSERT INTO replay_meta VALUES(?,?)",(r._CUTOVER_META_KEY,'ack'))
        conn.commit()
        self.assertEqual(r.begin('new',legacy_fp='old',scope='private')[0],'reject')


@unittest.skipUnless(os.environ.get('LIVE402_PG_TEST_DESTRUCTIVE') == 'isolated-ci-only',
                     'requires explicitly isolated PostgreSQL CI database')
class PostgreSQLRuntimeContracts(unittest.TestCase):
    def setUp(self):
        # Reuse the existing guarded fixture, not its standalone test methods.
        self.fixture = PostgreSQLContracts()
        self.fixture.setUp()
        self.admin = self.fixture.admin
        self.settings = self.fixture.settings
        self.env = patch.dict(os.environ, dict(self.settings,
            LIVE402_REPLAY_BACKEND='postgres', LIVE402_FIXTURE='1', LOCAL_FREE='0'))
        self.env.start()
        from live402 import replay
        self.replay = replay
        replay.reset_memory()

    def tearDown(self):
        self.replay.reset_memory()
        self.env.stop()
        self.fixture.tearDown()

    def route(self, nonce, result=None, verified=True):
        from live402 import facilitator
        from live402.route import handle_route
        from test_success_only_billing import RESOURCE, _headers, _payload, _verified, _settled, _winner
        with patch('live402.facilitator.verify', return_value=_verified() if verified else facilitator.FacilitatorResult(ok=False)) as verify, \
             patch('live402.route.run_probe', return_value=result or (200,_winner())) as probe, \
             patch('live402.facilitator.settle',return_value=_settled()) as settle, \
             patch('live402.history.mark_batch_settled'), \
             patch('live402.route._attach_pq_trust',side_effect=lambda _c,r,_b:r):
            out = handle_route({'need':'weather'},_headers(_payload(nonce)),RESOURCE)
        return out, (verify.call_count,probe.call_count,settle.call_count)

    def test_application_success_and_private_restart_replay(self):
        from live402.route import handle_route
        from test_success_only_billing import RESOURCE, _headers, _payload
        first, calls = self.route('pg-winner')
        self.assertEqual(first[0],200)
        self.assertEqual(calls,(1,1,1))
        self.assertEqual(first[1]['billing']['amount_atomic'],'3000')
        self.assertTrue(first[1]['billing']['settled'])
        self.assertIsNone(self.replay._conn, 'PostgreSQL must never open SQLite')
        self.replay.reset_memory()
        second, calls = self.route('pg-winner')
        self.assertEqual(second,first)
        self.assertEqual(calls,(0,0,0))
        headers = _headers(_payload('pg-winner'))
        headers['Replay-Key'] = 'b2'*32
        with patch('live402.facilitator.settle') as settle:
            denied = handle_route({'need':'weather'},headers,RESOURCE)
        self.assertEqual(denied[0],503)
        self.assertNotIn('url',denied[1])
        settle.assert_not_called()

    def test_application_all_normal_misses_are_free_and_durable(self):
        from test_success_only_billing import TYPED_MISSES, _miss
        from live402.route_outcomes import NORMAL_MISS_REASONS
        for reason in TYPED_MISSES:
            first,calls = self.route(reason,(503,_miss(reason)))
            self.assertEqual(first[0],200 if reason in NORMAL_MISS_REASONS else 503)
            self.assertEqual(calls,(1,1,0))
            self.assertFalse(first[1]['billing']['settled'])
            self.replay.reset_memory()
            second,calls = self.route(reason,(503,_miss(reason)))
            self.assertEqual(second,first)
            self.assertEqual(calls,(0,0,0))
        self.assertEqual(self.admin.execute("SELECT count(*) FROM signal_replay.entries WHERE state='not_settled'").fetchone()[0],len(TYPED_MISSES))

    def test_invalid_verification_has_no_admission_or_seller_call(self):
        out,calls = self.route('invalid',verified=False)
        self.assertEqual(out[0],402)
        self.assertEqual(calls,(1,0,0))
        self.assertEqual(self.admin.execute('SELECT count(*) FROM signal_replay.entries').fetchone()[0],0)

    def test_authority_outage_blocks_application_before_economic_action(self):
        self.admin.execute('UPDATE signal_replay.authority SET active=FALSE')
        out,calls = self.route('inactive')
        self.assertEqual(out[0],503)
        self.assertEqual(calls,(0,0,0))
        self.assertIsNone(self.replay._conn)

    def test_shared_reset_never_deletes_authorizations(self):
        r = self.replay
        self.assertEqual(r.begin('retained',scope='private')[0],'run')
        r.reset()
        self.assertEqual(r.ledger_state('retained'),r.STATE_PENDING)
        self.assertEqual(r.begin('retained',scope='private')[0],'reject')

    def test_runtime_multiprocess_duplicate_payment_has_one_admission(self):
        ctx = multiprocessing.get_context('spawn')
        event,queue = ctx.Event(),ctx.Queue()
        jobs=[ctx.Process(target=runtime_contender,args=(self.settings,event,queue)) for _ in range(4)]
        for job in jobs: job.start()
        event.set()
        results=[queue.get(timeout=20) for _ in jobs]
        for job in jobs:
            job.join(5)
            self.assertEqual(job.exitcode,0)
        self.assertEqual(results.count(True),1)
        self.assertEqual(self.admin.execute('SELECT admitted FROM signal_replay.authority').fetchone()[0],1)


    def test_multiprocess_route_calls_settle_exactly_once(self):
        ctx=multiprocessing.get_context('spawn')
        event,queue=ctx.Event(),ctx.Queue()
        jobs=[ctx.Process(target=route_contender,args=(self.settings,event,queue)) for _ in range(4)]
        for job in jobs: job.start()
        event.set()
        results=[queue.get(timeout=20) for _ in jobs]
        for job in jobs:
            job.join(5)
            self.assertEqual(job.exitcode,0)
        self.assertEqual(sum(calls for _code,calls in results),1)
        self.assertIn(200,[code for code,_calls in results])
        self.assertTrue(all(code in (200,503) for code,_calls in results))
        self.assertEqual(self.admin.execute('SELECT admitted FROM signal_replay.authority').fetchone()[0],1)

    def test_runtime_expiry_and_abandon_never_release_identity(self):
        r = self.replay
        self.assertEqual(r.begin('abandoned',scope='private')[0],'run')
        r.abandon('abandoned')
        self.admin.execute('UPDATE signal_replay.entries SET expires_at=1')
        r.reset_memory()
        self.assertEqual(r.ledger_state('abandoned'),r.STATE_UNKNOWN)
        self.assertEqual(r.begin('abandoned',scope='private')[0],'reject')

    def test_runtime_sqlite_to_postgres_rehearsal(self):
        r = self.replay
        r.reset_memory()
        with tempfile.TemporaryDirectory() as directory:
            source = str(Path(directory)/'runtime.sqlite')
            with patch.dict(os.environ, LIVE402_REPLAY_BACKEND='sqlite',
                            LIVE402_REPLAY_POSTGRES_DSN='',LIVE402_REPLAY_AUTHORITY_ID='',
                            LIVE402_REPLAY_DB=source):
                self.assertTrue(r.durable_ready())
                self.assertEqual(r.begin('migrated',scope='private')[0],'run')
                r.abandon('migrated')
                r.reset_memory()
                self.admin.execute('DROP SCHEMA signal_replay CASCADE')
                from scripts.replay_migrate import require_fence_aware_runtime
                require_fence_aware_runtime(r)
                report=migrate(source,self.settings,apply=True,writers_stopped=True)
                self.assertTrue(report['source_fenced'] and report['target_active'])
                self.assertFalse(r.durable_ready())
                self.assertEqual(r.begin('source-new',scope='private')[0],'reject')
                r.reset_memory()
            self.assertTrue(r.durable_ready())
            self.assertEqual(r.ledger_state('migrated'),r.STATE_UNKNOWN)
            self.assertEqual(r.begin('migrated',scope='private')[0],'reject')
            self.assertEqual(r.begin('target-new',scope='private')[0],'run')

    def test_application_lost_admission_ack_does_not_probe_or_settle(self):
        original = PostgresStore.reserve
        def lost_ack(store, *args):
            admitted = original(store,*args)
            if admitted:
                raise StoreError('simulated lost COMMIT acknowledgement')
            return admitted
        with patch.object(PostgresStore,'reserve',lost_ack):
            out,calls = self.route('admission-ack')
        self.assertEqual(out[0],503)
        self.assertEqual(calls,(1,0,0))
        self.replay.reset_memory()
        out,calls = self.route('admission-ack')
        self.assertEqual(out[0],503)
        self.assertEqual(calls,(0,0,0))
        self.assertEqual(self.admin.execute('SELECT state FROM signal_replay.entries').fetchone()[0],'settlement_pending')

    def test_application_lost_finish_ack_never_settles_twice(self):
        original = PostgresStore.finish
        def lost_ack(store,*args):
            original(store,*args)
            raise StoreError('simulated lost finish acknowledgement')
        with patch.object(PostgresStore,'finish',lost_ack):
            first,calls = self.route('finish-ack')
        self.assertEqual(calls,(1,1,1))
        self.replay.reset_memory()
        second,calls = self.route('finish-ack')
        self.assertEqual(first,second)
        self.assertEqual(calls,(0,0,0))

    def test_application_failed_finish_retains_pending_on_restart(self):
        with patch.object(PostgresStore,'finish',side_effect=StoreError('unavailable')):
            first,calls = self.route('finish-failed')
        self.assertEqual(calls,(1,1,1))
        self.assertTrue(first[1]['billing']['settled'])
        self.replay.reset_memory()
        second,calls = self.route('finish-failed')
        self.assertEqual(second[0],503)
        self.assertEqual(calls,(0,0,0))
        self.assertEqual(self.admin.execute('SELECT state FROM signal_replay.entries').fetchone()[0],'settlement_pending')


import test_route_binding as binding_contracts


@unittest.skipUnless(os.environ.get('LIVE402_PG_TEST_DESTRUCTIVE') == 'isolated-ci-only',
                     'requires explicitly isolated PostgreSQL CI database')
class PostgreSQLBindingContracts(binding_contracts.BindingTests):
    """Run all existing V4/PQ adversarial contracts with the real PG authority."""
    def setUp(self):
        super().setUp()
        self.pg_fixture = PostgreSQLContracts()
        self.pg_fixture.setUp()
        self.addCleanup(self.pg_fixture.tearDown)
        self.pg_env = patch.dict(os.environ,dict(self.pg_fixture.settings,
                                                LIVE402_REPLAY_BACKEND='postgres'))
        self.pg_env.start()
        self.addCleanup(self.pg_env.stop)
        from live402 import replay
        replay.reset_memory()
        self.addCleanup(replay.reset_memory)
