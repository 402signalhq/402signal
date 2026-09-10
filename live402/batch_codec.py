"""Check group offer (chk_grp): detect a codec from the live challenge wire.

Profile names stay internal. Buyers send caps, not merchant_profile.
"""

from __future__ import annotations

import os

from live402 import route_binding as rb
from live402.batch_profiles import (
    algorand,
    algorand_charge,
    algorand_generic,
    algorand_manifest,
    base,
    base_charge,
    solana,
)
from live402.batch_profiles import native_charge

JOB = "chk_grp"
LABEL = "Check group offer"
CODECS = ("exact", "sess", "mpp", "atom", "inv")
PROFILE_CODEC = {
    "base-x402-batch-v1": "exact",
    "solana-mpp-session-v1": "sess",
    "base-mpp-charge-v1": "mpp",
    "algorand-mpp-charge-v1": "mpp",
    "algorand-atomic-batch-v1": "atom",
    "algorand-atomic-two-item-v1": "atom",
    "algorand-atomic-multi-item-v1": "atom",
    algorand_manifest.ATOMIC: "atom",
    algorand_manifest.INVOICE: "inv",
}


def check(ok):
    if not ok:
        raise rb.BindingError("invalid_batch_binding")


def allowlist():
    tokens = [t for t in os.environ.get("BATCH_OBSERVATION_PROFILES", "").split(",") if t]
    out = set()
    for token in tokens:
        if token in CODECS:
            out.add(token)
        elif token in PROFILE_CODEC:
            out.add(PROFILE_CODEC[token])
    return out


def codec_enabled(codec):
    return codec in allowlist()


def identity(codec):
    check(codec in CODECS)
    return {"job": JOB, "codec": codec, "label": LABEL}


def _try_json(raw):
    try:
        return rb.strict_json(raw)
    except (ValueError, TypeError, KeyError):
        return None


def _envelope(challenge):
    """Return one agreed JSON envelope, or None when the body path is unusable.

    Disagreement is not a Payment-header failure. Native multi-offer challenges
    may carry a non-group JSON body plus a Payment challenge.
    """
    items = []
    if challenge.get("bodyText"):
        parsed = _try_json(challenge["bodyText"])
        if parsed is not None:
            items.append(parsed)
    raw = challenge.get("paymentRequired")
    if raw is not None:
        try:
            import base64

            decoded = base64.b64decode(raw, validate=True)
            if base64.b64encode(decoded).decode() != raw:
                return None
            items.append(rb.strict_json(decoded))
        except (ValueError, TypeError, KeyError):
            return None
    if not items:
        return None
    if not all(rb.canonical(v) == rb.canonical(items[0]) for v in items):
        return None
    return items[0]


def _payment_hits(challenge):
    raw = challenge.get("wwwAuthenticate")
    if not isinstance(raw, str) or not raw.startswith("Payment "):
        return []
    try:
        items = native_charge.challenges(raw)
    except (ValueError, TypeError, KeyError, rb.BindingError):
        return []
    known = []
    for item in items:
        intent = item["params"]["intent"]
        method = item["params"]["method"]
        if intent == "session" and method == "solana":
            known.append(("sess", "solana-mpp-session-v1"))
        elif intent == "charge" and method == "evm":
            known.append(("mpp", "base-mpp-charge-v1"))
        elif intent == "charge" and method == "algorand":
            known.append(("mpp", "algorand-mpp-charge-v1"))
    return list({item: None for item in known})


def _body_hits(env):
    if type(env) is not dict:
        return []
    ext = env.get("extensions")
    manifest = ext.get(algorand.EXTENSION) if type(ext) is dict else None
    if type(manifest) is dict:
        if manifest.get("version") == 2 and manifest.get("profile") == algorand_manifest.INVOICE:
            return [("inv", algorand_manifest.INVOICE)]
        if manifest.get("version") == 2 and manifest.get("profile") == algorand_manifest.ATOMIC:
            return [("atom", algorand_manifest.ATOMIC)]
        if manifest.get("version") == 1:
            if "itemCount" in manifest and "jobHashes" not in manifest:
                return []
            if manifest.get("itemCount") == 2 and "jobHashes" in manifest:
                resource = (env.get("resource") or {}).get("url") if type(env.get("resource")) is dict else None
                if type(resource) is str and "/algorand/batch/sha256?" in resource:
                    return [("atom", "algorand-atomic-batch-v1")]
                return [("atom", "algorand-atomic-two-item-v1")]
        return []
    accepts = env.get("accepts")
    if type(accepts) is list and len(accepts) == 1 and type(accepts[0]) is dict:
        if accepts[0].get("scheme") == "batch-settlement":
            return [("exact", "base-x402-batch-v1")]
    return []


def detect(challenge):
    """Return (codec, internal profile). Unknown or ambiguous wire refuses."""
    check(
        type(challenge) is dict
        and set(challenge) == {"status", "bodyText", "paymentRequired", "wwwAuthenticate"}
        and challenge["status"] == 402
    )
    hits = _payment_hits(challenge)
    env = _envelope(challenge)
    if env is not None:
        hits.extend(_body_hits(env))
    unique = list({item: None for item in hits})
    check(len(unique) == 1)
    codec, profile = unique[0]
    check(PROFILE_CODEC.get(profile) == codec)
    return codec, profile


def limits_match(limits):
    """Map buyer_limits keys to one codec. Overlapping atom key sets stay atom."""
    check(type(limits) is dict)
    keys = frozenset(limits)
    mapping = (
        (frozenset(base.KEYS), "exact", "base-x402-batch-v1"),
        (frozenset(solana.KEYS), "sess", "solana-mpp-session-v1"),
        (frozenset(base_charge.KEYS), "mpp", "base-mpp-charge-v1"),
        (frozenset(algorand_charge.KEYS), "mpp", "algorand-mpp-charge-v1"),
        (frozenset(algorand.LIMIT_KEYS), "atom", "algorand-atomic-batch-v1"),
        (frozenset(algorand_generic.KEYS), "atom", None),
        (frozenset(algorand_manifest.COMMON_KEYS), "inv", algorand_manifest.INVOICE),
    )
    hits = [item for item in mapping if item[0] == keys]
    check(len(hits) == 1)
    return hits[0][1], hits[0][2]
