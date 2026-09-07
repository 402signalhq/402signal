"""Restricted-function API contracts against disposable loopback PostgreSQL only."""
import multiprocessing
import os
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from live402.replay_postgres import PostgresStore, validate_settings
from live402.replay_store import StoreError
from scripts.replay_migrate import migrate
from test_replay_storage import AUTHORITY, KEY, SCOPE, SCHEMA, pg_contender


@unittest.skipUnless(os.environ.get('LIVE402_PG_TEST_DESTRUCTIVE')=='isolated-ci-only',
                     'requires disposable loopback PostgreSQL')
class ManagedPostgresContracts(unittest.TestCase):
    def setUp(self):
        import psycopg
        from psycopg.conninfo import conninfo_to_dict,make_conninfo
        cfg=conninfo_to_dict(os.environ['LIVE402_PG_TEST_DSN'])
        if cfg.get('host')!='127.0.0.1' or cfg.get('dbname')!='402signal_ci':
            raise RuntimeError('refusing destructive tests outside loopback CI')
        self.admin=psycopg.connect(**cfg,autocommit=True)
        self.admin.execute('DROP SCHEMA IF EXISTS signal_replay CASCADE')
        for role in ['managed_runtime','managed_other']:
            if not self.admin.execute('SELECT 1 FROM pg_roles WHERE rolname=%s',(role,)).fetchone():
                self.admin.execute(psycopg.sql.SQL("CREATE ROLE {} LOGIN PASSWORD 'isolated-fixture-only'").format(psycopg.sql.Identifier(role)))
                self.admin.execute(psycopg.sql.SQL('GRANT pg_read_all_data TO {}').format(psycopg.sql.Identifier(role)))
        self.runtime_dsn=make_conninfo(**dict(cfg,user='managed_runtime',password='isolated-fixture-only'))
        self.other_dsn=make_conninfo(**dict(cfg,user='managed_other',password='isolated-fixture-only'))
        self.settings={'LIVE402_PG_TEST_SUPPORT':'1','LIVE402_REPLAY_AUTHORITY_ID':AUTHORITY,
                       'LIVE402_REPLAY_POSTGRES_DSN':self.runtime_dsn,'LIVE402_REPLAY_POSTGRES_API':'functions-v1'}
        self.admin.execute((Path(__file__).resolve().parents[1]/'ops/replay-postgres-functions.sql').read_text())
        self.admin.execute("INSERT INTO signal_replay.authority VALUES(TRUE,%s,1,TRUE,TRUE,0,1000,268435456,%s)",(AUTHORITY,'0'*64))
        self.admin.execute("INSERT INTO signal_replay.runtime_policy VALUES(TRUE,%s,'managed_runtime',"
                           "(extract(epoch FROM pg_postmaster_start_time())*1000000)::bigint,inet_server_addr())",(AUTHORITY,))
        self.store=PostgresStore(environ=self.settings)
        self.runtime=psycopg.connect(self.runtime_dsn,autocommit=True)
    def tearDown(self):
        self.store.close();self.runtime.close();self.admin.close()
    def test_full_lifecycle_duplicate_and_reopen(self):
        self.assertTrue(self.store.ready())
        self.assertTrue(self.store.reserve(KEY,SCOPE,time.time()+120))
        self.store.finish(KEY,'settled','private response',True)
        self.store.close()
        self.assertFalse(self.store.reserve(KEY,SCOPE,time.time()+120))
        self.assertEqual(self.store.lookup(KEY)[:2],('settled','private response'))
    def test_four_process_duplicate_has_one_winner(self):
        ctx=multiprocessing.get_context('spawn');event=ctx.Event();queue=ctx.Queue()
        jobs=[ctx.Process(target=pg_contender,args=(self.settings,event,queue)) for _ in range(4)]
        for job in jobs: job.start()
        event.set();results=[queue.get(timeout=20) for job in jobs]
        for job in jobs:
            job.join(10);self.assertEqual(job.exitcode,0)
        self.assertEqual(results.count(True),1)
        self.assertEqual(self.admin.execute('SELECT admitted FROM signal_replay.authority').fetchone()[0],1)
    def test_runtime_cannot_change_protected_state_or_schema(self):
        import psycopg
        for query in ["UPDATE signal_replay.authority SET active=false",
                      "UPDATE signal_replay.authority SET authority_id='"+'d'*32+"'",
                      'UPDATE signal_replay.authority SET max_rows=99999',
                      'UPDATE signal_replay.authority SET admitted=0',
                      'UPDATE signal_replay.runtime_policy SET instance_start_us=1',
                      'DELETE FROM signal_replay.runtime_policy',
                      'TRUNCATE signal_replay.entries',
                      'DROP TABLE signal_replay.authority',
                      'CREATE TABLE signal_replay.backdoor(x int)',
                      'SET ROLE postgres']:
            with self.subTest(query=query),self.assertRaises(psycopg.errors.InsufficientPrivilege):
                self.runtime.execute(query)
        self.assertTrue(self.store.ready())
    def test_other_authenticated_reader_cannot_call_api(self):
        other=PostgresStore(environ=dict(self.settings,LIVE402_REPLAY_POSTGRES_DSN=self.other_dsn))
        try:
            self.assertFalse(other.ready())
            with self.assertRaises(StoreError): other.reserve(KEY,SCOPE,time.time()+120)
        finally: other.close()
        self.assertEqual(self.admin.execute('SELECT count(*) FROM signal_replay.entries').fetchone()[0],0)
    def test_instance_change_stays_fenced_after_client_restart(self):
        self.assertTrue(self.store.reserve(KEY,SCOPE,time.time()+120));self.store.abandon(KEY)
        self.admin.execute('UPDATE signal_replay.runtime_policy SET instance_start_us=instance_start_us-1')
        for _ in range(2):
            self.store.close();self.assertFalse(self.store.ready())
            with self.assertRaises(StoreError): self.store.reserve('d'*64,SCOPE,time.time()+120)
        self.assertEqual(self.admin.execute('SELECT fp_hash,state FROM signal_replay.entries').fetchall(),[(KEY,'unknown')])
    def test_changed_server_address_also_stays_fenced(self):
        self.admin.execute("UPDATE signal_replay.runtime_policy SET instance_server_addr='127.0.0.2'")
        self.assertFalse(self.store.ready())
        with self.assertRaises(StoreError): self.store.reserve(KEY,SCOPE,time.time()+120)
        self.assertEqual(self.admin.execute('SELECT count(*) FROM signal_replay.entries').fetchone()[0],0)
    def test_inactive_wrong_authority_and_broadened_role_fail_closed(self):
        self.admin.execute('UPDATE signal_replay.authority SET active=false');self.assertFalse(self.store.ready())
        self.admin.execute('UPDATE signal_replay.authority SET active=true')
        wrong=PostgresStore(environ=dict(self.settings,LIVE402_REPLAY_AUTHORITY_ID='d'*32))
        try: self.assertFalse(wrong.ready())
        finally: wrong.close()
        self.admin.execute('GRANT UPDATE(admitted) ON signal_replay.authority TO managed_runtime')
        self.assertFalse(self.store.ready())
    def test_expired_response_and_capacity_preserve_identity(self):
        self.store.reserve(KEY,SCOPE,time.time()+120);self.store.finish(KEY,'settled','private',True)
        self.admin.execute('UPDATE signal_replay.entries SET expires_at=1')
        self.store.last_prune=0;self.store.prune_outcomes()
        self.assertEqual(self.store.lookup(KEY)[:2],('settled',None))
        self.admin.execute('UPDATE signal_replay.authority SET max_rows=1')
        self.assertFalse(self.store.ready())
        with self.assertRaises(StoreError): self.store.reserve('d'*64,SCOPE,time.time()+120)
        self.assertEqual(self.admin.execute('SELECT count(*) FROM signal_replay.entries').fetchone()[0],1)
    def test_release_is_only_pending_and_never_terminal(self):
        self.store.reserve(KEY,SCOPE,time.time()+120);self.store.finish(KEY,'rejected',None,False)
        self.assertTrue(self.store.reserve(KEY,SCOPE,time.time()+120))
        self.store.finish(KEY,'settled','done',True);self.store.finish(KEY,'rejected',None,False)
        self.assertEqual(self.store.lookup(KEY)[0],'settled')
        self.assertEqual(self.admin.execute('SELECT admitted FROM signal_replay.authority').fetchone()[0],1)
    def test_forged_authority_direct_function_has_no_write(self):
        import psycopg
        with self.assertRaises(psycopg.Error):
            self.runtime.execute('SELECT signal_replay.api_reserve(%s,%s,%s,%s)',('d'*32,KEY,SCOPE,time.time()+120))
        self.assertEqual(self.admin.execute('SELECT count(*) FROM signal_replay.entries').fetchone()[0],0)
    def test_search_path_cannot_redirect_owner_function(self):
        self.runtime.execute("SET search_path='public'")
        self.assertTrue(self.runtime.execute('SELECT signal_replay.api_reserve(%s,%s,%s,%s)',(AUTHORITY,KEY,SCOPE,time.time()+120)).fetchone()[0])
    def test_migration_installs_pinned_policy_then_fences_source(self):
        self.store.close();self.admin.execute('DROP SCHEMA signal_replay CASCADE')
        with tempfile.TemporaryDirectory() as temp:
            source=Path(temp)/'replay.sqlite'
            with sqlite3.connect(source) as conn:
                conn.executescript(SCHEMA)
                conn.execute('INSERT INTO settle_ledger VALUES(?,?,?,?,?,?,?)',(KEY,'unknown',None,1,2,SCOPE,2))
            env=dict(self.settings,LIVE402_REPLAY_POSTGRES_DSN=os.environ['LIVE402_PG_TEST_DSN'],
                     LIVE402_REPLAY_POSTGRES_RUNTIME_LOGIN='managed_runtime')
            result=migrate(source,env,apply=True,writers_stopped=True)
            self.assertTrue(result['source_fenced']);self.assertTrue(result['target_active'])
            self.assertTrue(self.store.ready());self.assertEqual(self.store.lookup(KEY)[0],'unknown')
            with self.assertRaises(StoreError): migrate(source,env,apply=True,writers_stopped=True)
    def test_instance_change_during_migration_cannot_activate(self):
        self.store.close();self.admin.execute('DROP SCHEMA signal_replay CASCADE')
        with tempfile.TemporaryDirectory() as temp:
            source=Path(temp)/'replay.sqlite'
            with sqlite3.connect(source) as conn: conn.executescript(SCHEMA)
            env=dict(self.settings,LIVE402_REPLAY_POSTGRES_DSN=os.environ['LIVE402_PG_TEST_DSN'],
                     LIVE402_REPLAY_POSTGRES_RUNTIME_LOGIN='managed_runtime')
            def fault(stage):
                if stage=='after_source_fence':
                    self.admin.execute('UPDATE signal_replay.runtime_policy SET instance_start_us=instance_start_us-1')
            with self.assertRaises(StoreError): migrate(source,env,apply=True,writers_stopped=True,fault=fault)
            self.assertFalse(self.admin.execute('SELECT active FROM signal_replay.authority').fetchone()[0])
            with sqlite3.connect(source) as conn:
                self.assertIsNotNone(conn.execute("SELECT 1 FROM replay_meta WHERE key='external_authority_id'").fetchone())
