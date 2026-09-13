"""Observe Machine Payments Protocol challenges: any method, any intent.

A seller that speaks MPP answers HTTP 402 with one or more
`WWW-Authenticate: Payment ...` challenges (draft-httpauth-payment). Each names
a `method` (tempo, evm, solana, stripe, ...), an `intent` (charge, session,
subscription, ...) and a base64url JCS `request` object with the terms. This
module reads those terms as observations:

- a `charge` on an EVM-shaped method (tempo, evm) becomes a payment option
  (network from the chain id, TIP-20 or ERC-20 currency, recipient, amount)
  with scheme `mpp-charge`, so a plain check can report live, payable and a
  selected payment for an MPP-only seller;
- `session` and `subscription` terms (unit price, suggested deposit, period)
  are returned as observed terms, never as a fixed purchase price;
- unknown methods or intents stay visible as unclassified terms.

Nothing here signs, binds or settles. Signed v4 route binding stays x402
exact; MPP charges bind through the Check group offer (batch) path.
"""
from __future__ import annotations

import base64
import datetime
import json
import re

from live402 import evm_chains

MAX_HEADER = 16384
MAX_CHALLENGES = 16
MAX_REQUEST = 8192
SCHEME = "mpp-charge"
TEMPO_DEFAULT_CHAIN = 4217
SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
EVM_METHODS = frozenset({"tempo", "evm"})
_PARAM = re.compile(r'([A-Za-z][A-Za-z0-9_-]*)="((?:[^"\\]|\\[\x20-\x7e])*)"')
_HEX_ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")
_REQUIRED = ("id", "realm", "method", "intent", "request")


class MppParseError(ValueError):
    pass


def _check(ok, message="unsupported_mpp_challenge"):
    if not ok:
        raise MppParseError(message)


def _expiry(text):
    if text is None:
        return None
    if not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z", text):
        return None
    try:
        return int(datetime.datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


def _decode_request(token):
    _check(re.fullmatch(r"[A-Za-z0-9_-]+", token or "") is not None and len(token) <= MAX_REQUEST)
    body = base64.urlsafe_b64decode(token + "=" * ((-len(token)) % 4))
    _check(base64.urlsafe_b64encode(body).decode().rstrip("=") == token)
    try:
        parsed = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise MppParseError("unsupported_mpp_challenge") from None
    _check(isinstance(parsed, dict))
    return parsed


def parse(raw) -> list[dict]:
    """Every `Payment` challenge in a WWW-Authenticate value, in wire order.

    Tolerates a missing `expires` (optional in the draft) and unknown methods.
    Raises MppParseError on malformed input; callers treat that as no offer.
    """
    _check(type(raw) is str and 0 < len(raw) <= MAX_HEADER and all(32 <= ord(c) < 127 for c in raw))
    items, at = [], 0
    while at < len(raw):
        _check(len(items) < MAX_CHALLENGES and raw.startswith("Payment ", at))
        at += 8
        params = {}
        while True:
            while at < len(raw) and raw[at] == " ":
                at += 1
            match = _PARAM.match(raw, at)
            _check(match is not None)
            name = match[1].lower()
            _check(name not in params)
            params[name] = re.sub(r"\\(.)", r"\1", match[2])
            at = match.end()
            while at < len(raw) and raw[at] == " ":
                at += 1
            if at == len(raw):
                break
            _check(raw[at] == ",")
            at += 1
            while at < len(raw) and raw[at] == " ":
                at += 1
            _check(at < len(raw))
            if raw.startswith("Payment ", at):
                break
        _check(all(key in params for key in _REQUIRED))
        _check(0 < len(params["id"]) <= 256 and 0 < len(params["realm"]) <= 256)
        method = params["method"].strip().lower()
        intent = params["intent"].strip().lower()
        _check(re.fullmatch(r"[a-z0-9_-]{1,32}", method) is not None and re.fullmatch(r"[a-z0-9_-]{1,32}", intent) is not None)
        items.append({
            "index": len(items),
            "id": params["id"],
            "realm": params["realm"],
            "method": method,
            "intent": intent,
            "expires": _expiry(params.get("expires")),
            "description": params.get("description"),
            "request": _decode_request(params["request"]),
        })
    _check(bool(items))
    return items


def _text(value, limit=256):
    if isinstance(value, str) and 0 < len(value) <= limit:
        return value
    return None


def _atomic(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and 0 <= value < 2**63:
        return value
    if isinstance(value, str) and value.isdigit() and len(value) <= 20 and int(value) < 2**63:
        return int(value)
    return None


def _address(value):
    text = _text(value, 42)
    return text if text and _HEX_ADDRESS.match(text) else None


def _chain_id(method, details):
    raw = details.get("chainId") if isinstance(details, dict) else None
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int) and 0 < raw < 2**32:
        return raw
    if raw is None and method == "tempo":
        return TEMPO_DEFAULT_CHAIN
    return None


def normalize(item: dict) -> dict:
    """Public terms of one parsed challenge. Unknown shapes stay unclassified."""
    request = item.get("request") if isinstance(item.get("request"), dict) else {}
    details = request.get("methodDetails") if isinstance(request.get("methodDetails"), dict) else {}
    out = {
        "index": item.get("index"),
        "id": item.get("id"),
        "realm": item.get("realm"),
        "method": item.get("method"),
        "intent": item.get("intent"),
        "expires": item.get("expires"),
        "description": _text(item.get("description"), 512),
        "classified": False,
    }
    method, intent = out["method"], out["intent"]
    if method in EVM_METHODS:
        chain = _chain_id(method, details)
        if chain is None:
            return out
        network = "eip155:%d" % chain
        rail = evm_chains.rail_of_network(network) or ("base" if chain == 8453 else None)
        currency = _address(request.get("currency"))
        recipient = _address(request.get("recipient"))
        out.update({"network": network, "rail": rail, "asset": currency, "payTo": recipient})
        if intent == "charge":
            amount = _atomic(request.get("amount"))
            if currency and recipient and amount is not None:
                out.update({"amount_atomic": amount, "classified": True})
            return out
        if intent == "session":
            out.update({
                "unit_amount_atomic": _atomic(request.get("amount")),
                "unit_type": _text(request.get("unitType"), 64),
                "suggested_deposit_atomic": _atomic(request.get("suggestedDeposit")),
                "escrow_contract": _address(details.get("escrowContract")),
                "session_protocol": _text(details.get("sessionProtocol"), 16),
                "classified": bool(currency and recipient and _atomic(request.get("amount")) is not None),
            })
            return out
        if intent == "subscription":
            count = request.get("periodCount")
            out.update({
                "amount_atomic": _atomic(request.get("amount")),
                "period_count": count if isinstance(count, int) and not isinstance(count, bool) and 0 < count < 10**6 else None,
                "period_unit": _text(request.get("periodUnit"), 16),
                "subscription_expires": _expiry(request.get("subscriptionExpires")) if isinstance(request.get("subscriptionExpires"), str) else None,
                "classified": bool(currency and recipient and _atomic(request.get("amount")) is not None),
            })
            return out
        return out
    if method == "solana":
        out.update({
            "network": SOLANA_MAINNET, "rail": "solana",
            "asset": _text(request.get("currency"), 64), "payTo": _text(request.get("recipient"), 64),
            "amount_atomic": _atomic(request.get("amount")) if intent == "charge" else None,
            "unit_amount_atomic": _atomic(request.get("amount")) if intent == "session" else None,
            "suggested_deposit_atomic": _atomic(request.get("suggestedDeposit")) if intent == "session" else None,
        })
        out["classified"] = bool(out["asset"] and out["payTo"] and _atomic(request.get("amount")) is not None)
        return out
    return out


def from_headers(headers) -> list[dict]:
    """Normalized offers from a headers mapping (any key case). Empty when absent or malformed."""
    if not headers:
        return []
    values = [str(v) for k, v in dict(headers).items() if str(k).lower() == "www-authenticate"]
    raw = ", ".join(values).strip()
    if not raw or "Payment " not in raw:
        return []
    start = raw.find("Payment ")
    try:
        items = parse(raw[start:])
    except MppParseError:
        return []
    return [normalize(item) for item in items]


def charge_options(offers) -> list[dict]:
    """Payment options for classified charge offers (scheme mpp-charge)."""
    from live402 import payment

    out = []
    for offer in offers or []:
        if not isinstance(offer, dict) or offer.get("intent") != "charge" or not offer.get("classified"):
            continue
        network, asset, amount = offer.get("network"), offer.get("asset"), offer.get("amount_atomic")
        rail = offer.get("rail")
        if not network or not asset or amount is None or not rail:
            continue
        known = payment.known_usdc_asset(asset, network)
        display, usd = (payment.usdc_from_atomic(amount) if known else (None, None))
        if display is None:
            display = "%s %s" % (amount, asset)
        out.append({
            "network": network,
            "rail": rail,
            "asset": asset,
            "amount_atomic": amount,
            "decimals": payment.USDC_DECIMALS if known else None,
            "display_amount": display,
            "normalized_usd": usd,
            "payTo": offer.get("payTo"),
            "facilitator": None,
            "scheme": SCHEME,
            "version": None,
            "mpp": {"method": offer.get("method"), "intent": "charge", "id": offer.get("id"),
                    "realm": offer.get("realm"), "expires": offer.get("expires")},
        })
    return out


def public_terms(offers) -> list[dict]:
    """Bounded public projection for the /route response."""
    keep = ("index", "method", "intent", "realm", "expires", "network", "rail", "asset", "payTo",
            "amount_atomic", "unit_amount_atomic", "unit_type", "suggested_deposit_atomic",
            "period_count", "period_unit", "subscription_expires", "session_protocol", "classified")
    out = []
    for offer in (offers or [])[:MAX_CHALLENGES]:
        if isinstance(offer, dict):
            out.append({key: offer.get(key) for key in keep if offer.get(key) is not None or key in ("classified", "method", "intent")})
    return out
