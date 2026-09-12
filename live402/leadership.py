"""Router writer leadership lease.

One router process publishes: PQ log appends and anchoring, the catalog
crawler, writer housekeeping, and paid /route admission. Without the lease
those paths no-op or refuse, so stopping or replacing the writer can never
leave two publishers, two PQ trees, or doubled admission.

Backends (LIVE402_LEADERSHIP_BACKEND):
  none      implicit single-process leadership. Local development and fixtures.
  file      exclusive flock on the writer volume. A Fly volume attaches to one
            Machine, so this is the production default until the Postgres
            lease functions are installed by the replay migration owner.
  postgres  row lease in the replay Postgres (ops/router-leadership.sql),
            renewed every ~5 s and held for ~15 s by the database clock.

holds() is conservative. A renewed lease counts from the local monotonic time
taken BEFORE the renew request, minus a safety margin, so a process that stops
renewing stops believing it leads before any other holder can acquire.
"""

from __future__ import annotations

import os
import socket
import sys
import threading
import time
from typing import Callable

SLOT = "router-writer"
DEFAULT_TTL_S = 15.0
DEFAULT_RENEW_S = 5.0
SAFETY_S = 2.0
DEFAULT_LOCK_PATH = "/data/router-leadership.lock"
BACKENDS = frozenset({"none", "file", "postgres"})
FOREVER = float("inf")

PG_RENEW = "SELECT lease_holder, lease_epoch FROM signal_router.lease_renew(%s, %s, %s)"
PG_RELEASE = "SELECT signal_router.lease_release(%s, %s)"


def _log(message: str) -> None:
    sys.stderr.write("leadership %s\n" % message)


def _float_env(name: str, default: float, low: float, high: float) -> float:
    raw = (os.environ.get(name) or "").strip()
    try:
        value = float(raw) if raw else default
    except ValueError:
        value = default
    return max(low, min(high, value))


def ttl_seconds() -> float:
    return _float_env("LIVE402_LEADERSHIP_TTL_S", DEFAULT_TTL_S, 6.0, 120.0)


def renew_seconds() -> float:
    return min(_float_env("LIVE402_LEADERSHIP_RENEW_S", DEFAULT_RENEW_S, 1.0, 40.0), ttl_seconds() / 3.0)


def holder_id() -> str:
    machine = (os.environ.get("FLY_MACHINE_ID") or "").strip()
    return "%s:%d" % (machine or socket.gethostname(), os.getpid())


def backend_name() -> str:
    """Configured backend. Raises ValueError for an unknown value (fail closed)."""
    raw = (os.environ.get("LIVE402_LEADERSHIP_BACKEND") or "").strip().lower()
    if raw:
        if raw not in BACKENDS:
            raise ValueError("invalid leadership backend")
        return raw
    from live402 import fixtures

    on_fly = any((os.environ.get(k) or "").strip() for k in ("FLY_APP_NAME", "FLY_ALLOC_ID", "FLY_MACHINE_ID"))
    if on_fly and not fixtures.fixture_mode():
        return "file"
    return "none"


class NoneLease:
    name = "none"

    def acquire(self) -> float:
        return FOREVER

    def release(self) -> None:
        return None


class UnavailableLease:
    name = "unavailable"

    def acquire(self) -> None:
        return None

    def release(self) -> None:
        return None


class FileLease:
    """Exclusive advisory lock held for the life of the process.

    flock applies per open file description, so a second holder in the same
    process or another process on the same volume is refused.
    """

    name = "file"

    def __init__(self, path: str | None = None):
        self.path = path or (os.environ.get("LIVE402_LEADERSHIP_LOCK") or DEFAULT_LOCK_PATH)
        self._fd: int | None = None
        self._lock = threading.Lock()

    def acquire(self) -> float | None:
        import fcntl

        with self._lock:
            if self._fd is not None:
                return FOREVER
            try:
                fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600)
            except OSError:
                return None
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                os.close(fd)
                return None
            try:
                os.ftruncate(fd, 0)
                os.write(fd, (holder_id() + "\n").encode("utf-8"))
            except OSError:
                pass
            self._fd = fd
            return FOREVER

    def release(self) -> None:
        import fcntl

        with self._lock:
            fd, self._fd = self._fd, None
        if fd is None:
            return
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        try:
            os.close(fd)
        except OSError:
            pass


class SqlLease:
    """Row lease through injected renew/release callables.

    renew(conn, slot, holder, ttl_ms) returns (holder, epoch) when this holder
    owns the row after the call, else None. The database clock decides expiry.
    """

    name = "postgres"

    def __init__(
        self,
        connect: Callable,
        renew: Callable,
        release: Callable,
        *,
        slot: str = SLOT,
        holder: str | None = None,
        ttl_s: float | None = None,
        monotonic: Callable[[], float] = time.monotonic,
    ):
        self._connect = connect
        self._renew = renew
        self._release = release
        self.slot = slot
        self.holder = holder or holder_id()
        self.ttl_s = float(ttl_s if ttl_s is not None else ttl_seconds())
        self._monotonic = monotonic
        self._conn = None
        self.epoch: int | None = None

    def _discard(self) -> None:
        conn, self._conn = self._conn, None
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass

    def acquire(self) -> float | None:
        started = self._monotonic()
        try:
            if self._conn is None:
                self._conn = self._connect()
            row = self._renew(self._conn, self.slot, self.holder, int(self.ttl_s * 1000))
        except Exception:
            self._discard()
            return None
        if not row or row[0] != self.holder:
            return None
        self.epoch = int(row[1])
        return started + self.ttl_s - SAFETY_S

    def release(self) -> None:
        try:
            if self._conn is None:
                self._conn = self._connect()
            self._release(self._conn, self.slot, self.holder)
        except Exception:
            pass
        finally:
            self._discard()


def pg_renew(conn, slot: str, holder: str, ttl_ms: int):
    return conn.execute(PG_RENEW, (slot, holder, ttl_ms)).fetchone()


def pg_release(conn, slot: str, holder: str) -> None:
    conn.execute(PG_RELEASE, (slot, holder))


def _postgres_lease() -> SqlLease:
    import psycopg
    from psycopg.conninfo import conninfo_to_dict

    from live402.replay_postgres import validate_settings

    config, _authority = validate_settings(os.environ, conninfo_to_dict)

    def connect():
        return psycopg.connect(
            **config, autocommit=True, connect_timeout=2,
            application_name="402signal-leadership", prepare_threshold=None,
        )

    return SqlLease(connect, pg_renew, pg_release)


def _make_backend(name: str):
    if name == "none":
        return NoneLease()
    if name == "file":
        return FileLease()
    if name == "postgres":
        return _postgres_lease()
    raise ValueError("invalid leadership backend")


_state_lock = threading.Lock()
_start_lock = threading.Lock()
_backend = None
_backend_label = "unstarted"
_valid_until = 0.0
_thread: threading.Thread | None = None
_stop = threading.Event()
_callbacks: list[Callable[[], None]] = []


def holds() -> bool:
    """True only while this process may publish or admit paid work."""
    with _state_lock:
        backend = _backend
        until = _valid_until
    if backend is None:
        try:
            return backend_name() == "none"
        except ValueError:
            return False
    return time.monotonic() < until


def _attempt() -> bool:
    global _valid_until
    with _state_lock:
        backend = _backend
    if backend is None:
        return False
    try:
        until = backend.acquire()
    except Exception:
        until = None
    with _state_lock:
        was_held = time.monotonic() < _valid_until
        if until is not None:
            _valid_until = until
        now_held = time.monotonic() < _valid_until
        label = _backend_label
    if now_held and not was_held:
        _log("acquired backend=%s" % label)
        for callback in list(_callbacks):
            try:
                callback()
            except Exception as exc:
                _log("on_acquire_error kind=%s" % type(exc).__name__)
    elif was_held and not now_held:
        _log("lost backend=%s" % label)
    return now_held


def _loop() -> None:
    while not _stop.wait(renew_seconds()):
        try:
            _attempt()
        except Exception:
            continue


def start(on_acquire=()) -> bool:
    """Select the backend, try once synchronously, then renew in the background."""
    global _backend, _backend_label, _thread
    with _start_lock:
        if _thread is not None and _thread.is_alive():
            return holds()
        try:
            name = backend_name()
            backend = _make_backend(name)
        except Exception as exc:
            _log("backend_unavailable kind=%s" % type(exc).__name__)
            name, backend = "unavailable", UnavailableLease()
        _callbacks[:] = list(on_acquire)
        with _state_lock:
            _backend = backend
            _backend_label = name
        _stop.clear()
        held = _attempt()
        if not held:
            _log("standby backend=%s" % name)
        _thread = threading.Thread(target=_loop, name="leadership", daemon=True)
        _thread.start()
        return held


def release() -> None:
    """Stop renewing and give up the lease (graceful shutdown)."""
    global _valid_until
    _stop.set()
    with _state_lock:
        backend = _backend
        _valid_until = 0.0
    if backend is not None:
        try:
            backend.release()
        except Exception:
            pass
        _log("released")


def status() -> dict:
    with _state_lock:
        label = _backend_label
    return {"backend": label, "held": holds()}


def reset_for_tests() -> None:
    global _backend, _backend_label, _thread, _valid_until
    release()
    thread = _thread
    if thread is not None:
        thread.join(timeout=2)
    with _state_lock:
        _backend = None
        _backend_label = "unstarted"
        _valid_until = 0.0
    _thread = None
    _callbacks.clear()
    _stop.clear()
