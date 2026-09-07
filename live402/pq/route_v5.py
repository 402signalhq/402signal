"""Version 5 batch/session observation. Public leaf is commitment-only."""

from __future__ import annotations

import hashlib
import secrets

from live402 import route_binding as binding
from live402.pq import events, jcs

TYPE = "402signal.route_decision.v5"
DOMAIN = b"402signal.route_decision.v5\0"


def evidence_from_route(result, request):
    evidence = {
        "evidence_version": 3,
        "request_json": binding.canonical(request).decode(),
        "batch_binding": result["batch_binding"],
    }
    validate(evidence)
    return evidence


def validate(evidence):
    from live402 import batch_binding

    binding.canonical(evidence)
    if (
        type(evidence) is not dict
        or set(evidence) != {"evidence_version", "request_json", "batch_binding"}
        or type(evidence["evidence_version"]) is not int
        or evidence["evidence_version"] != 3
    ):
        raise binding.BindingError("invalid_evidence")
    if type(evidence["request_json"]) is not str:
        raise binding.BindingError("invalid_evidence")
    batch_binding.validate(
        evidence["batch_binding"], binding.strict_json(evidence["request_json"])
    )


def commitment(evidence, salt):
    validate(evidence)
    if type(salt) is not bytes or len(salt) != 32:
        raise binding.BindingError("invalid_salt")
    return hashlib.sha256(DOMAIN + binding.canonical(evidence) + salt).hexdigest()


def event(evidence, *, ts=None, salt=None, nonce=None):
    salt = secrets.token_bytes(32) if salt is None else salt
    public = {
        "type": TYPE,
        "ts": jcs.utc_minutes_z(ts),
        "nonce": secrets.token_hex(32) if nonce is None else nonce,
        "commitment": commitment(evidence, salt),
    }
    return events.assert_public(public), {
        **public,
        "event_version": TYPE,
        "evidence": evidence,
        "salt": salt.hex(),
    }


def verify_reveal(expected, reveal):
    try:
        if type(reveal) is not dict or set(reveal) != {
            "type",
            "ts",
            "nonce",
            "commitment",
            "event_version",
            "evidence",
            "salt",
        }:
            return False
        if (
            reveal["event_version"] != TYPE
            or reveal["type"] != TYPE
            or reveal["commitment"] != expected
        ):
            return False
        if type(reveal["salt"]) is not str or not binding.HEX.fullmatch(reveal["salt"]):
            return False
        return commitment(reveal["evidence"], bytes.fromhex(reveal["salt"])) == expected
    except (ValueError, TypeError, KeyError):
        return False
