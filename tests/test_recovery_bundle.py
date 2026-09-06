import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from live402 import replay
from scripts.sqlite_bundle import backup, restore, verify


class RecoveryBundleTests(unittest.TestCase):
    def test_complete_restore_retains_unknown_and_settled_authorizations(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            sources = {}
            for role in ('catalog', 'history', 'pq_log'):
                path = root / (role + '.sqlite')
                with sqlite3.connect(path) as c:
                    if role == 'catalog':
                        c.executescript('CREATE TABLE resources (n INTEGER); CREATE TABLE accept_claims (n INTEGER);')
                    if role == 'history':
                        c.executescript('CREATE TABLE probes (n INTEGER); CREATE TABLE observations (n INTEGER);')
                    if role == 'pq_log':
                        c.executescript('CREATE TABLE leaves (n INTEGER); CREATE TABLE meta (k TEXT, v TEXT); CREATE TABLE checkpoints (n INTEGER);')
                        c.executemany('INSERT INTO meta VALUES (?,?)', [('origin', 'synthetic-log'), ('vkey', 'synthetic-public-key')])
                sources[role] = path
            sources['replay'] = root / 'replay.sqlite'
            with patch.dict(os.environ, LIVE402_REPLAY_DB=str(sources['replay']), LIVE402_FIXTURE='1'):
                replay.reset_memory()
                replay.begin('settled', scope='private')
                replay.finish('settled', (200, {'live': True}, None), True)
                replay.begin('unknown', scope='private')
                replay.abandon('unknown')
                replay.reset_memory()
            bundle = backup(sources, root / 'backups')
            restored = restore(bundle, root / 'restored', 'synthetic-log', 'synthetic-public-key')
            with patch.dict(os.environ, LIVE402_REPLAY_DB=str(restored / 'replay.sqlite'), LIVE402_FIXTURE='1'):
                replay.reset_memory()
                self.assertNotEqual(replay.begin('settled', scope='different')[0], 'run')
                self.assertEqual(replay.begin('unknown', scope='private')[0], 'reject')
                replay.reset_memory()
            with self.assertRaises(ValueError):
                verify(bundle, 'different-log', 'synthetic-public-key')
            manifest = json.loads((bundle / 'manifest.json').read_text())
            manifest['databases'].pop('replay')
            (bundle / 'manifest.json').write_text(json.dumps(manifest))
            with self.assertRaises(ValueError):
                restore(bundle, root / 'incomplete', 'synthetic-log', 'synthetic-public-key')
            self.assertFalse((root / 'incomplete').exists())

    def test_missing_database_fails_before_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(ValueError):
                backup({}, Path(temp) / 'backups')
