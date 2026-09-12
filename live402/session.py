"""Hosted session window, observation cache, and issued trial credits.

Hops never probe and never call a facilitator. Trials never mint over HTTP.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from urllib.parse import urlsplit

from live402 import history, payment, probe, reqctx, validate

SESSION_TTL_S = 600
HOP_CEILING = 20
CACHE_TTL_S = 20
TRIAL_TTL_S = 48 * 3600
TRIAL_OPEN_CEILING = 5
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


def reset() -> None:
    global _conn, _conn_path
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
    raw = body.get("session")
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


def issue_trial(raw: str | None = None, *, ttl_s: int = TRIAL_TTL_S) -> str:
    """Store only the hash. Returns the bearer token once.

    Re-issuing the same raw token may refresh expires_at. It must not reset
    opens_used.
    """
    token = raw or secrets.token_urlsafe(32)
    if not TOKEN_RE.fullmatch(token):
        raise ValueError("invalid trial token")
    now = int(time.time())
    digest = _hash_secret(token)
    with _lock:
        conn = _connect()
        conn.execute(
            """
            INSERT INTO trial_credits (token_hash, created_at, expires_at, opens_used, open_ceiling)
            VALUES (?, ?, ?, 0, ?)
            ON CONFLICT(token_hash) DO UPDATE SET
                expires_at = excluded.expires_at
            """,
            (digest, now, now + int(ttl_s), TRIAL_OPEN_CEILING),
        )
        conn.commit()
    return token


def _trial_row(cur, digest: str):
    return cur.execute(
        "SELECT expires_at, opens_used, open_ceiling FROM trial_credits WHERE token_hash=?",
        (digest,),
    ).fetchone()


def trial_remaining(headers) -> int:
    token = trial_token(headers)
    if not token:
        return 0
    digest = _hash_secret(token)
    now = int(time.time())
    with _lock:
        row = _trial_row(_connect().cursor(), digest)
    if not row:
        return 0
    expires_at, used, ceiling = row
    if int(expires_at) < now:
        return 0
    return max(0, int(ceiling) - int(used))


def _consume_trial_open(digest: str) -> bool:
    now = int(time.time())
    with _lock:
        conn = _connect()
        cur = conn.cursor()
        row = _trial_row(cur, digest)
        if not row:
            return False
        expires_at, used, ceiling = row
        if int(expires_at) < now or int(used) >= int(ceiling):
            return False
        cur.execute(
            "UPDATE trial_credits SET opens_used = opens_used + 1 WHERE token_hash=? AND opens_used < open_ceiling",
            (digest,),
        )
        conn.commit()
        return cur.rowcount == 1


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
    with _lock:
        conn = _connect()
        conn.execute(
            """
            INSERT INTO windows (
                id_hash, created_at, expires_at, observed_at, hop_count, hop_ceiling,
                url, rail, scheme, fingerprint, mandate_hash, offer_json, traffic_class, trial_hash, sku
            ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                _hash_secret(session_id),
                now,
                now + SESSION_TTL_S,
                now,
                HOP_CEILING,
                offer.get("url"),
                (offer.get("selected_payment") or {}).get("network") if isinstance(offer.get("selected_payment"), dict) else offer.get("rail"),
                (offer.get("selected_payment") or {}).get("scheme") if isinstance(offer.get("selected_payment"), dict) else "exact",
                offer_fingerprint(offer),
                _mandate(body),
                json.dumps(offer, separators=(",", ":"), default=str),
                traffic_class,
                trial_hash,
                sku,
            ),
        )
        conn.commit()
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


def handle_hop(body: dict, headers) -> tuple[int, dict, dict | None]:
    from live402 import admission

    sid = body.get("session_id") if isinstance(body, dict) else None
    if not isinstance(sid, str) or not SESSION_ID_RE.fullmatch(sid.strip()):
        return _miss("fingerprint_miss")
    sid = sid.strip()
    digest = _hash_secret(sid)
    now = int(time.time())
    try:
        hop_lease = admission.reserve_session_hop(headers, digest)
    except admission.Unavailable:
        return admission.rejected()
    try:
        with _lock:
            conn = _connect()
            cur = conn.cursor()
            row = cur.execute(
                """
                SELECT expires_at, hop_count, hop_ceiling, url, rail, scheme,
                       fingerprint, mandate_hash, offer_json
                FROM windows WHERE id_hash=?
                """,
                (digest,),
            ).fetchone()
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
            cur.execute(
                "UPDATE windows SET hop_count = hop_count + 1 WHERE id_hash=? AND hop_count < hop_ceiling",
                (digest,),
            )
            conn.commit()
            hop_count = int(hop_count) + 1
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
            open_window(
                result,
                body,
                traffic_class=history.TRAFFIC_SPONSORED,
                trial_hash=digest,
                sku="trial",
            )
        return code, result, None
    finally:
        reqctx.traffic_class.reset(token_cls)
        if trial_lease is not None:
            trial_lease.finish(False)


def attach_paid_open(result: dict, body: dict) -> dict:
    if not isinstance(result, dict) or result.get("live") is not True:
        return result
    cls = reqctx.traffic_class.get() or history.route_traffic_from_env()
    open_window(result, body, traffic_class=cls, trial_hash=None, sku="session")
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
            return body
    return None
