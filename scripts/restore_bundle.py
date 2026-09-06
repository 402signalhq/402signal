#!/usr/bin/env python3
"""Validate a complete backup and restore it to a NEW isolated directory."""
import argparse
from pathlib import Path
from scripts.sqlite_bundle import restore, verify


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', required=True, type=Path)
    parser.add_argument('--expected-origin', required=True)
    parser.add_argument('--expected-vkey-file', required=True, type=Path, help='Independently trusted PUBLIC log key')
    parser.add_argument('--dest', type=Path, help='Must not exist; omit to verify only')
    args = parser.parse_args(argv)
    key = args.expected_vkey_file.read_text().strip()
    if args.dest:
        restore(args.bundle, args.dest, args.expected_origin, key)
    else:
        verify(args.bundle, args.expected_origin, key)
    print('complete bundle verified; no live files replaced')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
