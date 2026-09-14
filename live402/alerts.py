"""Change alerts for admission-key holders: price, recipient and liveness.

A subscription names up to twenty hosts and one HTTPS webhook. The writer's
maintenance loop compares each named host's latest public observations with
the subscription's cursor and POSTs one signed batch of events per scan when
something moved. Alerts are observation-driven: they fire when a check
observed the change, never from a catalog feed alone, and they carry only
data that is already public on the host's endpoint page. The same rule the
public pages use applies: only trusted, organic observations count, so
nothing a seller pays for and nothing from the lab moves an alert.

Only a recognized `X-402Signal-Key` can create, list, test or delete
subscriptions, and only its own. Webhook targets pass the probe's SSRF guard
(public HTTPS, public DNS, pinned addresses, no redirects) at creation and
again on every delivery. Deliveries are signed with a per-subscription secret
shown once at creation:

    X-402Signal-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">

Delivery is at least once and every transition is delivered: a scan that finds
more changes than one batch holds sends the oldest batch and moves the
subscription's cursor only past what it sent, so the rest goes out on the next
scan (changes in the cut-off second may repeat). A receiver that sees the same
`event`, `url` and `changed_at` twice has seen the same change twice. Each scan
delivers to a bounded number of subscriptions so webhook latency cannot hold
the writer's housekeeping loop; the rest stay due for the next tick.
"""
from __future__ import annotations

import datetime
import hashlib
import hmac
import json
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import quote, urlsplit

from live402 import endpoints, history, session
from live402.session_store import StoreUnavailable

EVENTS = ("price", "recipient", "liveness")
MAX_SUBSCRIPTIONS = 10
MAX_HOSTS = 20
MAX_URL_LEN = 512
MAX_EVENTS_PER_DELIVERY = 200
# Deliveries per scan: at DELIVERY_TIMEOUT_S each, one scan holds the housekeeping
# loop for at most about two minutes even when every webhook is slow.
MAX_DELIVERIES_PER_SCAN = 25
DELIVERY_TIMEOUT_S = 5.0
MAX_FAILURES = 20
DELIVERIES_KEPT = 50
DELIVERY_RETENTION_S = 30 * 86400
BACKOFF_BASE_S = 60
BACKOFF_MAX_S = 3600
LOOKBACK_S = 30 * 86400
SIGNATURE_TOLERANCE_S = 300
USER_AGENT = "402Signal-alerts/1"
KEY_HINT = 'alerts need a recognized X-402Signal-Key; ask ross@402signal.com, subject "admission key"'
NO_STORE = {"Cache-Control": "no-store, private"}
OWN_HOSTS = frozenset({"402signal.com", "www.402signal.com"})
ID_RE = re.compile(r"[0-9a-f]{16}\Z")

_scan_lock = threading.Lock()


class AlertError(Exception):
    def __init__(self, status: int, error: str, **extra) -> None:
        super().__init__(error)
        self.status = int(status)
        self.error = str(error)
        self.extra = extra

    def body(self) -> dict:
        return {"error": self.error, **self.extra}


def _store():
    """The session store, or a 503 the customer can retry when it cannot be reached."""
    try:
        return session.store()
    except StoreUnavailable:
        raise AlertError(503, "alerts_unavailable", retryable=True) from None


def _now() -> int:
    return int(time.time())


def _iso(ts) -> str | None:
    if ts is None:
        return None
    try:
        return (
            datetime.datetime.fromtimestamp(int(ts), datetime.timezone.utc)
            .isoformat(timespec="seconds")
            .replace("+00:00", "Z")
        )
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def limits() -> dict:
    return {
        "subscriptions_per_key": MAX_SUBSCRIPTIONS,
        "hosts_per_subscription": MAX_HOSTS,
        "events": list(EVENTS),
        "delivery": "at least once; signed; public HTTPS only; disabled after %d consecutive failures" % MAX_FAILURES,
    }


def owner_of(headers, peer) -> str | None:
    """The customer digest behind one recognized X-402Signal-Key, else None."""
    from live402 import admission

    if not admission.configured():
        return None
    try:
        identity, customer = admission.engine().identity(headers, peer)
    except Exception:
        return None
    if not customer or not str(identity).startswith("customer:"):
        return None
    return str(identity).split(":", 1)[1]


# --- validation ---------------------------------------------------------------


def _target_ok(url: str) -> bool:
    """Public HTTPS with public DNS, by the probe's own guard. Fail closed."""
    from live402 import probe

    try:
        return probe._pin_https_target(url) is not None
    except Exception:
        return False


def _normalize_url(raw) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise AlertError(400, "url_required", hint="an https:// webhook URL you control")
    url = raw.strip()
    if len(url) > MAX_URL_LEN:
        raise AlertError(400, "url_too_long", max=MAX_URL_LEN)
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower().rstrip(".")
    except ValueError:
        raise AlertError(400, "url_not_public_https") from None
    if parts.scheme != "https" or not host or parts.username or parts.password or parts.fragment:
        raise AlertError(400, "url_not_public_https")
    if host in OWN_HOSTS or not _target_ok(url):
        raise AlertError(
            400, "url_not_public_https",
            hint="public HTTPS with public DNS only; private, loopback and link-local addresses are refused",
        )
    return url


def _normalize_hosts(raw) -> list[str]:
    if not isinstance(raw, list) or not raw:
        raise AlertError(400, "hosts_required", hint="a list of 1 to %d seller hostnames" % MAX_HOSTS)
    if len(raw) > MAX_HOSTS:
        raise AlertError(400, "too_many_hosts", max=MAX_HOSTS)
    out: list[str] = []
    for item in raw:
        host = endpoints.normalize_host(item) if isinstance(item, str) else None
        if host is None:
            raise AlertError(400, "invalid_host", host=str(item)[:80])
        if host not in out:
            out.append(host)
    return out


def _normalize_events(raw) -> list[str]:
    if raw is None:
        return list(EVENTS)
    if not isinstance(raw, list) or not raw:
        raise AlertError(400, "invalid_events", allowed=list(EVENTS))
    out: list[str] = []
    for item in raw:
        if not isinstance(item, str) or item not in EVENTS:
            raise AlertError(400, "invalid_events", allowed=list(EVENTS))
        if item not in out:
            out.append(item)
    return out


# --- rows ---------------------------------------------------------------------


class _Sub:
    __slots__ = (
        "id", "owner", "url", "hosts", "events", "secret", "created_at", "cursor_ts", "state",
        "last_delivery_at", "last_status", "failures", "next_attempt_at", "disabled_at", "disabled_reason",
    )

    def __init__(self, row) -> None:
        (
            self.id, self.owner, self.url, hosts_json, events_json, self.secret, self.created_at, self.cursor_ts,
            state_json, self.last_delivery_at, self.last_status, self.failures, self.next_attempt_at,
            self.disabled_at, self.disabled_reason,
        ) = row
        self.hosts = list(json.loads(hosts_json))
        self.events = list(json.loads(events_json))
        try:
            self.state = dict(json.loads(state_json or "{}"))
        except (ValueError, TypeError):
            self.state = {}

    def public(self) -> dict:
        now = _now()
        out = {
            "id": self.id,
            "url": self.url,
            "hosts": list(self.hosts),
            "events": list(self.events),
            "created_at": _iso(self.created_at),
            "active": self.disabled_at is None,
            "consecutive_failures": int(self.failures or 0),
            "last_delivery_at": _iso(self.last_delivery_at),
            "last_status": self.last_status,
        }
        if self.disabled_at is not None:
            out["disabled"] = {"at": _iso(self.disabled_at), "reason": self.disabled_reason}
        if self.next_attempt_at and int(self.next_attempt_at) > now:
            out["next_attempt_at"] = _iso(self.next_attempt_at)
        return out


def _own(owner: str, sub_id) -> _Sub:
    if not isinstance(sub_id, str) or not ID_RE.match(sub_id):
        raise AlertError(404, "subscription_not_found")
    try:
        row = _store().alert_sub_get(sub_id, owner)
    except StoreUnavailable:
        raise AlertError(503, "alerts_unavailable", retryable=True) from None
    if not row:
        raise AlertError(404, "subscription_not_found")
    return _Sub(row)


def _known(host: str) -> bool:
    try:
        return endpoints.host_facts(host) is not None
    except Exception:
        return False


# --- observations -------------------------------------------------------------


def _host_observations(host: str, since: int) -> dict:
    """Latest public observation per URL under `host`, plus the url_state change clocks."""
    exact, path_like, query_like = endpoints._host_patterns(host)
    with history._lock:
        conn = history._connect()
        probes = conn.execute(
            "SELECT url, ts, live, miss_reason FROM probes WHERE ts >= ? "
            "AND (url = ? OR url LIKE ? OR url LIKE ?) AND trust_class IN %s AND traffic_class IN %s "
            "ORDER BY ts DESC, id DESC LIMIT 5000"
            % (history._TRUSTED_SQL, history._PUBLIC_TRAFFIC_SQL),
            (since, exact, path_like, query_like),
        ).fetchall()
        states = conn.execute(
            "SELECT url, last_payTo, pending_payTo, last_amount, payTo_changed_at, price_changed_at "
            "FROM url_state WHERE url = ? OR url LIKE ? OR url LIKE ?",
            (exact, path_like, query_like),
        ).fetchall()
    latest: dict[str, dict] = {}
    for url, ts, live, miss in probes:
        if url in latest or endpoints.host_of(url) != host:
            continue
        latest[url] = {"ts": int(ts), "live": bool(live), "miss_reason": None if live else miss}
    clocks: dict[str, dict] = {}
    for url, last_pay, pending_pay, last_amt, pay_at, price_at in states:
        if endpoints.host_of(url) != host:
            continue
        clocks[url] = {
            "payTo": last_pay,
            "pending_payTo": pending_pay,
            "amount": last_amt,
            "payTo_changed_at": pay_at,
            "price_changed_at": price_at,
        }
    return {"latest": latest, "clocks": clocks}


def _baseline(hosts: list[str]) -> dict:
    state: dict[str, bool] = {}
    since = _now() - LOOKBACK_S
    for host in hosts:
        for url, latest in _host_observations(host, since)["latest"].items():
            state[url] = latest["live"]
    return state


def _events_for(sub: _Sub, observations: dict) -> tuple[list[dict], dict]:
    events: list[dict] = []
    state: dict[str, bool] = {}
    cursor = int(sub.cursor_ts or 0)
    for host in sub.hosts:
        obs = observations[host]
        page = "https://402signal.com/endpoints/" + quote(host, safe="")
        for url, clock in sorted(obs["clocks"].items()):
            price_at = clock["price_changed_at"]
            if "price" in sub.events and price_at is not None and int(price_at) > cursor:
                events.append({
                    "event": "price_changed", "host": host, "url": url,
                    "amount_atomic": clock["amount"], "changed_at": _iso(price_at), "endpoint_page": page,
                    "_ts": int(price_at),
                })
            pay_at = clock["payTo_changed_at"]
            if "recipient" in sub.events and pay_at is not None and int(pay_at) > cursor:
                events.append({
                    "event": "recipient_changed", "host": host, "url": url,
                    "payTo": clock["payTo"], "observed_payTo": clock["pending_payTo"] or clock["payTo"],
                    "changed_at": _iso(pay_at), "endpoint_page": page, "_ts": int(pay_at),
                })
        for url, latest in sorted(obs["latest"].items()):
            state[url] = latest["live"]
            previous = sub.state.get(url)
            if (
                "liveness" in sub.events
                and previous is not None
                and bool(previous) != latest["live"]
                and latest["ts"] > cursor
            ):
                events.append({
                    "event": "liveness_changed", "host": host, "url": url, "live": latest["live"],
                    "miss_reason": latest["miss_reason"], "observed_at": _iso(latest["ts"]), "endpoint_page": page,
                    "_ts": int(latest["ts"]),
                })
    events.sort(key=lambda e: (e["_ts"], e["url"], e["event"]))
    return events, state


def _batch(sub: _Sub, events: list[dict], state: dict, cursor: int) -> tuple[list[dict], dict, int]:
    """The oldest batch, the state to store and the cursor to advance to.

    When more than one batch is pending, the cursor moves only past what is sent and
    liveness transitions that were cut keep their previous state, so nothing is
    skipped; a change in the cut-off second is sent again next scan (at least once).
    """
    if len(events) <= MAX_EVENTS_PER_DELIVERY:
        return [{k: v for k, v in e.items() if k != "_ts"} for e in events], state, cursor
    batch = events[:MAX_EVENTS_PER_DELIVERY]
    cutoff = int(batch[-1]["_ts"])
    deferred = {e["url"] for e in events[MAX_EVENTS_PER_DELIVERY:] if e["event"] == "liveness_changed"}
    kept = {url: live for url, live in state.items() if url not in deferred}
    for url in deferred:
        if url in sub.state:
            kept[url] = sub.state[url]
    return [{k: v for k, v in e.items() if k != "_ts"} for e in batch], kept, min(cursor, cutoff - 1)


# --- signing and delivery -----------------------------------------------------


def sign(secret: str, ts: int, body: bytes) -> str:
    digest = hmac.new(secret.encode("utf-8"), b"%d." % int(ts) + body, hashlib.sha256).hexdigest()
    return "t=%d,v1=%s" % (int(ts), digest)


def verify_signature(secret: str, header: str, body: bytes, *, now: int | None = None,
                     tolerance_s: int = SIGNATURE_TOLERANCE_S) -> bool:
    """Reference verifier for receivers: constant-time compare, bounded clock skew."""
    parts = dict(p.split("=", 1) for p in str(header or "").split(",") if "=" in p)
    try:
        ts = int(parts.get("t", ""))
    except ValueError:
        return False
    current = _now() if now is None else int(now)
    if abs(current - ts) > int(tolerance_s):
        return False
    expected = sign(secret, ts, body).split("v1=", 1)[1]
    return hmac.compare_digest(expected, parts.get("v1", ""))


def _post(url: str, body: bytes, headers: dict, timeout: float) -> int:
    """POST through the probe's pinned HTTPS opener: public DNS re-checked, no redirects, no plain HTTP."""
    from live402 import probe

    pinned = probe._pin_https_target(url)
    if pinned is None:
        raise AlertError(400, "url_not_public_https")
    req = urllib.request.Request(url, data=body, method="POST", headers=headers)
    req.pinned_addrs = pinned[1]
    req.no_probe_redirects = True
    try:
        with probe._opener().open(req, timeout=timeout) as resp:
            resp.read(4096)
            return int(resp.status)
    except urllib.error.HTTPError as exc:
        return int(exc.code)


def _deliver(sub: _Sub, payload: dict) -> tuple[int | None, str | None]:
    body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ts = _now()
    headers = {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-402Signal-Delivery": payload["delivery_id"],
        "X-402Signal-Event": payload["type"],
        "X-402Signal-Signature": sign(sub.secret, ts, body),
    }
    try:
        return _post(sub.url, body, headers, DELIVERY_TIMEOUT_S), None
    except Exception as exc:
        return None, type(exc).__name__


def _record(sub: _Sub, kind: str, delivery_id: str, status, error, n_events: int, ts: int, *,
            cursor_ts: int | None = None, state: dict | None = None) -> bool:
    ok = status is not None and 200 <= int(status) < 300
    st = _store()
    st.alert_delivery_add(delivery_id, sub.id, ts, kind, status, n_events, error, DELIVERIES_KEPT)
    if ok:
        state_json = json.dumps(state or {}, sort_keys=True) if cursor_ts is not None else None
        st.alert_sub_delivered(sub.id, ts, int(status), cursor_ts, state_json)
    else:
        failures = int(sub.failures or 0) + 1
        backoff = min(BACKOFF_MAX_S, BACKOFF_BASE_S * (2 ** min(failures - 1, 10)))
        disabled = failures >= MAX_FAILURES
        st.alert_sub_failed(
            sub.id, failures, ts + backoff, status,
            ts if disabled else None, "delivery_failed" if disabled else None,
        )
    return ok


def _prune(ts: int) -> None:
    _store().alert_deliveries_prune(ts - DELIVERY_RETENTION_S)


# --- customer API -------------------------------------------------------------


def create(owner: str, body) -> dict:
    if not isinstance(body, dict):
        raise AlertError(400, "json_object_required")
    url = _normalize_url(body.get("url"))
    hosts = _normalize_hosts(body.get("hosts"))
    events = _normalize_events(body.get("events"))
    state = _baseline(hosts)
    ts = _now()
    sub_id = secrets.token_hex(8)
    secret = "whsec_" + secrets.token_urlsafe(32)
    st = _store()
    try:
        created = st.alert_sub_create(
            sub_id, owner, url, json.dumps(hosts), json.dumps(events), secret, ts,
            json.dumps(state, sort_keys=True), MAX_SUBSCRIPTIONS,
        )
        if not created:
            raise AlertError(409, "too_many_subscriptions", max=MAX_SUBSCRIPTIONS)
        row = st.alert_sub_get(sub_id, owner)
    except StoreUnavailable:
        raise AlertError(503, "alerts_unavailable", retryable=True) from None
    if not row:
        raise AlertError(503, "alerts_unavailable", retryable=True)
    out = _Sub(row).public()
    out["signing_secret"] = secret
    out["hosts_known"] = {host: _known(host) for host in hosts}
    out["note"] = (
        "Store signing_secret now; it is not shown again. Deliveries are at least once: "
        "treat a repeated event, url and changed_at as one change."
    )
    return out


def list_for(owner: str) -> list[dict]:
    try:
        rows = _store().alert_sub_list(owner)
    except StoreUnavailable:
        raise AlertError(503, "alerts_unavailable", retryable=True) from None
    return [_Sub(row).public() for row in rows]


def get(owner: str, sub_id) -> dict:
    sub = _own(owner, sub_id)
    try:
        rows = _store().alert_deliveries(sub.id, 20)
    except StoreUnavailable:
        raise AlertError(503, "alerts_unavailable", retryable=True) from None
    out = sub.public()
    out["deliveries"] = [
        {"id": r[0], "at": _iso(r[1]), "kind": r[2], "status": r[3], "events": r[4], "error": r[5]} for r in rows
    ]
    return out


def delete(owner: str, sub_id) -> None:
    sub = _own(owner, sub_id)
    try:
        _store().alert_sub_delete(sub.id, owner)
    except StoreUnavailable:
        raise AlertError(503, "alerts_unavailable", retryable=True) from None


def ping(owner: str, sub_id) -> dict:
    """Deliver a signed ping now. A 2xx re-enables a subscription disabled after failures."""
    sub = _own(owner, sub_id)
    ts = _now()
    delivery_id = secrets.token_hex(8)
    payload = {
        "type": "402signal.ping", "delivery_id": delivery_id, "subscription_id": sub.id,
        "generated_at": _iso(ts), "hosts": list(sub.hosts), "events": [],
    }
    status, error = _deliver(sub, payload)
    try:
        ok = _record(sub, "ping", delivery_id, status, error, 0, ts)
    except StoreUnavailable:
        raise AlertError(503, "alerts_unavailable", retryable=True, delivered=status is not None) from None
    return {"id": sub.id, "delivered": ok, "status": status, "error": error, "active": ok or sub.disabled_at is None}


# --- writer job ---------------------------------------------------------------


def scan(now: int | None = None) -> int:
    """Writer job. Delivers due change batches; returns the number of deliveries attempted."""
    ts = _now() if now is None else int(now)
    with _scan_lock:
        st = session.store()
        rows = st.alert_sub_due(ts)
        attempted = 0
        observations: dict[str, dict] = {}
        for row in rows:
            if attempted >= MAX_DELIVERIES_PER_SCAN:
                # The rest stay due (their cursors are untouched) for the next tick.
                break
            sub = _Sub(row)
            for host in sub.hosts:
                if host not in observations:
                    observations[host] = _host_observations(host, ts - LOOKBACK_S)
            events, state = _events_for(sub, observations)
            # One second of overlap so a change committed in the scan second is not lost.
            cursor = ts - 1
            if not events:
                st.alert_sub_cursor(sub.id, cursor, json.dumps(state, sort_keys=True))
                continue
            events, state, cursor = _batch(sub, events, state, cursor)
            delivery_id = secrets.token_hex(8)
            payload = {
                "type": "402signal.alerts", "delivery_id": delivery_id, "subscription_id": sub.id,
                "generated_at": _iso(ts), "events": events,
            }
            status, error = _deliver(sub, payload)
            attempted += 1
            ok = _record(sub, "alerts", delivery_id, status, error, len(events), ts, cursor_ts=cursor, state=state)
            if not ok:
                sys.stderr.write("alert_delivery_failed subscription=%s status=%s error=%s\n" % (sub.id, status, error))
        _prune(ts)
        return attempted
