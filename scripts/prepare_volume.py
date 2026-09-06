#!/usr/bin/env python3
"""Plan or apply the one-time, stopped-router UID migration. Never recursive."""
import argparse
import json
import os
import stat
from pathlib import Path

UID = GID = 10001
DATABASES = ('catalog.sqlite', 'live402-history.sqlite', 'live402-replay.sqlite',
             'pq-log-mainnet.sqlite', 'pq-log.sqlite')


def plan(root: Path) -> list[Path]:
    if root.is_symlink() or not root.is_absolute() or not root.is_dir():
        raise ValueError('an absolute, existing, non-symlink volume directory is required')
    root = root.resolve(strict=True)
    targets = [root]
    for name in DATABASES:
        for suffix in ('', '-wal', '-shm', '-journal'):
            p = root / (name + suffix)
            if p.is_symlink():
                raise ValueError('symlink refused')
            if p.exists():
                if not p.is_file() or p.resolve().parent != root or p.stat().st_nlink != 1:
                    raise ValueError('non-regular or linked database refused')
                targets.append(p)
    if not (root / 'live402-replay.sqlite').is_file():
        raise ValueError('existing replay ledger required; do not create a replacement')
    return targets


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--volume', type=Path, default=Path('/data'))
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--router-stopped', action='store_true')
    args = parser.parse_args(argv)
    targets = plan(args.volume)
    changes = [dict(path=str(p), previous_uid=p.stat().st_uid, previous_gid=p.stat().st_gid,
                    previous_mode=stat.S_IMODE(p.stat().st_mode), uid=UID, gid=GID) for p in targets]
    print(json.dumps({'apply': args.apply, 'changes': changes}, indent=2))
    if args.apply:
        if not args.router_stopped or os.geteuid() != 0:
            raise ValueError('stop the router and run migration as the volume administrator')
        # Review and save the plan plus verified backup before using --apply.
        for p in targets:
            os.chown(p, UID, GID, follow_symlinks=False)
            os.chmod(p, 0o700 if p.is_dir() else 0o600, follow_symlinks=False)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
