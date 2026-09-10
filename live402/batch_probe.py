"""One admitted, DNS-pinned, redirect-free unpaid GET. No history write."""

import time
from live402 import admission, batch_binding as bb, batch_codec, probe


def run(body, deadline):
    ctx = bb.parse_request(body, enabled=True)
    url = ctx["url"]
    codec, _inferred = batch_codec.limits_match(body["buyer_limits"])
    result = {
        "url": url,
        **batch_codec.identity(codec),
        "live": False,
        "payable": False,
        "invocable": False,
        "selected_payment": None,
        "status": None,
        "miss_reason": "no_402_envelope",
        "evaluation_complete": True,
    }
    if "merchant_profile" in body:
        result["merchant_profile"] = body["merchant_profile"]
    try:
        lease = admission.reserve_probe(url)
    except Exception:
        result.update(miss_reason="probe_capacity", retryable=True)
        return 503, result
    host = probe._probe_host(url)
    acquired = False
    try:
        acquired = probe.acquire_probe_slot(host, deadline)
        if not acquired:
            result["miss_reason"] = "probe_budget_exhausted"
            return 503, result
        pinned = probe._pin_https_target(url)
        if not pinned or pinned[0] != url:
            result["miss_reason"] = "ssrf"
            return 503, result
        snap = probe._one_request(
            url,
            "GET",
            deadline=deadline,
            pinned_addrs=pinned[1],
            allow_redirects=False,
            capture_batch=True,
        )
        result["status"] = snap.get("status")
        observation = snap.get("_batch_observation")
        if observation is None:
            result["miss_reason"] = snap.get("miss_reason") or "no_402_envelope"
            return 503, result
        try:
            binding = bb.build(body, observation)
            bb.validate(binding, body, now=int(time.time()))
        except (ValueError, TypeError, KeyError, OverflowError):
            result["miss_reason"] = "constraints_unmet"
            return 503, result
        result.update(
            live=True,
            payable=True,
            miss_reason=None,
            batch_terms=binding["terms"],
            _batch_observation=observation,
            compared=[
                {
                    "url": url,
                    **batch_codec.identity(codec),
                    "live": True,
                    "invocable": False,
                    "selected": True,
                    "selectable": True,
                    "excluded_reason": None,
                }
            ],
        )
        return 200, result
    finally:
        if acquired:
            probe.release_probe_slot(host)
        if lease is not None:
            lease.engine.probe_complete(lease, result.get("live") is True)
