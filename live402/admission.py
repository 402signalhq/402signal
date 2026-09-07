"""Bounded work admission. Production policy lives outside the public package.

This initial backend is process-local and supports one router process only.
It is not a distributed quota authority. Configured engines start with empty
allowances, refilling with elapsed uptime so restart cannot reset spent budget.
A restart can conservatively discard earned capacity. The transport and
payment/replay controls remain authoritative. An absent policy preserves the
legacy behavior; a configured but invalid policy fails closed.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import threading
import time
from urllib.parse import urlsplit

from live402 import reqctx

class Unavailable(Exception):
    pass

def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("invalid capacity")
    if not math.isfinite(value) or not 0 < value <= 10000000:
        raise ValueError("invalid capacity")
    return float(value)

class Policy:
    def __init__(self, value):
        required = {"version", "window_seconds", "max_keys", "ingress", "unpaid", "target", "customers"}
        if not isinstance(value, dict) or set(value) != required or value["version"] != 1:
            raise ValueError("invalid policy")
        self.window = _number(value["window_seconds"])
        self.max_keys = value["max_keys"]
        if isinstance(self.max_keys, bool) or not isinstance(self.max_keys, int) or not 16 <= self.max_keys <= 100000:
            raise ValueError("invalid key bound")
        self.ingress = self._capacities(value["ingress"], {"global", "anonymous"})
        self.unpaid = self._capacities(value["unpaid"], {"global", "anonymous"})
        self.target = self._capacities(value["target"], {"global", "origin", "failures"})
        self.customers = value["customers"]
        if not isinstance(self.customers, dict) or len(self.customers) > self.max_keys // 4:
            raise ValueError("invalid customers")
        for digest, capacity in self.customers.items():
            if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
                raise ValueError("invalid credential digest")
            self._capacities(capacity, {"ingress", "unpaid"})

    @staticmethod
    def _capacities(value, keys):
        if not isinstance(value, dict) or set(value) != keys:
            raise ValueError("invalid capacity map")
        out = {k: _number(v) for k, v in value.items()}
        if any(v < 1 for v in out.values()):
            raise ValueError("capacity must admit whole work units")
        return out

class Bucket:
    def __init__(self, capacity, now):
        self.capacity = capacity
        self.balance = capacity
        self.at = now

    def refresh(self, now, window):
        self.balance = min(self.capacity, self.balance + max(0, now - self.at) * self.capacity / window)
        self.at = max(now, self.at)

class Lease:
    def __init__(self, engine, buckets):
        self.engine = engine
        self.buckets = buckets
        self.finished = False

    def finish(self, earned=False):
        with self.engine.lock:
            if self.finished:
                return
            self.finished = True
            if earned:
                for bucket in self.buckets:
                    bucket.balance = min(bucket.capacity, bucket.balance + 1)

class Engine:
    def __init__(self, policy, clock=time.monotonic, *, cold_start=False):
        self.policy = policy
        self.clock = clock
        self.started_at = clock() if cold_start else None
        self.lock = threading.Lock()
        self.buckets = {}

    def take(self, specifications):
        with self.lock:
            now = self.clock()
            requested = dict(specifications)
            missing = [key for key in requested if key not in self.buckets]
            if len(self.buckets) + len(missing) > self.policy.max_keys:
                for key, bucket in list(self.buckets.items()):
                    bucket.refresh(now, self.policy.window)
                    if bucket.balance >= bucket.capacity and key not in requested:
                        del self.buckets[key]
                if len(self.buckets) + len(missing) > self.policy.max_keys:
                    return None
            for key, capacity in requested.items():
                bucket = self.buckets.get(key)
                if bucket is not None:
                    bucket.refresh(now, self.policy.window)
                    if bucket.balance < 1:
                        return None
                elif self._initial_balance(capacity, now) < 1:
                    return None
            buckets = []
            for key, capacity in requested.items():
                bucket = self.buckets.get(key)
                if bucket is None:
                    bucket = Bucket(capacity, now)
                    bucket.balance = self._initial_balance(capacity, now)
                    self.buckets[key] = bucket
                bucket.balance -= 1
                buckets.append(bucket)
            return Lease(self, buckets)

    def _initial_balance(self, capacity, now):
        if self.started_at is None:
            return capacity
        return min(capacity, max(0, now - self.started_at) * capacity / self.policy.window)

    def identity(self, headers, peer):
        raw = None
        if hasattr(headers, "get_all"):
            values = headers.get_all("X-402Signal-Key", [])
            if len(values) == 1:
                raw = values[0]
        else:
            values = [v for k, v in (headers or {}).items() if str(k).lower() == "x-402signal-key"]
            if len(values) == 1:
                raw = values[0]
        if isinstance(raw, str) and re.fullmatch(r"[A-Za-z0-9_-]{32,128}", raw):
            digest = hashlib.sha256(raw.encode()).hexdigest()
            if digest in self.policy.customers:
                return "customer:" + digest, self.policy.customers[digest]
        # Peer identity must come from server transport, never caller headers.
        key = hashlib.sha256(str(peer or "unknown").encode()).hexdigest()
        return "anonymous:" + key, None

    def ingress(self, headers, peer):
        identity, customer = self.identity(headers, peer)
        cap = customer["ingress"] if customer else self.policy.ingress["anonymous"]
        return self.take([("ingress:global", self.policy.ingress["global"]), ("ingress:" + identity, cap)]) is not None

    def reserve(self, headers, peer):
        identity, customer = self.identity(headers, peer)
        cap = customer["unpaid"] if customer else self.policy.unpaid["anonymous"]
        return self.take([("unpaid:global", self.policy.unpaid["global"]), ("unpaid:" + identity, cap)])

    def probe(self, url):
        parsed = urlsplit(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            return None
        origin = parsed.hostname.lower().rstrip(".") + ":" + str(parsed.port or 443)
        origin = hashlib.sha256(origin.encode()).hexdigest()
        # Queries and paths cannot rotate a host's budget. Separate origins can
        # still consume only the configured global work capacity.
        return self.take([("probe:global", self.policy.target["global"]), ("probe:" + origin, self.policy.target["origin"]), ("failure:" + origin, self.policy.target["failures"])])

    def probe_complete(self, lease, healthy):
        # Healthy protocol observations restore only the target failure budget,
        # never customer unpaid credit or the global work allowance.
        with self.lock:
            if lease.finished:
                return
            lease.finished = True
            if healthy:
                bucket = lease.buckets[-1]
                bucket.balance = min(bucket.capacity, bucket.balance + 1)

_lock = threading.Lock()
_loaded_path = None
_engine = None
_failed = False

def configured():
    return bool(os.environ.get("LIVE402_ADMISSION_POLICY_FILE"))

def engine():
    global _loaded_path, _engine, _failed
    path = os.environ.get("LIVE402_ADMISSION_POLICY_FILE")
    if not path:
        return None
    with _lock:
        if _loaded_path != path:
            _loaded_path, _engine, _failed = path, None, True
            try:
                p = Path(path)
                if not p.is_absolute():
                    raise ValueError("private policy file required")
                fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
                with os.fdopen(fd, "r") as source:
                    info = os.fstat(source.fileno())
                    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 65536 or info.st_uid not in (0, os.geteuid()):
                        raise ValueError("private policy file required")
                    raw = source.read(65537)
                    if len(raw.encode()) > 65536:
                        raise ValueError("private policy file required")
                _engine = Engine(Policy(json.loads(raw)), cold_start=True)
                _failed = False
            except Exception:
                pass
        if _failed:
            raise Unavailable("admission policy unavailable")
        return _engine

def ingress(headers, peer):
    try:
        e = engine()
        return e is not None and e.ingress(headers, peer)
    except Exception:
        return False

def reserve(headers):
    e = engine()
    if e is None:
        return None
    lease = e.reserve(headers, reqctx.peer_ip.get())
    if lease is None:
        raise Unavailable("work capacity unavailable")
    return lease

def reserve_probe(url):
    e = engine()
    if e is None:
        return None
    lease = e.probe(url)
    if lease is None:
        raise Unavailable("work capacity unavailable")
    return lease

def rejected():
    return 429, {"error": "work capacity unavailable", "retryable": True}, {"Retry-After": "60", "Cache-Control": "no-store"}


def free_ingress(headers, peer):
    try:
        e = engine()
        if e is None or not e.ingress(headers, peer):
            return False
        lease = e.reserve(headers, peer)
        if lease is None:
            return False
        lease.finish(False)
        return True
    except Exception:
        return False

def ready():
    try:
        engine()
        return True
    except Exception:
        return False
