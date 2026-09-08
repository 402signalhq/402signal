"""Versioned Algorand payment manifests; jobs and payments are separate counts.

A quote is an observed merchant declaration, not independent chain verification.
The buyer must read current suggested parameters before signing. Per-byte fee
markets are deliberately refused by this initial bounded quote profile.
"""
from live402 import route_binding as rb
from live402.batch_profiles.algorand import NETWORK, ASSET, EXTENSION, _address, _uint
import re

ATOMIC = "algorand-atomic-multi-item-v1"
INVOICE = "algorand-aggregate-invoice-v1"
PROFILES = (ATOMIC, INVOICE)
COMMON_KEYS = {"network", "asset", "recipient", "fee_payer", "max_total_amount_atomic", "max_sponsor_fee_micro_algo", "job_hashes"}
GENESIS = "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="


def check(value):
    if not value:
        raise rb.BindingError("unsupported_algorand_manifest")


def validate_limits(profile, limits):
    rb.canonical(limits)
    check(profile in PROFILES and type(limits) is dict)
    keys = COMMON_KEYS | ({"max_item_amount_atomic"} if profile == ATOMIC else set())
    check(set(limits) == keys)
    check(limits["network"] == NETWORK and limits["asset"] == ASSET)
    for key in keys:
        if key.startswith("max_"):
            _uint(limits[key])
    _address(limits["recipient"])
    _address(limits["fee_payer"])
    check(limits["recipient"] != limits["fee_payer"])
    hashes = limits["job_hashes"]
    check(type(hashes) is list and 2 <= len(hashes) <= (15 if profile == ATOMIC else 64))
    check(all(type(h) is str and re.fullmatch(r"[0-9a-f]{64}", h) for h in hashes))
    return len(hashes)


def validate_quote(quote, payment_count):
    check(type(quote) is dict and set(quote) == {"network", "genesisHash", "genesisId", "transactionCount", "firstValid", "lastValid", "minFeeMicroAlgo", "feePerByteMicroAlgo", "sponsorFeeMicroAlgo", "observedAt", "expiresAt"})
    check(quote["network"] == NETWORK and quote["genesisHash"] == GENESIS and quote["genesisId"] == "mainnet-v1.0")
    check(type(quote["transactionCount"]) is int and quote["transactionCount"] == payment_count + 1)
    first, last = _uint(quote["firstValid"]), _uint(quote["lastValid"])
    check(first <= last <= first + 1000)
    minimum = _uint(quote["minFeeMicroAlgo"])
    check(1000 <= minimum <= 5000 and quote["feePerByteMicroAlgo"] == "0")
    check(_uint(quote["sponsorFeeMicroAlgo"]) == minimum * (payment_count + 1))
    check(type(quote["observedAt"]) is int and quote["observedAt"] > 0 and type(quote["expiresAt"]) is int and quote["observedAt"] < quote["expiresAt"] <= quote["observedAt"] + 60)
    return quote["expiresAt"]


def validate(envelope, context, limits, profile):
    try:
        rb.canonical(envelope)
        count = validate_limits(profile, limits)
        check(context == rb.request_context(context["url"], "GET"))
        check(type(envelope) is dict and set(envelope) <= {"x402Version", "resource", "accepts", "extensions", "error"} and type(envelope.get("x402Version")) is int and envelope["x402Version"] == 2)
        resource = envelope.get("resource")
        check(type(resource) is dict and set(resource) <= {"url", "mimeType", "description"} and resource.get("url") == context["url"] and all(type(v) is str and len(v.encode()) <= 4096 for v in resource.values()))
        check("error" not in envelope or type(envelope["error"]) is str and len(envelope["error"].encode()) <= 1024)
        check(type(envelope.get("accepts")) is list and len(envelope["accepts"]) == 1)
        req = envelope["accepts"][0]
        check(type(req) is dict and set(req) == {"scheme", "network", "asset", "amount", "payTo", "maxTimeoutSeconds", "extra"})
        check(req["scheme"] == "exact" and req["network"] == NETWORK and req["asset"] == ASSET and req["payTo"] == limits["recipient"])
        check(type(req["maxTimeoutSeconds"]) is int and 1 <= req["maxTimeoutSeconds"] <= 300)
        extra = req["extra"]
        check(type(extra) is dict and set(extra) <= {"feePayer", "decimals"} and extra.get("feePayer") == limits["fee_payer"] and ("decimals" not in extra or type(extra["decimals"]) is int and extra["decimals"] == 6))
        amount = _uint(req["amount"])
        payments = count if profile == ATOMIC else 1
        total = str(amount * payments)
        _uint(total)
        check(type(envelope.get("extensions")) is dict and set(envelope["extensions"]) == {EXTENSION})
        manifest = envelope["extensions"][EXTENSION]
        check(type(manifest) is dict and "feeQuote" in manifest)
        quote = manifest["feeQuote"]
        validate_quote(quote, payments)
        expected = {"version": 2, "profile": profile, "network": NETWORK, "asset": ASSET, "recipient": req["payTo"], "resource": context["url"], "requestHash": rb.digest(context), "jobCount": count, "paymentCount": payments, "paymentAmount": req["amount"], "perJobAmount": req["amount"] if profile == ATOMIC else None, "totalAmount": total, "paymentIndices": list(range(1, payments + 1)), "sponsorIndex": 0, "feePayer": extra["feePayer"], "jobHashes": limits["job_hashes"], "feeQuote": quote}
        check(rb.canonical(manifest) == rb.canonical(expected))
        check(int(total) <= _uint(limits["max_total_amount_atomic"]) and _uint(quote["sponsorFeeMicroAlgo"]) <= _uint(limits["max_sponsor_fee_micro_algo"]))
        if profile == ATOMIC:
            check(amount <= _uint(limits["max_item_amount_atomic"]))
        return expected
    except (ValueError, KeyError, TypeError, UnicodeError, OverflowError):
        raise rb.BindingError("unsupported_algorand_manifest") from None


def validate_atomic(envelope, context, limits):
    return validate(envelope, context, limits, ATOMIC)


def validate_invoice(envelope, context, limits):
    return validate(envelope, context, limits, INVOICE)
