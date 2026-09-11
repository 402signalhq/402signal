#!/usr/bin/env python3
"""One-shot PostgreSQL replay readiness. Not admission. Not a cutover.

Run from a console that holds the runtime DSN and authority id. Do not attach
those secrets to the live sqlite writer; conflicting env fails /ready.
Prints {"ok": true|false} only. Never a DSN, host, password, or exception.
"""
from __future__ import annotations

import json
import os
import sys

from live402.replay_store import StoreError


def stage_ready(environ: dict | None = None) -> bool:
    env = os.environ if environ is None else environ
    serving = (env.get("LIVE402_REPLAY_BACKEND") or "sqlite").strip() or "sqlite"
    on_fly = any(env.get(key) for key in ("FLY_APP_NAME", "FLY_ALLOC_ID", "FLY_MACHINE_ID"))
    if serving != "postgres" and on_fly:
        raise StoreError("do not attach a DSN to the live sqlite writer")
    from live402.replay_postgres import PostgresStore
    return bool(PostgresStore(environ=env).ready())


def main() -> int:
    try:
        print(json.dumps({"ok": stage_ready()}))
        return 0
    except (StoreError, OSError, ValueError):
        print(json.dumps({"ok": False}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
