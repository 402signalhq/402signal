"""Hosted session window, observation cache, and issued trial credits.

Hops never probe and never call a facilitator. Trials never mint over HTTP.

Windows, credits, the private counters and payer days and the alert tables
live in the session store (`live402.session_store`): the SQLite file on this
machine by default, or the shared replay PostgreSQL when
LIVE402_SESSION_BACKEND=postgres. The observation cache is always the local
SQLite file: a miss costs one probe, so it never needs to be shared.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
from urllib.parse import urlsplit

from live402 import history, metrics, payment, probe, reqctx, session_store, validate
from live402.session_store import StoreUnavailable

SESSION_TTL_S = 600
HOP_CEILING = 20
CACHE_TTL_S = 20
TRIAL_TTL_S = 48 * 3600
TRIAL_TTL_MAX_S = 30 * 86400
TRIAL_OPEN_CEILING = 5
TRIAL_OPEN_MAX = 1000
TRIAL_HEADER = "x-402signal-trial"
TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{32,128}\Z")
SESSION_ID_RE = re.compile(r"[0-9a-f]{64}\Z")
MANDATE_RE = re.compile(r"[0-9a-f]{64}\Z")
HOP_KEYS = frozenset(
    {"session", "session_id", "url", "mandate_hash", "networks", "scheme", "amount_atomic", "payTo"}
)
BOUND_SCHEMES = frozenset({"exact", "upto", "batch-settlement"})

DEFAULT_DB = "/tmp/live402-session.sqlite"
VOLUME_DB = "/data/live402-session.sqlite"

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None
_conn_path: str | None = None
_store_lock = threading.Lock()
_store_obj = None

_SCHEMA = """
CREATE TABLE IF NOT EXISTS windows (
    id_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    observed_at INTEGER NOT NULL,
    hop_count INTEGER NOT NULL DEFAULT 0,
    hop_ceiling INTEGER NOT NULL DEFAULT 20,
    url TEXT,
    rail TEXT,
    scheme TEXT,
    fingerprint TEXT NOT NULL,
    mandate_hash TEXT,
    offer_json TEXT NOT NULL,
    traffic_class TEXT,
    trial_hash TEXT,
    sku TEXT
);
CREATE TABLE IF NOT EXISTS trial_credits (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    opens_used INTEGER NOT NULL DEFAULT 0,
    open_ceiling INTEGER NOT NULL DEFAULT 5
);
CREATE TABLE IF NOT EXISTS obs_cache (
    dest TEXT NOT NULL,
    rail TEXT NOT NULL,
    scheme TEXT NOT NULL,
    ts INTEGER NOT NULL,
    body_json TEXT NOT NULL,
    PRIMARY KEY (dest, rail, scheme)
);
CREATE TABLE IF NOT EXISTS metric_counters (
    day TEXT NOT NULL,
    name TEXT NOT NULL,
    n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, name)
);
CREATE TABLE IF NOT EXISTS payer_days (
    day TEXT NOT NULL,
    payer_hash TEXT NOT NULL,
    traffic TEXT NOT NULL DEFAULT 'unclassified',
    PRIMARY KEY (day, payer_hash)
);
CREATE TABLE IF NOT EXISTS alert_subscriptions (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    url TEXT NOT NULL,
    hosts_json TEXT NOT NULL,
    events_json TEXT NOT NULL,
    secret TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    cursor_ts INTEGER NOT NULL,
    state_json TEXT NOT NULL DEFAULT '{}',
    last_delivery_at INTEGER,
    last_status INTEGER,
    failures INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    disabled_at INTEGER,
    disabled_reason TEXT
);
CREATE INDEX IF NOT EXISTS alert_subscriptions_owner ON alert_subscriptions(owner);
CREATE TABLE IF NOT EXISTS alert_deliveries (
    id TEXT PRIMARY KEY,
    subscription_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    status INTEGER,
    events INTEGER NOT NULL DEFAULT 0,
    error TEXT
);
CREATE INDEX IF NOT EXISTS alert_deliveries_sub_ts ON alert_deliveries(subscription_id, ts);
CREATE TABLE IF NOT EXISTS session_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def db_path() -> str:
    raw = (os.environ.get("LIVE402_SESSION_DB") or "").strip()
    if raw:
        return raw
    try:
        if os.path.isdir("/data") and os.access("/data", os.W_OK):
            return VOLUME_DB
    except Exception:
        pass
    return DEFAULT_DB


def _chmod_db_files(path: str) -> None:
    for p in (path, path + "-wal", path + "-shm"):
        try:
            os.chmod(p, 0o600)
        except OSError:
            pass


def _connect() -> sqlite3.Connection:
    global _conn, _conn_path
    path = db_path()
    if _conn is not None and _conn_path == path:
        return _conn
    if _conn is not None:
        try:
            _conn.close()
        except Exception:
            pass
        _conn = None
        _conn_path = None
    conn = sqlite3.connect(path, check_same_thread=False, timeout=5.0)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(_SCHEMA)
    conn.commit()
    _conn = conn
    _conn_path = path
    _chmod_db_files(path)
    return conn


def backend_name() -> str:
    return session_store.backend_name()


def store():
    """The configured session store. An unknown backend name is an unavailable store (fail closed)."""
    global _store_obj
    with _store_lock:
        if _store_obj is not None:
            return _store_obj
        try:
            name = session_store.backend_name()
        except ValueError:
            raise StoreUnavailable("session store unavailable") from None
        if name == "postgres":
            _store_obj = session_store.PostgresStore()
        else:
            _store_obj = session_store.SqliteStore(_connect, _lock)
        return _store_obj


def forget_store() -> None:
    """Drop the store object so the next call re-reads the backend setting. Files are untouched."""
    global _store_obj
    with _store_lock:
        obj, _store_obj = _store_obj, None
    if obj is not None:
        try:
            obj.close()
        except Exception:
            pass


def reset() -> None:
    global _conn, _conn_path
    forget_store()
    with _lock:
        path = _conn_path or db_path()
        if _conn is not None:
            try:
                _conn.close()
            except Exception:
                pass
            _conn = None
            _conn_path = None
        for suffix in ("", "-wal", "-shm"):
            try:
                os.unlink(path + suffix)
            except FileNotFoundError:
                pass


def _hash_secret(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _header_get(headers, name: str) -> str:
    if headers is None:
        return ""
    want = name.lower()
    getter = getattr(headers, "get", None)
    if getter:
        for key in (name, name.title(), name.upper(), want):
            val = getter(key)
            if val and str(val).strip():
                return str(val).strip()
    if hasattr(headers, "items"):
        for key, val in headers.items():
            if str(key).lower() == want and val and str(val).strip():
                return str(val).strip()
    return ""


def mode(body) -> str | None:
    if not isinstance(body, dict):
        return None
    if "session" in body:
        raw = body.get("session")
        if raw is not None and not isinstance(raw, str):
            return "invalid"
    else:
        raw = None
    text = raw.strip().lower() if isinstance(raw, str) else ""
    sid = body.get("session_id")
    sid_ok = isinstance(sid, str) and bool(SESSION_ID_RE.fullmatch(sid.strip()))
    if text == "open":
        return "open"
    if text == "hop":
        return "hop"
    if text:
        return "invalid"
    if sid_ok:
        return "hop"
    return None


def trial_token(headers) -> str | None:
    raw = _header_get(headers, TRIAL_HEADER)
    if raw and TOKEN_RE.fullmatch(raw):
        return raw
    return None


def issue_trial(raw: str | None = None, *, ttl_s: int = TRIAL_TTL_S, opens: int = TRIAL_OPEN_CEILING) -> str:
    """Store only the hash. Returns the bearer token once.

    Re-issuing the same raw token may refresh expires_at and raise the open
    ceiling (an operator top-up). It must not reset opens_used. Credits are
    operator-issued check allowances for catalog-listed URLs: the same abuse
    limits apply as to paid checks, no facilitator is called, and sponsored
    traffic never moves public reliability data.
    """
    token = raw or secrets.token_urlsafe(32)
    if not TOKEN_RE.fullmatch(token):
        raise ValueError("invalid trial token")
    if isinstance(ttl_s, bool) or not isinstance(ttl_s, int) or not 60 <= ttl_s <= TRIAL_TTL_MAX_S:
        raise ValueError("invalid trial ttl")
    if isinstance(opens, bool) or not isinstance(opens, int) or not 1 <= opens <= TRIAL_OPEN_MAX:
        raise ValueError("invalid trial open ceiling")
    now = int(time.time())
    store().trial_issue(_hash_secret(token), now, now + int(ttl_s), int(opens))
    return token


def _trial_row(digest: str):
    """(expires_at, opens_used, open_ceiling) or None. An unavailable store reads as no credit."""
    try:
        return store().trial_get(digest)
    except StoreUnavailable:
        return None


def trial_remaining(headers) -> int:
    token = trial_token(headers)
    if not token:
        return 0
    row = _trial_row(_hash_secret(token))
    if not row:
        return 0
    expires_at, used, ceiling = row
    if int(expires_at) < int(time.time()):
        return 0
    return max(0, int(ceiling) - int(used))


def _consume_trial_open(digest: str) -> bool:
    try:
        return store().trial_consume(digest, int(time.time()))
    except StoreUnavailable:
        return False


def offer_fingerprint(result: dict) -> str:
    selected = result.get("selected_payment") if isinstance(result.get("selected_payment"), dict) else {}
    parts = [
        str(result.get("url") or ""),
        str(result.get("payTo") or selected.get("payTo") or ""),
        str(selected.get("network") or result.get("rail") or ""),
        str(selected.get("asset") or ""),
        str(selected.get("amount_atomic") or selected.get("amount") or ""),
        str(selected.get("scheme") or "exact"),
    ]
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def _bound_terms(offer: dict, *, url: str | None, rail: str | None, scheme: str | None) -> dict:
    selected = offer.get("selected_payment") if isinstance(offer.get("selected_payment"), dict) else {}
    bound_scheme = str(scheme or selected.get("scheme") or "exact").strip().lower()
    bound_rail = str(rail or selected.get("network") or offer.get("rail") or "")
    amount = payment.sane_atomic_amount(selected.get("amount_atomic") if selected.get("amount_atomic") is not None else selected.get("amount"))
    pay_to = selected.get("payTo") or offer.get("payTo")
    return {
        "url": url or offer.get("url") or "",
        "scheme": bound_scheme,
        "rail": bound_rail,
        "payTo": pay_to,
        "amount_atomic": amount,
    }


def _hop_bound_miss(body: dict, bound: dict) -> str | None:
    """Refuse a live hop offer that breaks the window bound. Never settles."""
    extra = set(body) - HOP_KEYS if isinstance(body, dict) else set()
    if extra:
        return "scheme_mismatch"
    req_scheme = None
    if isinstance(body.get("scheme"), str):
        req_scheme = body.get("scheme").strip().lower()
    bound_scheme = str(bound.get("scheme") or "exact").lower()
    if req_scheme:
        if req_scheme not in BOUND_SCHEMES or req_scheme != bound_scheme:
            return "scheme_mismatch"
    if bound_scheme not in BOUND_SCHEMES and (
        req_scheme or "amount_atomic" in body or "payTo" in body
    ):
        return "scheme_mismatch"
    if "payTo" in body:
        raw = body.get("payTo")
        if not isinstance(raw, str) or not raw.strip():
            return "fingerprint_miss"
        if not payment.payto_equal(raw.strip(), bound.get("payTo"), bound.get("rail")):
            return "fingerprint_miss"
    if "amount_atomic" in body:
        hop_amount = payment.canonical_atomic_string(body.get("amount_atomic"))
        ceiling = payment.sane_atomic_amount(bound.get("amount_atomic"))
        if hop_amount is None or ceiling is None:
            return "fingerprint_miss"
        if hop_amount > ceiling:
            return "constraints_unmet"
    return None


def _mandate(body) -> str | None:
    if not isinstance(body, dict):
        return None
    raw = body.get("mandate_hash")
    if isinstance(raw, str) and MANDATE_RE.fullmatch(raw.strip().lower()):
        return raw.strip().lower()
    return None


def _public_offer(result: dict) -> dict:
    skip = {
        "_probed",
        "binding_ineligible",
        "binding_observation",
        "_batch_observation",
        "session",
        "cache_hit",
        "billing",
    }
    return {k: v for k, v in result.items() if k not in skip}


def _session_block(session_id: str, hop_count: int, expires_at: int, hops_remaining: int) -> dict:
    return {
        "id": session_id,
        "hop_count": hop_count,
        "hops_remaining": hops_remaining,
        "expires_at": expires_at,
        "hop_ceiling": HOP_CEILING,
    }


def open_window(result: dict, body: dict, *, traffic_class: str, trial_hash: str | None, sku: str) -> str:
    session_id = secrets.token_hex(32)
    now = int(time.time())
    offer = _public_offer(result)
    selected = offer.get("selected_payment") if isinstance(offer.get("selected_payment"), dict) else None
    store().window_insert({
        "id_hash": _hash_secret(session_id),
        "created_at": now,
        "expires_at": now + SESSION_TTL_S,
        "hop_ceiling": HOP_CEILING,
        "url": offer.get("url"),
        "rail": selected.get("network") if selected is not None else offer.get("rail"),
        "scheme": selected.get("scheme") if selected is not None else "exact",
        "fingerprint": offer_fingerprint(offer),
        "mandate_hash": _mandate(body),
        "offer_json": json.dumps(offer, separators=(",", ":"), default=str),
        "traffic_class": traffic_class,
        "trial_hash": trial_hash,
        "sku": sku,
    })
    metrics.inc("session.open." + metrics.traffic_label(traffic_class))
    result["session"] = _session_block(session_id, 0, now + SESSION_TTL_S, HOP_CEILING)
    return session_id


def _miss(reason: str, **extra) -> tuple[int, dict, None]:
    body = {
        "live": False,
        "invocable": False,
        "payable": False,
        "selected_payment": None,
        "miss_reason": reason,
        "stop_reason": reason,
        "billing": {
            "model": payment.ROUTING_BILLING_MODEL,
            "condition": payment.ROUTING_SETTLEMENT_CONDITION,
            "asset": "USDC",
            "amount_atomic": "0",
            "display_amount": "$0.000",
            "rail": extra.get("rail") or "unknown",
            "settlement_attempted": False,
            "settled": False,
            "settlement_state": "not_attempted",
        },
    }
    body.update(extra)
    return 200, body, None


def _store_unavailable() -> tuple[int, dict, dict]:
    """A hop cannot be answered without its window; the same hop may be retried shortly."""
    return 503, {
        "error": "session_store_unavailable",
        "retryable": True,
        "retry_same_request": True,
        "new_payment_allowed": False,
    }, {"Retry-After": "5", "Cache-Control": "no-store"}


def handle_hop(body: dict, headers) -> tuple[int, dict, dict | None]:
    from live402 import admission

    sid = body.get("session_id") if isinstance(body, dict) else None
    if not isinstance(sid, str) or not SESSION_ID_RE.fullmatch(sid.strip()):
        return _miss("invalid_session_shape")
    sid = sid.strip()
    digest = _hash_secret(sid)
    now = int(time.time())
    try:
        hop_lease = admission.reserve_session_hop(headers, digest)
    except admission.Unavailable:
        return admission.rejected()
    try:
        try:
            row = store().window_get(digest)
        except StoreUnavailable:
            return _store_unavailable()
        if not row:
            return _miss("fingerprint_miss")
        (
            expires_at,
            hop_count,
            hop_ceiling,
            url,
            rail,
            scheme,
            fingerprint,
            mandate_hash,
            offer_json,
            window_class,
        ) = row
        if int(expires_at) < now or int(hop_count) >= int(hop_ceiling):
            return _miss("window_spent")
        try:
            offer = json.loads(offer_json)
        except Exception:
            return _miss("fingerprint_miss")
        if not isinstance(offer, dict):
            return _miss("fingerprint_miss")
        req_url = (body.get("url") or "").strip() if isinstance(body.get("url"), str) else ""
        if req_url and req_url != (url or ""):
            return _miss("fingerprint_miss")
        selected = offer.get("selected_payment") if isinstance(offer.get("selected_payment"), dict) else {}
        bound = _bound_terms(offer, url=url, rail=rail, scheme=scheme)
        bound_miss = _hop_bound_miss(body, bound)
        if bound_miss:
            return _miss(bound_miss)
        networks = body.get("networks")
        bound_net = str(rail or selected.get("network") or "")
        if isinstance(networks, list) and networks:
            allowed = {str(n).strip().lower() for n in networks}
            rail_name = "base"
            low = bound_net.lower()
            if "solana" in low:
                rail_name = "solana"
            elif "algorand" in low:
                rail_name = "algorand"
            if rail_name not in allowed and bound_net.lower() not in allowed:
                return _miss("network_mismatch")
        hop_mandate = _mandate(body)
        if mandate_hash and hop_mandate and hop_mandate != mandate_hash:
            return _miss("scheme_mismatch")
        if offer_fingerprint(offer) != fingerprint:
            return _miss("fingerprint_miss")
        # The store decides the count: two hops racing on the last slot get one success.
        try:
            new_count = store().window_hop(digest, now)
        except StoreUnavailable:
            return _store_unavailable()
        if new_count is None:
            return _miss("window_spent")
        hop_count = int(new_count)
        metrics.inc("session.hop." + metrics.traffic_label(window_class))
        out = dict(offer)
        out["session"] = _session_block(sid, hop_count, int(expires_at), max(0, int(hop_ceiling) - hop_count))
        out["billing"] = {
            "model": payment.ROUTING_BILLING_MODEL,
            "condition": payment.ROUTING_SETTLEMENT_CONDITION,
            "asset": "USDC",
            "amount_atomic": "0",
            "display_amount": "$0.000",
            "rail": out.get("rail") or "unknown",
            "settlement_attempted": False,
            "settled": False,
            "settlement_state": "not_attempted",
        }
        return 200, out, None
    finally:
        if hop_lease is not None:
            hop_lease.finish(False)


def _listed_url(url: str) -> bool:
    return validate.catalog_item_for(url) is not None


def handle_trial_open(body: dict, headers, run_probe, strip_private) -> tuple[int, dict, dict | None] | None:
    """Run a listed-URL open on a credit. None means fall through to a real 402."""
    from live402 import admission

    token = trial_token(headers)
    if not token:
        return None
    if trial_remaining(headers) <= 0:
        return None
    if probe.parse_search_depth(body.get("search_depth")) == "thorough":
        return 400, {
            "error": "trial rejects thorough search",
            "miss_reason": "invalid_need",
            "live": False,
            "invocable": False,
        }, None
    url = (body.get("url") or "").strip() if isinstance(body.get("url"), str) else ""
    if not url:
        return 400, {
            "error": "trial opens require a listed url",
            "miss_reason": "invalid_need",
            "live": False,
            "invocable": False,
        }, None
    if not _listed_url(url):
        return 200, {
            "url": url,
            "live": False,
            "invocable": False,
            "payable": False,
            "miss_reason": "unlisted",
            "billing": {
                "model": payment.ROUTING_BILLING_MODEL,
                "condition": payment.ROUTING_SETTLEMENT_CONDITION,
                "asset": "USDC",
                "amount_atomic": "0",
                "display_amount": "$0.000",
                "rail": "unknown",
                "settlement_attempted": False,
                "settled": False,
                "settlement_state": "not_attempted",
            },
        }, None
    digest = _hash_secret(token)
    try:
        trial_lease = admission.reserve_trial(headers, digest)
    except admission.Unavailable:
        return admission.rejected()
    token_cls = reqctx.traffic_class.set(history.TRAFFIC_SPONSORED)
    try:
        if not _consume_trial_open(digest):
            return None
        code, result = run_probe(body)
        result = strip_private(result) or result
        if not isinstance(result, dict):
            result = {"live": False, "invocable": False, "payable": False}
        result["billing"] = {
            "model": payment.ROUTING_BILLING_MODEL,
            "condition": payment.ROUTING_SETTLEMENT_CONDITION,
            "asset": "USDC",
            "amount_atomic": "0",
            "display_amount": "$0.000",
            "rail": result.get("rail") or "unknown",
            "settlement_attempted": False,
            "settled": False,
            "settlement_state": "not_attempted",
        }
        if code == 200 and result.get("live") is True:
            try:
                open_window(
                    result,
                    body,
                    traffic_class=history.TRAFFIC_SPONSORED,
                    trial_hash=digest,
                    sku="trial",
                )
            except StoreUnavailable:
                sys.stderr.write("session_open_failed sku=trial\n")
        return code, result, None
    finally:
        reqctx.traffic_class.reset(token_cls)
        if trial_lease is not None:
            trial_lease.finish(False)


def attach_paid_open(result: dict, body: dict) -> dict:
    """Open the paid window. A store failure is logged and leaves the answer without a session block."""
    if not isinstance(result, dict) or result.get("live") is not True:
        return result
    cls = reqctx.traffic_class.get() or history.route_traffic_from_env()
    try:
        open_window(result, body, traffic_class=cls, trial_hash=None, sku="session")
    except StoreUnavailable:
        sys.stderr.write("session_open_failed sku=session\n")
    return result


def remember_probe(result: dict) -> None:
    if not isinstance(result, dict) or result.get("live") is not True:
        return
    dest = str(result.get("url") or "").strip()
    if not dest:
        return
    try:
        cls = history.classify_traffic_class(dest, result)
    except Exception:
        return
    if cls != history.TRAFFIC_ORGANIC:
        return
    selected = result.get("selected_payment") if isinstance(result.get("selected_payment"), dict) else {}
    rail = str(selected.get("network") or result.get("rail") or "unknown")
    scheme = str(selected.get("scheme") or "exact")
    ts = int(time.time())
    with _lock:
        conn = _connect()
        conn.execute(
            """
            INSERT INTO obs_cache (dest, rail, scheme, ts, body_json)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(dest, rail, scheme) DO UPDATE SET
                ts = excluded.ts,
                body_json = excluded.body_json
            """,
            (dest, rail, scheme, ts, json.dumps(_public_offer(result), separators=(",", ":"), default=str)),
        )
        conn.commit()


def cached_probe(url: str, *, rail: str | None = None, scheme: str | None = None) -> dict | None:
    dest = (url or "").strip()
    if not dest:
        return None
    try:
        host = urlsplit(dest).hostname
    except Exception:
        host = None
    if not host:
        return None
    now = int(time.time())
    with _lock:
        conn = _connect()
        if rail and scheme:
            row = conn.execute(
                "SELECT ts, body_json FROM obs_cache WHERE dest=? AND rail=? AND scheme=?",
                (dest, rail, scheme),
            ).fetchone()
            rows = [row] if row else []
        else:
            rows = conn.execute(
                "SELECT ts, body_json FROM obs_cache WHERE dest=? ORDER BY ts DESC",
                (dest,),
            ).fetchall()
    for row in rows:
        if not row:
            continue
        ts, blob = row
        if now - int(ts) > CACHE_TTL_S:
            continue
        try:
            last_ok = history.summary(dest).get("last_success_402")
        except Exception:
            last_ok = None
        if last_ok is None or now - int(last_ok) > CACHE_TTL_S:
            continue
        try:
            body = json.loads(blob)
        except Exception:
            continue
        if isinstance(body, dict) and body.get("live") is True:
            body["cache_hit"] = True
            metrics.inc("obs_cache.hit." + metrics.traffic_label())
            return body
    metrics.inc("obs_cache.miss." + metrics.traffic_label())
    return None


def add_counters(day: str, counts: dict) -> None:
    """Private metric rollup storage. Names are coarse labels, never identities."""
    rows = [(str(name), int(value)) for name, value in counts.items() if int(value) > 0]
    if not rows:
        return
    store().counters_add(str(day), rows)


PAYER_HASH_RE = re.compile(r"[0-9a-f]{64}\Z")


def record_payer(payer_hash, traffic: str | None = None, now: float | None = None) -> bool:
    """North-star input: a hashed verified payer settled a qualifying check today.

    Stores the SHA-256 hex of the payer per UTC day, never the address. Returns
    True the first time a payer is seen on a day. Private; never published.
    """
    if not isinstance(payer_hash, str) or not PAYER_HASH_RE.match(payer_hash):
        return False
    day = time.strftime("%Y-%m-%d", time.gmtime(time.time() if now is None else float(now)))
    label = re.sub(r"[^a-z0-9_]+", "_", str(traffic or "unclassified").lower())[:32] or "unclassified"
    try:
        return store().payer_record(day, payer_hash, label)
    except StoreUnavailable:
        sys.stderr.write("payer_record_failed\n")
        return False


def _day_list(days: int, now: float | None = None) -> list[str]:
    ts = time.time() if now is None else float(now)
    return [time.strftime("%Y-%m-%d", time.gmtime(ts - i * 86400)) for i in range(max(1, int(days)))]


def north_star(days: int = 7, now: float | None = None) -> dict:
    """Signed receipts issued and distinct payers over the trailing window.

    Receipts are settled checks that returned a durable signed receipt, counted by
    `route.qualified.<traffic>` only after the leaf came back; settled checks with
    or without a receipt are `route.settled.<traffic>`, so a fee that settled and
    then failed its required receipt is never counted as a receipt. Payers are
    distinct hashed verified payers from `payer_days`. Organic excludes sponsored
    credits, lab and self-test traffic. Private operator numbers only. Counters are
    telemetry flushed every five minutes, not a billing ledger.
    """
    day_list = _day_list(days, now)
    st = store()
    return {
        "days": len(day_list),
        "receipts_organic": st.counters_sum(day_list, name="route.qualified.organic"),
        "receipts_all": st.counters_sum(day_list, prefix="route.qualified."),
        "settled_organic": st.counters_sum(day_list, name="route.settled.organic"),
        "settled_all": st.counters_sum(day_list, prefix="route.settled."),
        "distinct_payers_organic": st.payers_distinct(day_list, "organic"),
        "distinct_payers_all": st.payers_distinct(day_list),
        # The operator's own wallets (LIVE402_SELF_PAYERS): real observations,
        # never demand. Shown so the organic numbers can be read against them.
        "receipts_self": st.counters_sum(day_list, name="route.qualified.self"),
        "settled_self": st.counters_sum(day_list, name="route.settled.self"),
        "distinct_payers_self": st.payers_distinct(day_list, "self"),
    }


def rollup_stats(since: int, until: int, traffic: str = "organic") -> dict:
    """Private rollup input for the operator script: opens, hops, counters and distinct payers."""
    days: list[str] = []
    cursor = int(since) - (int(since) % 86400)
    while cursor < int(until):
        days.append(time.strftime("%Y-%m-%d", time.gmtime(cursor)))
        cursor += 86400
    if not days:
        days = [time.strftime("%Y-%m-%d", time.gmtime(int(since)))]
    out = store().rollup(int(since), int(until), days, traffic)
    out["since"], out["until"], out["days"] = int(since), int(until), days
    return out


# Windows stay 35 days so the weekly organic rollup can read them.
PRUNE_WINDOW_GRACE_S = 35 * 86400
PRUNE_TRIAL_GRACE_S = 7 * 86400
PRUNE_CACHE_S = 3600
PRUNE_COUNTER_DAYS = 400


def prune(now: int | None = None) -> dict:
    """Drop stale windows, credits, cache rows and old counters. Writer housekeeping only."""
    ts = int(time.time() if now is None else now)
    cutoff_day = time.strftime("%Y-%m-%d", time.gmtime(ts - PRUNE_COUNTER_DAYS * 86400))
    out = store().prune(ts, PRUNE_WINDOW_GRACE_S, PRUNE_TRIAL_GRACE_S, cutoff_day)
    with _lock:
        conn = _connect()
        out["obs_cache"] = conn.execute("DELETE FROM obs_cache WHERE ts < ?", (ts - PRUNE_CACHE_S,)).rowcount
        conn.commit()
    return out


def import_local_state() -> dict | None:
    """One-time copy of this machine's SQLite session state into the shared store.

    Runs on the writer once the lease is held, when the backend is postgres and
    a local file exists. The source id is written into the SQLite file before
    the copy, so a machine recreated on the same volume never copies twice.
    A restored older copy of the file would; the file is not restored after the
    switch. Idempotent and safe to call on every lease acquisition.
    """
    try:
        if session_store.backend_name() != "postgres":
            return None
    except ValueError:
        return None
    path = db_path()
    if not os.path.exists(path):
        return None
    local = session_store.SqliteStore(_connect, _lock)
    try:
        source = local.meta_get("import_source")
        if not source:
            source = "sqlite:" + secrets.token_hex(8)
            local.meta_set("import_source", source)
        shared = store()
        if shared.imported(source):
            return {"source": source, "imported": False}
        payload = local.export_state(int(time.time()))
        done = shared.import_state(source, payload)
        counts = {name: len(rows) for name, rows in payload.items()}
        sys.stderr.write(
            "session_import source=%s imported=%s %s\n"
            % (source, "yes" if done else "already", " ".join("%s=%d" % kv for kv in sorted(counts.items())))
        )
        return {"source": source, "imported": done, **counts}
    except (StoreUnavailable, sqlite3.Error, OSError) as exc:
        sys.stderr.write("session_import_failed kind=%s\n" % type(exc).__name__)
        return None
