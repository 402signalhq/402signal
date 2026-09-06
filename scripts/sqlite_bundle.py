"""Complete SQLite recovery bundles. No keys, automatic restore, or live sends."""
from __future__ import annotations

from contextlib import ExitStack, closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import time
import uuid

ROLES = ('replay', 'catalog', 'history', 'pq_log')
REQUIRED_TABLES = {'replay': {'settle_ledger', 'replay_meta'}, 'catalog': {'resources', 'accept_claims'},
                   'history': {'probes', 'observations'}, 'pq_log': {'leaves', 'meta', 'checkpoints'}}


def connect(path: Path, mode='ro'):
    return sqlite3.connect(path.resolve().as_uri() + '?mode=' + mode, uri=True, timeout=5)


def digest(path: Path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def describe(path: Path, role: str):
    with closing(connect(path)) as c:
        if c.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise ValueError('database integrity check failed')
        schema = c.execute("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()
        tables = {row[0] for row in schema}
        if not REQUIRED_TABLES[role] <= tables:
            raise ValueError('required database role schema missing')
        result = {'sha256': digest(path), 'bytes': path.stat().st_size,
                  'schema_sha256': hashlib.sha256(json.dumps(schema).encode()).hexdigest(),
                  'user_version': c.execute('PRAGMA user_version').fetchone()[0]}
        if role == 'pq_log':
            result['identity'] = dict(c.execute("SELECT k,v FROM meta WHERE k IN ('origin','vkey','size')").fetchall())
            if not result['identity'].get('origin') or not result['identity'].get('vkey'):
                raise ValueError('public transparency identity missing')
        if role == 'replay':
            result['states'] = dict(c.execute('SELECT state,count(*) FROM settle_ledger GROUP BY state').fetchall())
        return result


def backup(sources: dict[str, Path], destination: Path):
    if set(sources) != set(ROLES):
        raise ValueError('all four databases are required')
    paths = [sources[r].resolve(strict=True) for r in ROLES]
    if len(set(paths)) != len(ROLES) or any(not p.is_file() for p in paths):
        raise ValueError('distinct existing database files are required')
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    bundle = destination / (time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + uuid.uuid4().hex[:12])
    bundle.mkdir(mode=0o700)
    manifest = {'format': '402signal-recovery-v1', 'complete': False,
                'consistency': 'all-writers-locked-replay-first', 'created_at': int(time.time()), 'databases': {}}
    # Blocking the replay writer first prevents any new economic action. An
    # already-submitted transfer retains its pending tombstone in the snapshot.
    # Hold every SQLite writer lock until all independent read snapshots finish.
    with ExitStack() as stack:
        for path in paths:
            lock = stack.enter_context(closing(connect(path, 'rw')))
            lock.execute('BEGIN IMMEDIATE')
        for role, path in zip(ROLES, paths):
            target = bundle / (role + '.sqlite')
            with closing(connect(path)) as source, closing(sqlite3.connect(target)) as sink:
                source.backup(sink, pages=256, sleep=0.01)
            os.chmod(target, 0o600)
            manifest['databases'][role] = {'file': target.name, **describe(target, role)}
    manifest['complete'] = True
    target = bundle / 'manifest.json'
    with target.open('x', encoding='utf-8') as f:
        json.dump(manifest, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(target, 0o600)
    return bundle


def verify(bundle: Path, expected_origin: str, expected_vkey: str):
    manifest = json.loads((bundle / 'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('format') != '402signal-recovery-v1' or manifest.get('complete') is not True:
        raise ValueError('incomplete recovery bundle')
    if manifest.get('consistency') != 'all-writers-locked-replay-first' or set(manifest.get('databases', {})) != set(ROLES):
        raise ValueError('incomplete database set or inconsistent snapshot')
    for role in ROLES:
        item = manifest['databases'][role]
        if item.get('file') != role + '.sqlite':
            raise ValueError('unexpected snapshot filename')
        path = bundle / item['file']
        if path.is_symlink() or path.resolve().parent != bundle.resolve():
            raise ValueError('snapshot path escapes bundle')
        actual = describe(path, role)
        if any(item.get(key) != value for key, value in actual.items()):
            raise ValueError('snapshot digest or metadata mismatch')
    identity = manifest['databases']['pq_log']['identity']
    if identity.get('origin') != expected_origin or identity.get('vkey') != expected_vkey:
        raise ValueError('recovery log identity does not match independently trusted values')
    return manifest


def restore(bundle: Path, destination: Path, expected_origin: str, expected_vkey: str):
    manifest = verify(bundle, expected_origin, expected_vkey)
    # A restore rehearsal only creates a new directory. An operator promotes
    # the verified set with the service stopped; no per-file live replacement.
    destination.mkdir(parents=False, exist_ok=False, mode=0o700)
    for role in ROLES:
        shutil.copyfile(bundle / manifest['databases'][role]['file'], destination / (role + '.sqlite'))
        os.chmod(destination / (role + '.sqlite'), 0o600)
        with (destination / (role + '.sqlite')).open('rb') as f:
            os.fsync(f.fileno())
    shutil.copyfile(bundle / 'manifest.json', destination / 'manifest.json')
    os.chmod(destination / 'manifest.json', 0o600)
    verify(destination, expected_origin, expected_vkey)
    return destination
