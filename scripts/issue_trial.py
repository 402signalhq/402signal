#!/usr/bin/env python3
"""Issue a hosted trial credit. Prints the bearer once. Stores only sha256.

Operator-only. There is no HTTP mint. Do not commit the printed token.
"""
from __future__ import annotations

import argparse
import sys

from live402 import session


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Issue a hashed trial credit")
    parser.add_argument("--ttl-hours", type=int, default=48)
    args = parser.parse_args(argv)
    if not 1 <= args.ttl_hours <= 48:
        print("ttl-hours must be 1..48", file=sys.stderr)
        return 2
    token = session.issue_trial(ttl_s=args.ttl_hours * 3600)
    print(token)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
