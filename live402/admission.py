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

# Unpaid preview/validate/catalog plus unpaid GET /route challenge and MCP
# handshake admission. Separate bucket namespace from paid /route ingress and
# unpaid work reserve. Numeric defaults live in code so image-only deploys do
# not require a machine policy-file rewrite.
DISCOVERY_GLOBAL = 24
# Image-only default. One anonymous identity can finish a cold MCP
# setup (initialize, initialized, tools/list) and still run preview
# and validate. Not a published production quota.
MCP_COLD_SETUP = 3
MCP_COLD_FREE_TOOLS = 2
DISCOVERY_ANONYMOUS = MCP_COLD_SETUP + MCP_COLD_FREE_TOOLS
DISCOVERY_ANONYMOUS_TOTAL = 16
DISCOVERY_CUSTOMER = 8
# Paid work, unpaid discovery, recovery, trial, and session-hop each have
# an independent map capped at policy.max_keys. Combined resident counters
# stay within this many maps times max_keys.
COUNTER_POOLS = 5
TRIAL_GLOBAL = 12
TRIAL_TOKEN = 5
SESSION_HOP_GLOBAL = 40
SESSION_HOP_WINDOW = 20

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
        if not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] not in (1, 2):
            raise ValueError("invalid policy")
        self.version = value["version"]
        if self.version == 2:
            required |= {"anonymous_totals", "recovery"}
        if set(value) != required:
            raise ValueError("invalid policy")
        self.window = _number(value["window_seconds"])
        self.max_keys = value["max_keys"]
        if isinstance(self.max_keys, bool) or not isinstance(self.max_keys, int) or not 16 <= self.max_keys <= 100000:
            raise ValueError("invalid key bound")
        self.ingress = self._capacities(value["ingress"], {"global", "anonymous"})
        self.unpaid = self._capacities(value["unpaid"], {"global", "anonymous"})
        self.target = self._capacities(value["target"], {"global", "origin", "failures"})
        self.anonymous_totals = None
        if self.version == 2:
            self.anonymous_totals = self._capacities(value["anonymous_totals"], {"ingress", "unpaid"})
            if (self.anonymous_totals["ingress"] >= self.ingress["global"]
                    or self.anonymous_totals["unpaid"] >= self.unpaid["global"]):
                raise ValueError("anonymous capacity must leave shared headroom")
        self.recovery = self._capacities(value.get("recovery", {
            "global": 60, "anonymous_total": 45, "anonymous": 6, "customer": 12,
        }), {"global", "anonymous_total", "anonymous", "customer"})
        if self.recovery["anonymous_total"] >= self.recovery["global"]:
            raise ValueError("anonymous recovery must leave shared headroom")
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
        self.recovery_buckets = {}
        self.discovery_buckets = {}
        self.trial_buckets = {}
        self.hop_buckets = {}
        self.pinned = set()
        if policy.version == 2:
            initial = {"ingress:global": policy.ingress["global"],
                       "unpaid:global": policy.unpaid["global"],
                       "ingress:anonymous-total": policy.anonymous_totals["ingress"],
                       "unpaid:anonymous-total": policy.anonymous_totals["unpaid"]}
            for digest, caps in policy.customers.items():
                initial["ingress:customer:" + digest] = caps["ingress"]
                initial["unpaid:customer:" + digest] = caps["unpaid"]
            self._preallocate(self.buckets, initial)
            self.pinned = set(initial)
        initial = {"recovery:global": policy.recovery["global"],
                   "recovery:anonymous-total": policy.recovery["anonymous_total"]}
        initial.update({"recovery:customer:" + digest: policy.recovery["customer"]
                        for digest in policy.customers})
        self._preallocate(self.recovery_buckets, initial)
        self.recovery_pinned = set(initial)
        discovery_initial = {"discovery:global": DISCOVERY_GLOBAL}
        if policy.version == 2:
            discovery_initial["discovery:anonymous-total"] = DISCOVERY_ANONYMOUS_TOTAL
        self._preallocate(self.discovery_buckets, discovery_initial)
        self.discovery_pinned = set(discovery_initial)
        trial_initial = {"trial:global": TRIAL_GLOBAL}
        self._preallocate(self.trial_buckets, trial_initial)
        self.trial_pinned = set(trial_initial)
        hop_initial = {"session-hop:global": SESSION_HOP_GLOBAL}
        self._preallocate(self.hop_buckets, hop_initial)
        self.hop_pinned = set(hop_initial)

    def counter_slot_bound(self):
        return COUNTER_POOLS * self.policy.max_keys

    def _preallocate(self, pool, specifications):
        now = self.clock()
        for key, capacity in specifications.items():
            bucket = Bucket(capacity, now)
            bucket.balance = self._initial_balance(capacity, now)
            pool[key] = bucket

    def take(self, specifications, *, recovery=False, discovery=False, trial=False, hop=False):
        with self.lock:
            if recovery:
                pool, pinned = self.recovery_buckets, self.recovery_pinned
            elif discovery:
                pool, pinned = self.discovery_buckets, self.discovery_pinned
            elif trial:
                pool, pinned = self.trial_buckets, self.trial_pinned
            elif hop:
                pool, pinned = self.hop_buckets, self.hop_pinned
            else:
                pool, pinned = self.buckets, self.pinned
            now = self.clock()
            requested = dict(specifications)
            missing = [key for key in requested if key not in pool]
            if len(pool) + len(missing) > self.policy.max_keys:
                for key, bucket in list(pool.items()):
                    bucket.refresh(now, self.policy.window)
                    if bucket.balance >= bucket.capacity and key not in requested and key not in pinned:
                        del pool[key]
                if len(pool) + len(missing) > self.policy.max_keys:
                    return None
            for key, capacity in requested.items():
                bucket = pool.get(key)
                if bucket is not None:
                    bucket.refresh(now, self.policy.window)
                    if bucket.balance < 1:
                        return None
                elif self._initial_balance(capacity, now) < 1:
                    return None
            buckets = []
            for key, capacity in requested.items():
                bucket = pool.get(key)
                if bucket is None:
                    bucket = Bucket(capacity, now)
                    bucket.balance = self._initial_balance(capacity, now)
                    pool[key] = bucket
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
        specifications = [("ingress:global", self.policy.ingress["global"]), ("ingress:" + identity, cap)]
        if not customer and self.policy.anonymous_totals is not None:
            specifications.append(("ingress:anonymous-total", self.policy.anonymous_totals["ingress"]))
        return self.take(specifications) is not None

    def reserve(self, headers, peer):
        identity, customer = self.identity(headers, peer)
        cap = customer["unpaid"] if customer else self.policy.unpaid["anonymous"]
        specifications = [("unpaid:global", self.policy.unpaid["global"]), ("unpaid:" + identity, cap)]
        if not customer and self.policy.anonymous_totals is not None:
            specifications.append(("unpaid:anonymous-total", self.policy.anonymous_totals["unpaid"]))
        return self.take(specifications)

    def recover(self, headers, peer):
        identity, customer = self.identity(headers, peer)
        cap = self.policy.recovery["customer" if customer else "anonymous"]
        specifications = [("recovery:global", self.policy.recovery["global"]),
                          ("recovery:" + identity, cap)]
        if not customer:
            specifications.append(("recovery:anonymous-total", self.policy.recovery["anonymous_total"]))
        # Recovery has its own bounded pool and never replenishes economic work.
        return self.take(specifications, recovery=True) is not None

    def discover(self, headers, peer):
        """Reserve unpaid discovery. Never debits ingress or unpaid route work.

        Covers preview, validate, unpaid GET /route challenge construction, and
        MCP handshake / unknown free methods. Paid /route stays on ingress.
        """
        identity, customer = self.identity(headers, peer)
        cap = DISCOVERY_CUSTOMER if customer else DISCOVERY_ANONYMOUS
        specifications = [("discovery:global", DISCOVERY_GLOBAL), ("discovery:" + identity, cap)]
        if not customer and self.policy.version == 2:
            specifications.append(("discovery:anonymous-total", DISCOVERY_ANONYMOUS_TOTAL))
        return self.take(specifications, discovery=True)

    def trial(self, headers, peer, token_hash: str):
        """Separate ceiling so trial opens cannot starve organic /route."""
        identity, _customer = self.identity(headers, peer)
        digest = token_hash if re.fullmatch(r"[0-9a-f]{64}", token_hash or "") else hashlib.sha256(str(token_hash).encode()).hexdigest()
        specifications = [
            ("trial:global", TRIAL_GLOBAL),
            ("trial:" + identity, TRIAL_TOKEN),
            ("trial:token:" + digest, TRIAL_TOKEN),
        ]
        return self.take(specifications, trial=True)

    def session_hop(self, headers, peer, window_hash: str):
        digest = window_hash if re.fullmatch(r"[0-9a-f]{64}", window_hash or "") else hashlib.sha256(str(window_hash).encode()).hexdigest()
        specifications = [
            ("session-hop:global", SESSION_HOP_GLOBAL),
            ("session-hop:window:" + digest, SESSION_HOP_WINDOW),
        ]
        return self.take(specifications, hop=True)

    def probe(self, url, *, discovery=False):
        parsed = urlsplit(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            return None
        origin = parsed.hostname.lower().rstrip(".") + ":" + str(parsed.port or 443)
        origin = hashlib.sha256(origin.encode()).hexdigest()
        # Queries and paths cannot rotate a host's budget. Separate origins can
        # still consume only the configured global work capacity.
        # Unpaid discovery probes use a distinct map so they cannot occupy
        # paid /route target-admission slots.
        if discovery:
            return self.take([
                ("discovery-probe:global", self.policy.target["global"]),
                ("discovery-probe:" + origin, self.policy.target["origin"]),
                ("discovery-failure:" + origin, self.policy.target["failures"]),
            ], discovery=True)
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

def reserve_probe(url, *, discovery=False):
    e = engine()
    if e is None:
        return None
    lease = e.probe(url, discovery=discovery)
    if lease is None:
        raise Unavailable("work capacity unavailable")
    return lease


def reserve_trial(headers, token_hash: str):
    e = engine()
    if e is None:
        return None
    lease = e.trial(headers, reqctx.peer_ip.get(), token_hash)
    if lease is None:
        raise Unavailable("work capacity unavailable")
    return lease


def reserve_session_hop(headers, window_hash: str):
    e = engine()
    if e is None:
        return None
    lease = e.session_hop(headers, reqctx.peer_ip.get(), window_hash)
    if lease is None:
        raise Unavailable("work capacity unavailable")
    return lease

def rejected():
    return 429, {"error": "work capacity unavailable", "retryable": True, "retry_same_request": True, "new_payment_allowed": False}, {"Retry-After": "60", "Cache-Control": "no-store"}


def free_ingress(headers, peer):
    """Admit unpaid discovery-class work. Distinct from paid /route ingress and reserve."""
    try:
        e = engine()
        if e is None:
            return False
        lease = e.discover(headers, peer)
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


_fallback_recovery = Engine(Policy({
    "version": 1, "window_seconds": 60, "max_keys": 1024,
    "ingress": {"global": 1, "anonymous": 1},
    "unpaid": {"global": 1, "anonymous": 1},
    "target": {"global": 1, "origin": 1, "failures": 1}, "customers": {},
}), cold_start=True)


def recovery(headers, peer):
    """Bound retrieval separately; this grants no access to private outcomes."""
    try:
        e = engine()
        return (e if e is not None else _fallback_recovery).recover(headers, peer)
    except Exception:
        return False
