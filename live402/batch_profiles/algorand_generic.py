"""Generic two-item same-payee atomic manifest with independent buyer job pins."""

import re
from live402 import route_binding as rb
from live402.batch_profiles.algorand import NETWORK, ASSET, EXTENSION, _address, _uint

KEYS = {
    "network",
    "asset",
    "recipient",
    "fee_payer",
    "max_item_amount_atomic",
    "max_total_amount_atomic",
    "max_sponsor_fee_micro_algo",
    "job_hashes",
}


def check(ok):
    if not ok:
        raise rb.BindingError("unsupported_algorand_two_item")


def validate(envelope, context, limits):
    try:
        rb.canonical(envelope)
        rb.canonical(context)
        rb.canonical(limits)
        check(type(limits) is dict and set(limits) == KEYS)
        check(
            type(context) is dict
            and set(context) == {"url", "method", "body_sha256"}
            and context == rb.request_context(context["url"], "GET")
        )
        hashes = limits["job_hashes"]
        check(
            type(hashes) is list
            and len(hashes) == 2
            and all(type(v) is str and re.fullmatch(r"[0-9a-f]{64}", v) for v in hashes)
        )
        check(
            type(envelope) is dict
            and set(envelope)
            <= {"x402Version", "resource", "accepts", "extensions", "error"}
            and type(envelope.get("x402Version")) is int
            and envelope["x402Version"] == 2
        )
        resource = envelope.get("resource")
        check(
            type(resource) is dict
            and set(resource) <= {"url", "mimeType", "description"}
            and resource.get("url") == context["url"]
            and all(
                type(v) is str and len(v.encode("utf-8")) <= 4096
                for v in resource.values()
            )
        )
        check(
            "error" not in envelope
            or type(envelope["error"]) is str
            and len(envelope["error"].encode("utf-8")) <= 1024
        )
        check(type(envelope.get("accepts")) is list and len(envelope["accepts"]) == 1)
        req = envelope["accepts"][0]
        check(
            type(req) is dict
            and set(req)
            == {
                "scheme",
                "network",
                "asset",
                "amount",
                "payTo",
                "maxTimeoutSeconds",
                "extra",
            }
        )
        check(
            req["scheme"] == "exact"
            and req["network"] == NETWORK
            and req["asset"] == ASSET
            and type(req["maxTimeoutSeconds"]) is int
            and 1 <= req["maxTimeoutSeconds"] <= 300
        )
        amount = _uint(req["amount"])
        total = str(amount * 2)
        _uint(total)
        extra = req["extra"]
        check(
            type(extra) is dict
            and set(extra) <= {"feePayer", "decimals"}
            and (
                "decimals" not in extra
                or type(extra["decimals"]) is int
                and extra["decimals"] == 6
            )
        )
        _address(req["payTo"])
        _address(extra.get("feePayer"))
        check(req["payTo"] != extra["feePayer"])
        expected = {
            "version": 1,
            "network": NETWORK,
            "asset": ASSET,
            "recipient": req["payTo"],
            "resource": context["url"],
            "requestHash": rb.digest(context),
            "itemCount": 2,
            "itemAmount": req["amount"],
            "totalAmount": total,
            "paymentIndices": [1, 2],
            "sponsorIndex": 0,
            "feePayer": extra["feePayer"],
            "maxSponsorFeeMicroAlgo": "15000",
            "jobHashes": hashes,
        }
        check(
            type(envelope.get("extensions")) is dict
            and set(envelope["extensions"]) == {EXTENSION}
            and rb.canonical(envelope["extensions"][EXTENSION])
            == rb.canonical(expected)
        )
        check(
            limits["network"] == NETWORK
            and limits["asset"] == ASSET
            and limits["recipient"] == req["payTo"]
            and limits["fee_payer"] == extra["feePayer"]
        )
        check(
            amount <= _uint(limits["max_item_amount_atomic"])
            and int(total) <= _uint(limits["max_total_amount_atomic"])
            and _uint(limits["max_sponsor_fee_micro_algo"]) >= 15000
        )
        return expected
    except (ValueError, TypeError, KeyError, OverflowError):
        raise rb.BindingError("unsupported_algorand_two_item") from None
