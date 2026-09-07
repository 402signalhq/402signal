"""Pinned Base batch offer; capital limits are buyer policy, not a quoted price."""

import re
from live402 import route_binding as rb

NETWORK = "eip155:8453"
ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
AUTHORIZER = "0x3721824a31197dcDD2984cF43b92B6cc8A87c0Fb"
KEYS = {
    "network",
    "asset",
    "recipient",
    "receiver_authorizer",
    "withdraw_delay_seconds",
    "max_call_amount_atomic",
    "max_capital_atomic",
    "max_cumulative_amount_atomic",
}


def check(ok):
    if not ok:
        raise rb.BindingError("unsupported_base_batch")


def uint(v):
    check(type(v) is str and re.fullmatch(r"[1-9][0-9]{0,19}", v))
    n = int(v)
    check(n <= 2**64 - 1)
    return n


def validate(e, ctx, limits):
    try:
        rb.canonical(e)
        rb.canonical(limits)
        check(type(limits) is dict and set(limits) == KEYS)
        check(ctx == rb.request_context(ctx["url"], "GET"))
        check(
            type(e) is dict
            and set(e) <= {"x402Version", "resource", "accepts", "extensions", "error"}
            and type(e.get("x402Version")) is int
            and e["x402Version"] == 2
        )
        resource = e.get("resource")
        check(
            type(resource) is dict
            and set(resource) <= {"url", "mimeType", "description"}
            and resource.get("url") == ctx["url"]
        )
        check(
            all(
                type(v) is str and len(v.encode("utf-8")) <= 4096
                for v in resource.values()
            )
        )
        check(
            "error" not in e
            or type(e["error"]) is str
            and len(e["error"].encode("utf-8")) <= 1024
        )
        check(
            "extensions" not in e
            or e["extensions"] == {}
            or e["extensions"] == {"bazaar": {}}
        )
        check(type(e.get("accepts")) is list and len(e["accepts"]) == 1)
        a = e["accepts"][0]
        check(
            type(a) is dict
            and set(a)
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
            a["scheme"] == "batch-settlement"
            and a["network"] == NETWORK
            and a["asset"] == ASSET
        )
        check(
            type(a["payTo"]) is str
            and re.fullmatch(r"0x[0-9a-fA-F]{40}", a["payTo"])
            and int(a["payTo"][2:], 16) > 0
        )
        check(
            type(a["maxTimeoutSeconds"]) is int and 1 <= a["maxTimeoutSeconds"] <= 300
        )
        check(
            a["extra"]
            == {
                "name": "USD Coin",
                "version": "2",
                "assetTransferMethod": "eip3009",
                "receiverAuthorizer": AUTHORIZER,
                "withdrawDelay": 900,
            }
        )
        check(
            limits["network"] == NETWORK
            and limits["asset"] == ASSET
            and limits["recipient"] == a["payTo"]
            and limits["receiver_authorizer"] == AUTHORIZER
            and type(limits["withdraw_delay_seconds"]) is int
            and limits["withdraw_delay_seconds"] == 900
        )
        check(
            uint(a["amount"])
            <= uint(limits["max_call_amount_atomic"])
            <= uint(limits["max_cumulative_amount_atomic"])
            <= uint(limits["max_capital_atomic"])
        )
        return {
            "network": NETWORK,
            "asset": ASSET,
            "recipient": a["payTo"],
            "receiver_authorizer": AUTHORIZER,
            "withdraw_delay_seconds": 900,
            "call_amount_atomic": a["amount"],
            "max_timeout_seconds": a["maxTimeoutSeconds"],
            "scheme": "batch-settlement",
        }
    except (ValueError, KeyError, TypeError, OverflowError):
        raise rb.BindingError("unsupported_base_batch") from None
