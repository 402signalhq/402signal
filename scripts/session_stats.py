#!/usr/bin/env python3
"""Print the private rollup input from the active session store as JSON. Operator-only.

    PYTHONPATH=. python3 scripts/session_stats.py --days 7 > session-stats.json
    PYTHONPATH=. python3 scripts/organic_rollup.py --session-stats session-stats.json

Runs where the store is reachable: on the router machine for the SQLite file,
or wherever the replay connection settings are configured for the shared
store (LIVE402_SESSION_BACKEND=postgres). The output holds coarse numbers
only: opens, hops, counter names with totals and one distinct payer count.
Never a payer hash, a token, a window or a subscription.
"""
from __future__ import annotations

import argparse
import json
import sys
import time

from live402 import session


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--days", type=int, default=7, help="trailing window, 1 to 92 (default 7)")
    parser.add_argument("--until", type=int, default=None, help="end of the window as a unix time (default now)")
    args = parser.parse_args(argv)
    until = int(args.until or time.time())
    since = until - max(1, min(92, int(args.days))) * 86400
    try:
        stats = session.rollup_stats(since, until)
        backend = session.backend_name()
    except (session.StoreUnavailable, ValueError):
        print(json.dumps({"ok": False, "error": "session store unavailable"}), file=sys.stdout)
        return 1
    print(json.dumps({"ok": True, "backend": backend, **stats}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
