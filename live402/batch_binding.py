"""Bounded current batch/session observation; never spending authorization."""

import base64
import datetime
import re
import time
from urllib.parse import urlsplit
from live402 import batch_codec, route_binding as rb
from live402.batch_profiles import (
    base, solana, algorand, algorand_generic, algorand_manifest,
    base_charge, native_charge, algorand_charge,
)

MODEL = "proof_carrying_batch_observation_v1"
PROFILES = {
    "algorand-mpp-charge-v1": algorand_charge.validate,
    "base-mpp-charge-v1": base_charge.validate,
    "base-x402-batch-v1": base.validate,
    "solana-mpp-session-v1": solana.validate,
    "algorand-atomic-batch-v1": algorand.validate,
    "algorand-atomic-two-item-v1": algorand_generic.validate,
    algorand_manifest.ATOMIC: algorand_manifest.validate_atomic,
    algorand_manifest.INVOICE: algorand_manifest.validate_invoice,
}
RAW_LIMIT = 24576


def check(ok):
    if not ok:
        raise rb.BindingError("invalid_batch_binding")


def requested(body):
    return type(body) is dict and ("merchant_profile" in body or "buyer_limits" in body)


def _admit_named(profile, limits):
    if profile in algorand_manifest.PROFILES:
        algorand_manifest.validate_limits(profile, limits)
        return
    if profile == "algorand-mpp-charge-v1":
        algorand_charge.validate_limits(limits)
        return
    module = {
        "base-mpp-charge-v1": base_charge,
        "base-x402-batch-v1": base,
        "solana-mpp-session-v1": solana,
        "algorand-atomic-batch-v1": algorand,
        "algorand-atomic-two-item-v1": algorand_generic,
    }[profile]
    check(set(limits) == getattr(module, "KEYS", getattr(module, "LIMIT_KEYS", set())))
    check(
        limits.get("network") == module.NETWORK and limits.get("asset") == module.ASSET
    )
    for key, value in limits.items():
        if key.startswith("max_"):
            base.uint(value)
        elif key == "job_hashes":
            check(
                type(value) is list
                and len(value) == 2
                and all(
                    type(item) is str and re.fullmatch(r"[0-9a-f]{64}", item)
                    for item in value
                )
            )
        elif key != "withdraw_delay_seconds":
            check(type(value) is str and 0 < len(value) <= 256)
    if profile == "base-mpp-charge-v1":
        base_charge.address(limits["recipient"])
    elif profile == "base-x402-batch-v1":
        check(
            type(limits["withdraw_delay_seconds"]) is int
            and limits["withdraw_delay_seconds"] == 900
            and limits["receiver_authorizer"] == base.AUTHORIZER
        )
        check(
            re.fullmatch(r"0x[0-9a-fA-F]{40}", limits["recipient"])
            and int(limits["recipient"][2:], 16) > 0
        )
        check(
            base.uint(limits["max_call_amount_atomic"])
            <= base.uint(limits["max_cumulative_amount_atomic"])
            <= base.uint(limits["max_capital_atomic"])
        )
    elif profile == "solana-mpp-session-v1":
        check(limits["program_id"] == solana.PROGRAM)
        for key in ("recipient", "operator", "program_id"):
            solana.address(limits[key])
    else:
        algorand._address(limits["recipient"])
        algorand._address(limits["fee_payer"])
        check(
            limits["recipient"] != limits["fee_payer"]
            and (
                profile == "algorand-atomic-two-item-v1"
                or base.uint(limits["max_total_amount_atomic"]) >= 2000
            )
            and base.uint(limits["max_sponsor_fee_micro_algo"]) >= 15000
        )


def parse_request(body, *, enabled=False):
    rb.canonical(body)
    check(
        type(body) is dict
        and set(body)
        <= {
            "url",
            "merchant_profile",
            "buyer_limits",
            "require_route_binding",
            "lab_test",
        }
    )
    check(
        {"url", "buyer_limits", "require_route_binding"} <= set(body)
        and body["require_route_binding"] is True
        and type(body["buyer_limits"]) is dict
    )
    ctx = rb.request_context(body["url"], "GET")
    limits = body["buyer_limits"]
    codec, inferred = batch_codec.limits_match(limits)
    requested = body.get("merchant_profile")
    if requested is None:
        if inferred is not None:
            _admit_named(inferred, limits)
        else:
            admitted = False
            for name in ("algorand-atomic-two-item-v1", algorand_manifest.ATOMIC):
                try:
                    _admit_named(name, limits)
                    admitted = True
                    break
                except rb.BindingError:
                    continue
            check(admitted)
    else:
        if enabled:
            check("lab_test" in body)
        check(requested in PROFILES)
        check(batch_codec.PROFILE_CODEC[requested] == codec)
        if inferred is not None:
            check(inferred == requested)
        _admit_named(requested, limits)
    if enabled:
        check(batch_codec.codec_enabled(codec))
    return ctx


def resolve_profile(body, challenge):
    """Detect the internal wire profile. Buyer merchant_profile is optional."""
    detected_codec, detected_profile = batch_codec.detect(challenge)
    limits_codec, limits_profile = batch_codec.limits_match(body["buyer_limits"])
    check(limits_codec == detected_codec)
    if limits_profile is not None:
        check(limits_profile == detected_profile)
    requested = body.get("merchant_profile")
    if requested is not None:
        check(requested == detected_profile)
        check(batch_codec.PROFILE_CODEC[requested] == detected_codec)
    return detected_profile


def _result_identity_ok(body, result):
    codec, _inferred = batch_codec.limits_match(body["buyer_limits"])
    if "merchant_profile" in body:
        check(result.get("merchant_profile") == body["merchant_profile"])
    if (
        "merchant_profile" not in body
        or result.get("job") is not None
        or result.get("codec") is not None
    ):
        check(result.get("job") == batch_codec.JOB and result.get("codec") == codec)
        if "label" in result:
            check(result["label"] == batch_codec.LABEL)


def wire(challenge, context, profile, *, expected_realm=None, validator=None):
    rb.canonical(challenge)
    check(
        type(challenge) is dict
        and set(challenge)
        == {"status", "bodyText", "paymentRequired", "wwwAuthenticate"}
    )
    check(type(challenge["status"]) is int and challenge["status"] == 402)
    check(
        type(challenge["bodyText"]) is str
        and len(challenge["bodyText"].encode()) <= 16384
    )
    for k in ("paymentRequired", "wwwAuthenticate"):
        check(
            challenge[k] is None
            or type(challenge[k]) is str
            and 0 < len(challenge[k]) <= 16384
            and all(32 <= ord(c) < 127 for c in challenge[k])
        )
    check(len(rb.canonical(challenge)) <= RAW_LIMIT)
    if profile == "algorand-mpp-charge-v1":
        return native_charge.wire(challenge, context, "algorand", expected_realm, validator)
    if profile == "base-mpp-charge-v1":
        return native_charge.wire(challenge, context, "evm", expected_realm, validator)
    if profile == "solana-mpp-session-v1":
        check(challenge["bodyText"] == "" and challenge["paymentRequired"] is None)
        raw = challenge["wwwAuthenticate"]
        check(type(raw) is str and raw.startswith("Payment "))
        params = {}
        for item in raw[8:].split(", "):
            m = re.fullmatch(r'([A-Za-z]+)="([^"\\]*)"', item)
            check(m is not None and m[1] not in params)
            params[m[1]] = m[2]
        check(set(params) == {"id", "realm", "method", "intent", "request", "expires"})
        check(
            0 < len(params["id"]) <= 256
            and params["realm"] == urlsplit(context["url"]).hostname
            and params["method"] == "solana"
            and params["intent"] == "session"
        )
        token = params["request"]
        check(re.fullmatch(r"[A-Za-z0-9_-]+", token))
        rawbody = base64.urlsafe_b64decode(token + "=" * ((-len(token)) % 4))
        check(base64.urlsafe_b64encode(rawbody).decode().rstrip("=") == token)
        check(
            re.fullmatch(
                r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z", params["expires"]
            )
        )
        expiry = int(
            datetime.datetime.fromisoformat(
                params["expires"].replace("Z", "+00:00")
            ).timestamp()
        )
        return rb.strict_json(rawbody), expiry
    check(challenge["wwwAuthenticate"] is None)
    items = []
    if challenge["bodyText"]:
        items.append(rb.strict_json(challenge["bodyText"]))
    if challenge["paymentRequired"] is not None:
        text = challenge["paymentRequired"]
        decoded = base64.b64decode(text, validate=True)
        check(base64.b64encode(decoded).decode() == text)
        items.append(rb.strict_json(decoded))
    check(bool(items) and all(rb.canonical(v) == rb.canonical(items[0]) for v in items))
    return items[0], None


def build(body, observation):
    ctx = parse_request(body)
    check(
        type(observation) is dict
        and set(observation) == {"request", "observed_at", "challenge"}
        and observation["request"] == ctx
    )
    observed = observation["observed_at"]
    check(type(observed) is int and observed > 0)
    profile = resolve_profile(body, observation["challenge"])
    env, native_expiry = wire(observation["challenge"], ctx, profile, expected_realm=body["buyer_limits"].get("realm"), validator=lambda offer: PROFILES[profile](offer, ctx, body["buyer_limits"]))
    terms = PROFILES[profile](env, ctx, body["buyer_limits"])
    if profile in algorand_manifest.PROFILES:
        quote = terms["feeQuote"]
        check(quote["observedAt"] <= observed < quote["expiresAt"])
        native_expiry = quote["expiresAt"]
    expires = min(observed + 60, native_expiry or observed + 60)
    check(expires > observed)
    result = {
        "model": MODEL,
        "profile": profile,
        "request": ctx,
        "buyer_limits": body["buyer_limits"],
        "challenge": observation["challenge"],
        "challenge_sha256": rb.digest(observation["challenge"]),
        "terms": terms,
        "observed_at": observed,
        "expires_at": expires,
    }
    rb.canonical(result)
    return result


def validate(value, body, *, now=None):
    check(
        type(value) is dict
        and set(value)
        == {
            "model",
            "profile",
            "request",
            "buyer_limits",
            "challenge",
            "challenge_sha256",
            "terms",
            "observed_at",
            "expires_at",
        }
    )
    rebuilt = build(
        body,
        {
            "request": value["request"],
            "observed_at": value["observed_at"],
            "challenge": value["challenge"],
        },
    )
    check(rb.canonical(value) == rb.canonical(rebuilt))
    if now is not None:
        check(type(now) is int and value["observed_at"] <= now < value["expires_at"])
    return rebuilt


def billable(body, code, result):
    try:
        parse_request(body, enabled=True)
        check(
            type(code) is int
            and code == 200
            and type(result) is dict
            and result.get("live") is True
            and result.get("payable") is True
            and type(result.get("status")) is int
            and result.get("status") == 402
            and result.get("url") == body["url"]
            and result.get("selected_payment") is None
        )
        _result_identity_ok(body, result)
        built = build(body, result["_batch_observation"])
        validate(built, body, now=int(time.time()))
        check(rb.canonical(result.get("batch_terms")) == rb.canonical(built["terms"]))
        return True
    except (ValueError, KeyError, TypeError, OverflowError):
        return False


def verify_route(result, body, *, vkey, challenge, now=None):
    """Offline receipt and original raw observation check; grants no payment authority."""
    from live402.pq import receipt

    try:
        check(isinstance(vkey, str) and bool(vkey.strip()))
        tr = result["pq_trust"]["transparency"]
        receipt.verify_route_receipt(tr["receipt"], tr["reveal"], vkey)
        evidence = tr["reveal"]["evidence"]
        check(evidence["evidence_version"] == 3)
        check(
            rb.canonical(rb.strict_json(evidence["request_json"])) == rb.canonical(body)
        )
        value = validate(
            evidence["batch_binding"],
            body,
            now=int(time.time()) if now is None else now,
        )
        check(
            rb.canonical(value) == rb.canonical(result["batch_binding"])
            and rb.canonical(challenge) == rb.canonical(value["challenge"])
        )
        check(
            result.get("live") is True
            and result.get("payable") is True
            and type(result.get("status")) is int
            and result.get("status") == 402
            and result.get("url") == body["url"]
            and result.get("selected_payment") is None
            and rb.canonical(result.get("batch_terms")) == rb.canonical(value["terms"])
        )
        _result_identity_ok(body, result)
        return value
    except (ValueError, KeyError, TypeError, OverflowError):
        raise rb.BindingError("invalid_batch_binding") from None
