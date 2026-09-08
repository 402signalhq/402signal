"""Public HTTP request descriptions; never runtime payment acceptance.

Keep ordinary routing, the fixed-endpoint POST profile and public batch profiles
closed and disjoint. The MCP advertisement deliberately retains its existing
input contract. Schema validation is not transaction or economic authorization:
raw JSON ambiguity, UTF-8 byte limits, address checksums, cross-field amounts,
current offers and runtime profile enablement still have authoritative parsers.
"""
from __future__ import annotations
from copy import deepcopy


def uint64_pattern() -> str:
    """Canonical positive decimal strings through 2**64-1, with no coercion."""
    maximum = str(2**64 - 1)
    choices = [r"[1-9][0-9]{0,18}"]
    for index, char in enumerate(maximum):
        lower, upper = (1 if index == 0 else 0), int(char) - 1
        if upper < lower:
            continue
        digit = str(lower) if upper == lower else f"[{lower}-{upper}]"
        suffix = f"[0-9]{{{len(maximum) - index - 1}}}"
        choices.append(maximum[:index] + digit + suffix)
    choices.append(maximum)
    return "^(?:" + "|".join(choices) + ")$"


def _closed(properties: dict, required=None) -> dict:
    return {
        "type": "object", "properties": properties,
        "required": list(properties) if required is None else list(required),
        "additionalProperties": False,
    }


def batch_limit_schemas() -> dict:
    from live402.batch_profiles import base, solana, algorand_generic as algo
    amount = {"type": "string", "pattern": uint64_pattern(), "maxLength": 20,
              "description": "Positive canonical atomic amount, at most uint64. Cross-field limits are checked by the runtime."}
    evm = {"type": "string", "pattern": "^0x[0-9a-fA-F]{40}$"}
    sol = {"type": "string", "minLength": 32, "maxLength": 44,
           "pattern": "^[1-9A-HJ-NP-Za-km-z]+$"}
    alg = {"type": "string", "pattern": "^[A-Z2-7]{58}$"}
    def constant(value):
        return {"type": "string", "const": value}
    return {
        "base-x402-batch-v1": _closed({
            "network": constant(base.NETWORK), "asset": constant(base.ASSET),
            "recipient": deepcopy(evm), "receiver_authorizer": constant(base.AUTHORIZER),
            "withdraw_delay_seconds": {"type": "integer", "const": 900},
            "max_call_amount_atomic": deepcopy(amount),
            "max_cumulative_amount_atomic": deepcopy(amount),
            "max_capital_atomic": deepcopy(amount),
        }),
        "solana-mpp-session-v1": _closed({
            "network": constant(solana.NETWORK), "asset": constant(solana.ASSET),
            "recipient": deepcopy(sol), "operator": deepcopy(sol),
            "program_id": constant(solana.PROGRAM),
            "max_session_cap_atomic": deepcopy(amount),
        }),
        "algorand-atomic-two-item-v1": _closed({
            "network": constant(algo.NETWORK), "asset": constant(algo.ASSET),
            "recipient": deepcopy(alg), "fee_payer": deepcopy(alg),
            "max_item_amount_atomic": deepcopy(amount),
            "max_total_amount_atomic": deepcopy(amount),
            "max_sponsor_fee_micro_algo": deepcopy(amount),
            "job_hashes": {"type": "array", "minItems": 2, "maxItems": 2,
                           "items": {"type": "string", "pattern": "^[0-9a-f]{64}$"}},
        }),
    }


def extend_http_route_schema(ordinary: dict) -> dict:
    """Add supported customer HTTP variants without expanding the MCP surface."""
    from live402 import probe_profile
    result = deepcopy(ordinary)
    exact = deepcopy(ordinary)
    exact["title"] = "Ordinary exact routing"
    search = deepcopy(ordinary)
    search["title"] = "Bounded Parallel search request"
    search["properties"].pop("need")
    search.pop("anyOf", None)
    search["required"] = ["url", "require_route_binding", "probe_request"]
    search["properties"]["url"] = {"type": "string", "const": probe_profile.URL}
    search["properties"]["require_route_binding"] = {"type": "boolean", "const": True}
    content = deepcopy(probe_profile.input_schema())
    content["properties"]["query"]["pattern"] = r"\S"
    post = _closed({
        "profile": {"type": "string", "const": probe_profile.PROFILE},
        "method": {"type": "string", "const": "POST"},
        "body": {"type": "string", "minLength": 1, "maxLength": probe_profile.MAX_BYTES,
                 "contentMediaType": "application/json", "contentSchema": content,
                 "description": "Exact JSON text, not a parsed object. The server enforces 4096 UTF-8 bytes, unique keys, a nonblank query of at most 300 characters and mode one-shot. Content schema annotations are not enforced by every validator."},
    })
    search["properties"]["probe_request"] = post
    limits = batch_limit_schemas()
    variants = [exact, search]
    endpoint = {"type": "string", "format": "uri", "minLength": 9, "maxLength": 4096,
                "pattern": r"^https://[^\s/@#\\]+(?:/[^\s#\\]*)?$",
                "description": "Exact HTTPS GET URL. Preserve query ordering and encoding. Runtime SSRF and request-context checks remain authoritative."}
    for profile, limit_schema in limits.items():
        branch = _closed({
            "url": deepcopy(endpoint),
            "merchant_profile": {"type": "string", "const": profile},
            "buyer_limits": deepcopy(limit_schema),
            "require_route_binding": {"type": "boolean", "const": True},
        })
        branch["title"] = profile
        branch["description"] = "HTTP-only observation, not funding or execution. Requires explicit runtime enablement. Internal owner-lab markers are outside this public client schema."
        variants.append(branch)
    result["properties"].update({
        "probe_request": deepcopy(post),
        "merchant_profile": {"type": "string", "enum": list(limits)},
        "buyer_limits": {"oneOf": [deepcopy(v) for v in limits.values()]},
    })
    result["oneOf"] = variants
    result["description"] = "Choose one closed HTTP request profile. Required evidence, payment, supported-method, byte, identity, economic and enabled-profile checks still apply on the server. The advertised MCP schema is separate."
    return result
