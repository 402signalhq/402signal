"""Persistence boundary for payment replay protection. No payment interpretation.

A reservation returning True is a committed admission, never a queue promise.
Backend errors must not trigger a retry against a different database.
"""
from __future__ import annotations

import os
import sqlite3
import time
from typing import Callable, Protocol


class StoreError(RuntimeError):
    """Safe-to-report coarse error; never include a DSN or provider exception."""


Record = tuple[str, str | None, int, str | None, float | None]


class ReplayStore(Protocol):
    def lookup(self, key: str) -> Record | None: ...
    def reserve(self, key: str, scope: str | None, expires: float) -> bool: ...
    def finish(self, key: str, state: str, outcome: str | None, keep: bool) -> None: ...
    def abandon(self, key: str) -> None: ...
    def ready(self) -> bool: ...
    def close(self) -> None: ...


def backend_name() -> str:
    name = os.environ.get("LIVE402_REPLAY_BACKEND", "sqlite").strip()
    if name not in {"sqlite", "postgres"}:
        raise StoreError("invalid replay backend")
    if name == "sqlite" and any(os.environ.get(key) for key in (
            "LIVE402_REPLAY_POSTGRES_DSN", "LIVE402_REPLAY_AUTHORITY_ID")):
        raise StoreError("conflicting replay backend configuration")
    return name


class SQLiteStore:
    """Compatibility adapter. Caller owns the process lock, callbacks and schema.

    This keeps existing SQLite tests and migration behavior intact. A shared
    filesystem is not a supported multi-host PostgreSQL substitute.
    """
    def __init__(self, connect: Callable, capacity: Callable, identity: Callable,
                 ready: Callable):
        self.connect = connect
        self.capacity = capacity
        self.identity = identity
        self.readiness = ready

    def lookup(self, key: str) -> Record | None:
        return self.connect().execute(
            "SELECT state,outcome_json,fingerprint_version,scope_hash,expires_at "
            "FROM settle_ledger WHERE fp_hash = ?", (key,),
        ).fetchone()

    def reserve(self, key: str, scope: str | None, expires: float) -> bool:
        conn = self.connect()
        try:
            # Serialize the identity check with the reservation. A migration
            # fence installed by another connection must win before admission.
            conn.execute("BEGIN IMMEDIATE")
            if not self.identity(conn):
                conn.rollback()
                return False
            conn.execute("UPDATE settle_ledger SET outcome_json = NULL WHERE "
                         "outcome_json IS NOT NULL AND (expires_at IS NULL OR expires_at <= ?)",
                         (time.time(),))
            if not self.capacity(conn):
                conn.rollback()
                return False
            conn.execute("INSERT INTO settle_ledger "
                         "(fp_hash,state,outcome_json,created_at,fingerprint_version,scope_hash,expires_at) "
                         "VALUES (?, 'settlement_pending', NULL, ?, 2, ?, ?)",
                         (key, time.time(), scope, expires))
            conn.commit()
            return True
        except BaseException:
            conn.rollback()
            raise

    def finish(self, key: str, state: str, outcome: str | None, keep: bool) -> None:
        conn = self.connect()
        try:
            if keep:
                conn.execute("UPDATE settle_ledger SET state = ?, outcome_json = "
                             "CASE WHEN scope_hash IS NULL THEN NULL ELSE ? END WHERE fp_hash = ?",
                             (state, outcome, key))
            else:
                # Existing contract: only a 400 before any economic action.
                conn.execute("DELETE FROM settle_ledger WHERE fp_hash = ?", (key,))
            conn.commit()
        except BaseException:
            conn.rollback()
            raise

    def abandon(self, key: str) -> None:
        conn = self.connect()
        try:
            conn.execute("UPDATE settle_ledger SET state = 'unknown' WHERE fp_hash = ? "
                         "AND state IN ('settlement_pending','unknown')", (key,))
            conn.commit()
        except BaseException:
            conn.rollback()
            raise

    def ready(self) -> bool:
        return bool(self.readiness())

    def close(self) -> None:
        # The existing replay module owns this connection.
        pass
