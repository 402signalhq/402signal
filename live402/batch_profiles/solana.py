"""Native Solana push session observation. Cap and voucher delta are not prices."""

import re
from live402 import route_binding as rb
from live402.batch_profiles.base import uint

NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
ASSET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
PROGRAM = "CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX"
KEYS = {
    "network",
    "asset",
    "recipient",
    "operator",
    "program_id",
    "max_session_cap_atomic",
}


def check(ok):
    if not ok:
        raise rb.BindingError("unsupported_solana_session")


def address(v):
    check(type(v) is str and 32 <= len(v) <= 44)
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    n = 0
    for c in v:
        check(c in alphabet)
        n = n * 58 + alphabet.index(c)
    check((n.bit_length() + 7) // 8 + len(v) - len(v.lstrip("1")) == 32)


def validate(e, ctx, limits):
    try:
        rb.canonical(e)
        rb.canonical(limits)
        check(
            type(limits) is dict
            and set(limits) == KEYS
            and ctx == rb.request_context(ctx["url"], "GET")
        )
        check(
            type(e) is dict
            and set(e)
            <= {
                "cap",
                "currency",
                "decimals",
                "minVoucherDelta",
                "network",
                "operator",
                "programId",
                "recentBlockhash",
                "recentSlot",
                "recipient",
                "modes",
            }
        )
        check(
            set(e)
            >= {
                "cap",
                "currency",
                "decimals",
                "network",
                "operator",
                "programId",
                "recentBlockhash",
                "recentSlot",
                "recipient",
            }
        )
        check(
            e["currency"] == ASSET
            and type(e["decimals"]) is int
            and e["decimals"] == 6
            and e["network"] == "mainnet"
            and e["programId"] == PROGRAM
        )
        check("modes" not in e or e["modes"] == ["push"])
        for key in ("operator", "recipient", "programId", "recentBlockhash"):
            address(e[key])
        uint(e["recentSlot"])
        cap = uint(e["cap"])
        if "minVoucherDelta" in e:
            check(uint(e["minVoucherDelta"]) <= cap)
        check(
            limits["network"] == NETWORK
            and limits["asset"] == ASSET
            and limits["recipient"] == e["recipient"]
            and limits["operator"] == e["operator"]
            and limits["program_id"] == PROGRAM
            and cap <= uint(limits["max_session_cap_atomic"])
        )
        return {
            "network": NETWORK,
            "asset": ASSET,
            "recipient": e["recipient"],
            "operator": e["operator"],
            "program_id": PROGRAM,
            "session_cap_atomic": e["cap"],
            "min_voucher_delta_atomic": e.get("minVoucherDelta"),
            "recent_blockhash": e["recentBlockhash"],
            "recent_slot": e["recentSlot"],
            "mode": "push",
            "per_call_amount_atomic": None,
        }
    except (ValueError, KeyError, TypeError, OverflowError):
        raise rb.BindingError("unsupported_solana_session") from None
