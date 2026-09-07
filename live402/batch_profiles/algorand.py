"""Two-job sponsored Algorand USDC manifest; independent buyer pins required."""

import base64
import hashlib
import re
from urllib.parse import urlsplit, parse_qsl, unquote
from live402 import route_binding as rb

EXTENSION = "402signal-atomic-batch"
NETWORK = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="
ASSET = "31566704"
LIMIT_KEYS = {
    "network",
    "asset",
    "recipient",
    "fee_payer",
    "max_total_amount_atomic",
    "max_sponsor_fee_micro_algo",
}


def _check(ok):
    if not ok:
        raise rb.BindingError("unsupported_algorand_batch")


def _address(value):
    _check(type(value) is str and re.fullmatch(r"[A-Z2-7]{58}", value))
    raw = base64.b32decode(value + "======")
    _check(base64.b32encode(raw).decode().rstrip("=") == value)
    _check(hashlib.new("sha512_256", raw[:32]).digest()[-4:] == raw[32:])


def _uint(value):
    _check(type(value) is str and re.fullmatch(r"[1-9][0-9]{0,19}", value))
    n = int(value)
    _check(n <= 2**64 - 1)
    return n


def validate(envelope, context, limits):
    try:
        rb.canonical(envelope)
        rb.canonical(limits)
        rb.canonical(context)
        _check(type(limits) is dict and set(limits) == LIMIT_KEYS)
        _check(
            type(context) is dict and set(context) == {"url", "method", "body_sha256"}
        )
        url = context["url"]
        _check(context == rb.request_context(url, "GET"))
        parsed = urlsplit(url)
        _check(re.fullmatch(r"https://[^/?#]+/algorand/batch/sha256\?[^#]+", url))
        _check(not re.search(r"%(?![0-9a-fA-F]{2})", parsed.query))
        unquote(parsed.query.replace("+", " "), errors="strict")
        pairs = parse_qsl(
            parsed.query, keep_blank_values=True, strict_parsing=True, errors="strict"
        )
        _check(len(pairs) == 2 and sorted(k for k, _ in pairs) == ["left", "right"])
        query = dict(pairs)
        texts = [query["left"], query["right"]]
        _check(all(1 <= len(text.encode("utf-16-le")) // 2 <= 1024 for text in texts))
        _check(
            type(envelope) is dict
            and set(envelope)
            <= {"x402Version", "resource", "accepts", "extensions", "error"}
        )
        _check(
            type(envelope.get("x402Version")) is int and envelope["x402Version"] == 2
        )
        _check(
            type(envelope.get("resource")) is dict
            and envelope["resource"].get("url") == url
        )
        _check(type(envelope.get("accepts")) is list and len(envelope["accepts"]) == 1)
        req = envelope["accepts"][0]
        _check(
            type(req) is dict
            and set(req)
            <= {
                "scheme",
                "network",
                "asset",
                "amount",
                "payTo",
                "maxTimeoutSeconds",
                "extra",
            }
        )
        _check(
            req.get("scheme") == "exact"
            and req.get("network") == NETWORK
            and req.get("asset") == ASSET
            and req.get("amount") == "1000"
        )
        _check(
            type(req.get("maxTimeoutSeconds")) is int
            and 1 <= req["maxTimeoutSeconds"] <= 300
        )
        extra = req.get("extra")
        _check(type(extra) is dict and set(extra) <= {"feePayer", "decimals"})
        _check(
            "decimals" not in extra
            or type(extra["decimals"]) is int
            and extra["decimals"] == 6
        )
        _address(req.get("payTo"))
        _address(extra.get("feePayer"))
        _check(req["payTo"] != extra["feePayer"])
        expected = {
            "version": 1,
            "network": NETWORK,
            "asset": ASSET,
            "recipient": req["payTo"],
            "resource": url,
            "requestHash": rb.digest(context),
            "itemCount": 2,
            "itemAmount": "1000",
            "totalAmount": "2000",
            "paymentIndices": [1, 2],
            "sponsorIndex": 0,
            "feePayer": extra["feePayer"],
            "maxSponsorFeeMicroAlgo": "15000",
            "jobHashes": [hashlib.sha256(text.encode()).hexdigest() for text in texts],
        }
        _check(
            type(envelope.get("extensions")) is dict
            and set(envelope["extensions"]) == {EXTENSION}
        )
        _check(
            rb.canonical(envelope["extensions"][EXTENSION]) == rb.canonical(expected)
        )
        _check(
            limits["network"] == NETWORK
            and limits["asset"] == ASSET
            and limits["recipient"] == expected["recipient"]
            and limits["fee_payer"] == expected["feePayer"]
        )
        _check(
            _uint(limits["max_total_amount_atomic"]) >= 2000
            and _uint(limits["max_sponsor_fee_micro_algo"]) >= 15000
        )
        return expected
    except (ValueError, KeyError, TypeError, UnicodeError, OverflowError):
        raise rb.BindingError("unsupported_algorand_batch") from None
