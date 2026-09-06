#!/usr/bin/env python3
"""Create a complete, integrity-checked SQLite recovery bundle."""
import argparse
import os
from pathlib import Path
import sqlite3
from scripts.sqlite_bundle import backup


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dest', required=True, type=Path)
    args = parser.parse_args(argv)
    defaults = {'replay': ('LIVE402_REPLAY_DB', '/data/live402-replay.sqlite'),
                'catalog': ('LIVE402_CATALOG_DB', '/data/catalog.sqlite'),
                'history': ('LIVE402_HISTORY_DB', '/data/live402-history.sqlite'),
                'pq_log': ('LIVE402_PQ_LOG_DB', '/data/pq-log-mainnet.sqlite')}
    sources = {role: Path(os.environ.get(env) or default) for role, (env, default) in defaults.items()}
    try:
        result = backup(sources, args.dest)
    except (OSError, ValueError, sqlite3.Error):
        print('backup incomplete; no restorable manifest published')
        return 1
    print('verified recovery bundle: ' + str(result))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
