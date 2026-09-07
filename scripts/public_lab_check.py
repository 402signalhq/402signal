"""Bounded unpaid lab challenge checks. No route, payment, signer or Fly access.

Only the fixed public operator lab URLs are requested. The existing DNS pinning,
SSRF and redirect protections are reused. Output contains verdicts, not responses.
"""
from __future__ import annotations

import json
import time
from datetime import datetime, timezone

from live402 import payment, probe, route_binding as binding

ORIGIN = "https://402signal-lab-ross.fly.dev"
RAILS = ("base", "solana", "algorand")
SAFE_REASONS = frozenset({
    "ssrf", "probe_timeout", "no_402_envelope", "unsupported_challenge",
    "unsupported_extension", "unsupported_resource", "invalid_json",
    "unsupported_json_value", "ambiguous_challenge", "redirected_quote",
    "ambiguous_selected_payment", "unproven_observation", "quote_changed",
    "unsupported_payment_terms", "unavailable",
})


def check(rail):
    if rail not in RAILS:
        raise ValueError("unsupported lab rail")
    url = ORIGIN + "/" + rail + "/payload/sha256"
    report = {"rail":rail, "http_status":None, "challenge_compatible":False,
              "reason":"unavailable"}
    try:
        pinned = probe._pin_https_target(url)
        if not pinned:
            report["reason"] = "ssrf"
            return report
        safe, addrs = pinned
        snap = probe._one_request(safe, "GET", deadline=time.monotonic()+8,
                                  pinned_addrs=addrs)
        status = snap.get("status")
        if type(status) is int and 100 <= status <= 599:
            report["http_status"] = status
        if snap.get("binding_error_reason"):
            report["reason"] = snap["binding_error_reason"]
            return report
        if status != 402 or snap.get("live") is not True:
            report["reason"] = snap.get("miss_reason") or "no_402_envelope"
            return report
        env, observed = snap.get("envelope"), snap.get("binding_observation")
        binding.validate_envelope(env)
        if not isinstance(observed, dict) or observed.get("request") != binding.request_context(url,"GET"):
            report["reason"] = "unproven_observation"
            return report
        if observed.get("quote_sha256") != binding.digest(env):
            report["reason"] = "quote_changed"
            return report
        options = payment.payment_options_from_result({"envelope":env})
        matching = [opt for opt in options if opt.get("rail") == rail]
        if not matching:
            report["reason"] = "unsupported_payment_terms"
            return report
        binding.selected_index(env,payment.selected_payment_fields(matching[0]))
        report.update(challenge_compatible=True,reason=None)
    except binding.BindingError as exc:
        report["reason"] = str(exc)
    except Exception:
        report["reason"] = "unavailable"
    finally:
        if report["reason"] is not None and (
                type(report["reason"]) is not str or report["reason"] not in SAFE_REASONS):
            report["reason"] = "unavailable"
    return report


def main():
    results = [check(rail) for rail in RAILS]
    print(json.dumps({
        "checked_at":datetime.now(timezone.utc).isoformat(),
        "mode":"unpaid_public_challenge_only",
        "results":results,
        "deployment_authorized":False,
        "mainnet_payment_authorized":False,
    },sort_keys=True))
    return 0 if all(r["challenge_compatible"] for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
