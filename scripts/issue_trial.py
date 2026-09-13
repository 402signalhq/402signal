#!/usr/bin/env python3
"""Issue a hosted check credit (API key, v0). Prints the bearer once. Stores only sha256.

Operator-only. There is no HTTP mint. Do not commit the printed token.

A credit lets a caller run listed-URL checks with the X-402Signal-Trial header
instead of paying the $0.003 fee. Checks stay bounded by the same admission
limits, call no facilitator, and are recorded as sponsored traffic that never
moves public reliability data. Re-issuing an existing token (--token) refreshes
its expiry and raises its ceiling without resetting what it already used.
"""
from __future__ import annotations

import argparse
import sys

from live402 import session


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Issue a hashed check credit")
    parser.add_argument("--ttl-hours", type=int, default=48, help="1 to 720 (30 days); default 48")
    parser.add_argument("--opens", type=int, default=session.TRIAL_OPEN_CEILING,
                        help="listed-URL checks the credit may open; 1 to %d" % session.TRIAL_OPEN_MAX)
    parser.add_argument("--token", default=None, help="re-issue an existing token (top-up); never logged")
    args = parser.parse_args(argv)
    if not 1 <= args.ttl_hours <= session.TRIAL_TTL_MAX_S // 3600:
        print("ttl-hours must be 1..%d" % (session.TRIAL_TTL_MAX_S // 3600), file=sys.stderr)
        return 2
    if not 1 <= args.opens <= session.TRIAL_OPEN_MAX:
        print("opens must be 1..%d" % session.TRIAL_OPEN_MAX, file=sys.stderr)
        return 2
    try:
        token = session.issue_trial(args.token, ttl_s=args.ttl_hours * 3600, opens=args.opens)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    print(token)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
