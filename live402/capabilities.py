"""Public capability record: packages stay reviewed docs; hosted codecs are runtime."""

from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path

from live402 import batch_codec

STATIC = Path(__file__).resolve().parent / "static" / "capabilities.json"
CHIP_MARK = "<!--CHECK_GROUP_CHIP-->"
HOSTED_MARK = "<!--CHECK_GROUP_HOSTED-->"
BUYER_FIELDS = ["url", "buyer_limits", "require_route_binding"]
HOSTED_ENV = "BATCH_OBSERVATION_PROFILES"
VERIFIER_PACKAGE = "route-guard-v0.7.2"
HISTORICAL_VERIFIER = "route-guard-v0.7.1"
OFF_NOTE = (
    "Hosted Check group offer is not enabled. This block documents the job shape; "
    "codecs lists only currently enabled tokens from BATCH_OBSERVATION_PROFILES. "
    "verifier_package names the in-tree Check group offer guard; it is not a "
    "published GitHub release until that tag exists."
)
ON_NOTE = (
    "codecs lists currently enabled hosted tokens from BATCH_OBSERVATION_PROFILES. "
    "Package publication is a separate fact. verifier_package names the in-tree "
    "Check group offer guard pending GitHub release."
)


def enabled_codecs():
    allowed = batch_codec.allowlist()
    return [codec for codec in batch_codec.CODECS if codec in allowed]


def hosted_enabled():
    return bool(enabled_codecs())


def check_group_offer():
    """Merge runtime allowlist fields onto preserved SDK metadata.

    Replacing the entire object would drop verifier_package / historical_verifier
    from the static record. Those fields must survive an empty allowlist.
    """
    codecs = enabled_codecs()
    hosted = bool(codecs)
    static = deepcopy(json.loads(STATIC.read_text(encoding="utf-8"))).get(
        "check_group_offer"
    ) or {}
    merged = dict(static)
    merged.update(
        {
            "job": batch_codec.JOB,
            "label": batch_codec.LABEL,
            "hosted": hosted,
            "hosted_status": "on" if hosted else "off",
            "codecs": codecs,
            "buyer_fields": list(BUYER_FIELDS),
            "hosted_enablement_env": HOSTED_ENV,
            "verifier_package": static.get("verifier_package") or VERIFIER_PACKAGE,
            "historical_verifier": static.get("historical_verifier")
            or HISTORICAL_VERIFIER,
            "note": ON_NOTE if hosted else OFF_NOTE,
        }
    )
    return merged


def record():
    data = deepcopy(json.loads(STATIC.read_text(encoding="utf-8")))
    data["check_group_offer"] = check_group_offer()
    return data


def public_json():
    return (json.dumps(record(), indent=2, ensure_ascii=True) + "\n").encode("utf-8")


def chip_label():
    if hosted_enabled():
        return "Check group offer"
    return "Check group offer · hosted off"


def hosted_status_html():
    codecs = enabled_codecs()
    if not codecs:
        return "Hosted Check group offer is not enabled."
    names = ", ".join("<code>%s</code>" % codec for codec in codecs)
    return "Currently enabled hosted codecs: %s." % names


def apply_developers_copy(html):
    if CHIP_MARK in html:
        html = html.replace(CHIP_MARK + "Check group offer", chip_label(), 1)
        html = html.replace(CHIP_MARK, "")
    if HOSTED_MARK in html:
        html = html.replace(HOSTED_MARK, hosted_status_html(), 1)
    return html
