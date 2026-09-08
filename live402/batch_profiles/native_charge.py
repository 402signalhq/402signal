"""Bounded native MPP offer selection; never payment authorization."""
import base64
import datetime
import hashlib
import re
from urllib.parse import urlsplit
from live402 import route_binding as rb


def check(ok):
    if not ok:
        raise rb.BindingError("unsupported_native_charge")


def challenges(raw):
    """Parse quoted Payment parameters without splitting commas inside values."""
    check(type(raw) is str and 0 < len(raw) <= 16384
          and all(32 <= ord(c) < 127 for c in raw))
    items, at = [], 0
    while at < len(raw):
        check(len(items) < 16 and raw.startswith("Payment ", at))
        start = at
        at += 8
        params = {}
        while True:
            while at < len(raw) and raw[at] == " ":
                at += 1
            match = re.match(r'([A-Za-z][A-Za-z0-9_-]*)="((?:[^"\\]|\\[\x20-\x7e])*)"', raw[at:])
            check(match is not None)
            name = match[1].lower()
            check(name not in params)
            params[name] = re.sub(r'\\(.)', r'\1', match[2])
            at += match.end()
            end = at
            while at < len(raw) and raw[at] == " ":
                at += 1
            if at == len(raw):
                break
            check(raw[at] == ",")
            at += 1
            while at < len(raw) and raw[at] == " ":
                at += 1
            check(at < len(raw))
            if raw.startswith("Payment ", at):
                break
        required = {"id", "realm", "method", "intent", "request", "expires"}
        check(required <= set(params) <= required | {"description", "digest", "opaque", "header"})
        check(0 < len(params["id"]) <= 256)
        check("header" not in params or params["header"].lower() in {"authorization", "payment-authorization"})
        token = params["request"]
        check(re.fullmatch(r"[A-Za-z0-9_-]+", token))
        body = base64.urlsafe_b64decode(token + "=" * ((-len(token)) % 4))
        check(base64.urlsafe_b64encode(body).decode().rstrip("=") == token)
        check(re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z", params["expires"]))
        expiry = int(datetime.datetime.fromisoformat(params["expires"].replace("Z", "+00:00")).timestamp())
        items.append({"raw": raw[start:end], "params": params,
                      "request": rb.strict_json(body), "expiry": expiry,
                      "index": len(items)})
    check(bool(items))
    return items


def select(challenge, context, method, expected_realm=None, validator=None):
    # Alternative protocols/body content remain opaque, bounded evidence. Their
    # presence never changes the explicitly requested native payment profile.
    check(type(challenge.get("status")) is int and challenge["status"] == 402)
    check(type(challenge.get("bodyText")) is str and len(challenge["bodyText"].encode()) <= 16384)
    alternate = challenge.get("paymentRequired")
    check(alternate is None or type(alternate) is str and 0 < len(alternate) <= 16384
          and all(32 <= ord(c) < 127 for c in alternate))
    check(len(rb.canonical(challenge)) <= 24576)
    realm = expected_realm if expected_realm is not None else urlsplit(context["url"]).hostname
    body_digest = "sha-256=" + base64.b64encode(hashlib.sha256(b"").digest()).decode()
    matches = []
    for item in challenges(challenge["wwwAuthenticate"]):
        p = item["params"]
        if p["method"] != method or p["intent"] != "charge" or p["realm"] != realm:
            continue
        if "digest" in p and p["digest"] != body_digest:
            continue
        if validator is not None:
            try:
                validator(item["request"])
            except (ValueError, KeyError, TypeError, OverflowError):
                continue
        matches.append(item)
    check(len(matches) == 1)
    return matches[0]


def wire(challenge, context, method, expected_realm=None, validator=None):
    chosen = select(challenge, context, method, expected_realm, validator)
    return chosen["request"], chosen["expiry"]
