"""Public capability record: packages stay reviewed docs; hosted codecs are runtime."""

from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path

from live402 import batch_codec

STATIC = Path(__file__).resolve().parent / "static" / "capabilities.json"
CHIP_MARK = "<!--CHECK_GROUP_CHIP-->"
HOSTED_MARK = "<!--CHECK_GROUP_HOSTED-->"
OFF_NOTE = (
    "Hosted Check group offer is not enabled. This block documents the job shape; "
    "codecs lists only currently enabled tokens from BATCH_OBSERVATION_PROFILES."
)
ON_NOTE = (
    "codecs lists currently enabled hosted tokens from BATCH_OBSERVATION_PROFILES. "
    "Package publication is a separate fact."
)


def enabled_codecs():
    allowed = batch_codec.allowlist()
    return [codec for codec in batch_codec.CODECS if codec in allowed]


def hosted_enabled():
    return bool(enabled_codecs())


def runtime_availability():
    codecs = enabled_codecs()
    hosted = bool(codecs)
    return {
        "hosted": hosted,
        "hosted_status": "on" if hosted else "off",
        "codecs": codecs,
        "note": ON_NOTE if hosted else OFF_NOTE,
    }


def _reviewed_record():
    return deepcopy(json.loads(STATIC.read_text(encoding="utf-8")))


def record():
    data = _reviewed_record()
    block = data.get("check_group_offer")
    if type(block) is not dict:
        block = {}
    block.update(runtime_availability())
    data["check_group_offer"] = block
    return data


def check_group_offer():
    return record()["check_group_offer"]


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
