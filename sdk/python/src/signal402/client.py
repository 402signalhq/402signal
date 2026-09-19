"""Thin stdlib client for the hosted check. No wallet, no signing, no retries.

The buyer authorizes the $0.003 checking fee with its own x402 client and
passes the resulting ``PAYMENT-SIGNATURE`` header here; this module only moves
bytes and classifies the answer. See https://402signal.com/developers.

Transport rules: the router URL must be https (plain http only to a loopback
address, for fixtures) with no credentials, query or fragment; redirects are
refused to keep payment headers on the configured endpoint; every answer is read to at most
``MAX_RESPONSE_BYTES``.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

DEFAULT_ROUTER = "https://402signal.com/route"
PAYMENT_HEADER = "PAYMENT-SIGNATURE"
REPLAY_KEY_HEADER = "Replay-Key"
_TIMEOUT_S = 75.0
MAX_RESPONSE_BYTES = 256 * 1024


class RedirectRefused(ValueError):
    """Redirects are refused to keep payment headers on the configured endpoint."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RedirectRefused("redirect refused: %s answered %d" % (req.full_url, code))


_opener = urllib.request.build_opener(_NoRedirect())


def _router_url(router: str) -> str:
    """https, or plain http to a loopback address for fixtures; never credentials, a query or a fragment."""
    parts = urllib.parse.urlsplit(str(router or ""))
    loopback = parts.scheme == "http" and parts.hostname in ("127.0.0.1", "localhost", "::1")
    if parts.scheme != "https" and not loopback:
        raise ValueError("router must be an https URL")
    if not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError("router must be a plain URL: no credentials, query or fragment")
    return str(router)


def _read_bounded(res) -> bytes:
    raw = res.read(MAX_RESPONSE_BYTES + 1)
    if len(raw) > MAX_RESPONSE_BYTES:
        raise ValueError("response larger than %d bytes" % MAX_RESPONSE_BYTES)
    return raw

# Outcome names. Read ``live``, ``payable``, ``selected_payment`` and ``billing``
# together; the name is a summary, not a substitute.
CHALLENGE = "challenge"                    # HTTP 402: fee requirements, nothing checked yet
LIVE = "live"                              # HTTP 200 live:true, fee settled
MISS = "miss"                              # HTTP 200 live:false, typed miss_reason, no fee
BINDING_UNAVAILABLE = "binding_unavailable"  # HTTP 503 route_binding_unavailable: completed, keep calling
SETTLED_EVIDENCE_FAILED = "settled_evidence_failed"  # HTTP 503, fee settled, required evidence failed
UNKNOWN_SETTLEMENT = "unknown_settlement"  # HTTP 503, never reuse this authorization
REFUSED = "refused"                        # HTTP 503/429 before verification, not_attempted
ERROR = "error"                            # anything else


@dataclass(frozen=True)
class CheckResult:
    status: int
    text: str
    body: Any
    outcome: str

    @property
    def receipt(self) -> dict | None:
        tr = transparency(self.body)
        rec = tr.get("receipt") if isinstance(tr, dict) else None
        return rec if isinstance(rec, dict) else None


def transparency(body: Any) -> dict:
    if not isinstance(body, dict):
        return {}
    pq = body.get("pq_trust")
    tr = pq.get("transparency") if isinstance(pq, dict) else None
    return tr if isinstance(tr, dict) else {}


def classify(status: int, body: Any) -> str:
    """Map one check answer to an outcome name using the documented contract."""
    if status == 402:
        return CHALLENGE
    if not isinstance(body, dict):
        return ERROR
    if status == 200:
        if body.get("live") is True:
            return LIVE
        if body.get("live") is False:
            return MISS
        return ERROR
    if status in (429, 503):
        if body.get("binding_error") == "route_binding_unavailable":
            return BINDING_UNAVAILABLE
        billing = body.get("billing") if isinstance(body.get("billing"), dict) else {}
        state = billing.get("settlement_state")
        if state == "settled":
            return SETTLED_EVIDENCE_FAILED
        if state == "unknown":
            return UNKNOWN_SETTLEMENT
        return REFUSED
    return ERROR


def _post(router: str, request: dict, headers: dict[str, str], timeout: float) -> CheckResult:
    router = _router_url(router)
    data = json.dumps(request, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(router, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    for name, value in headers.items():
        req.add_header(name, value)
    try:
        with _opener.open(req, timeout=timeout) as res:  # noqa: S310 (https or loopback enforced above; redirects refused)
            status, raw = res.status, _read_bounded(res)
    except urllib.error.HTTPError as exc:
        status, raw = exc.code, _read_bounded(exc)
    text = raw.decode("utf-8", errors="replace")
    try:
        body = json.loads(text)
    except ValueError:
        body = None
    return CheckResult(status=status, text=text, body=body, outcome=classify(status, body))


def challenge(request: dict, *, router: str = DEFAULT_ROUTER, timeout: float = _TIMEOUT_S) -> CheckResult:
    """Unpaid request: returns the HTTP 402 fee requirements (``accepts``). Nothing is checked yet."""
    return _post(router, request, {}, timeout)


def check(
    request: dict,
    payment_signature: str,
    *,
    router: str = DEFAULT_ROUTER,
    replay_key: str | None = None,
    timeout: float = _TIMEOUT_S,
) -> CheckResult:
    """Paid request: the identical JSON plus the buyer's PAYMENT-SIGNATURE header.

    ``replay_key`` (64 lowercase hex characters) lets a lost response be
    recovered with ``recover`` instead of paying again.
    """
    if not isinstance(payment_signature, str) or not payment_signature.strip():
        raise ValueError("payment_signature is required")
    headers = {PAYMENT_HEADER: payment_signature.strip()}
    if replay_key is not None:
        _check_replay_key(replay_key)
        headers[REPLAY_KEY_HEADER] = replay_key
    return _post(router, request, headers, timeout)


def recover(
    request: dict,
    payment_signature: str,
    replay_key: str,
    *,
    router: str = DEFAULT_ROUTER,
    timeout: float = _TIMEOUT_S,
) -> CheckResult:
    """Read-only recovery of a lost answer: same JSON, same authorization, same Replay-Key, Replay-Only: 1."""
    _check_replay_key(replay_key)
    headers = {PAYMENT_HEADER: payment_signature.strip(), REPLAY_KEY_HEADER: replay_key, "Replay-Only": "1"}
    return _post(router, request, headers, timeout)


def _check_replay_key(value: str) -> None:
    if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
        raise ValueError("replay_key must be 64 lowercase hex characters")
