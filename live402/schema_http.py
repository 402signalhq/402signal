"""Public HTTP request descriptions; never runtime payment acceptance.

Keep ordinary routing, the fixed-endpoint POST profile and Check group offer
closed and disjoint. Buyers send caps, not a merchant_profile enum. The MCP
advertisement deliberately retains its existing input contract. Schema validation
is not transaction or economic authorization: raw JSON ambiguity, UTF-8 byte
limits, address checksums, cross-field amounts, current offers and runtime codec
enablement still have authoritative parsers.
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
    evm = {"type": "string", "pattern": "^0x[0-9a-fA-F]{40}$",
           "not": {"const": "0x" + "0" * 40}}
    sol = {"type": "string", "minLength": 32, "maxLength": 44,
           "pattern": "^[1-9A-HJ-NP-Za-km-z]+$"}
    alg = {"type": "string", "pattern": "^[A-Z2-7]{58}$"}
    sponsor = deepcopy(amount)
    # Numeric minimum does not apply to decimal strings. Exclude canonical
    # positive values below the existing profile's 15,000 microALGO floor.
    sponsor["not"] = {"pattern": r"^(?:[1-9][0-9]{0,3}|1[0-4][0-9]{3})$"}
    sponsor["description"] = (
        "Canonical decimal sponsor fee ceiling, 15000 through uint64 maximum. "
        "This buyer limit is not an actual fee quote or sponsorship promise."
    )
    def constant(value):
        return {"type": "string", "const": value}
    result = {
        "algorand-mpp-charge-v1": _closed({
            "network": constant(algo.NETWORK), "asset": constant(algo.ASSET),
            "recipient": {**deepcopy(alg), "not":{"const":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ"}},
            "fee_payer": {"anyOf":[{"type":"null"},{**deepcopy(alg),"not":{"const":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ"}}],"description":"Null explicitly selects buyer-paid fees; an address pins the merchant-offered sponsor. This never authorizes 402Signal sponsorship."},
            "max_amount_atomic": deepcopy(amount), "max_network_fee_micro_algo": deepcopy(amount),
            "realm":{"type":"string","minLength":1,"maxLength":256,"pattern":r"^[\x20-\x7e]*[\x21-\x7e][\x20-\x7e]*$"},
        }),
        "base-mpp-charge-v1": _closed({
            "network": constant(base.NETWORK), "asset": constant(base.ASSET),
            "recipient": deepcopy(evm), "max_call_amount_atomic": deepcopy(amount),
            "realm": {"type":"string", "minLength":1, "maxLength":256, "pattern":r"^[\x20-\x7e]*[\x21-\x7e][\x20-\x7e]*$"},
        }),
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
            "max_sponsor_fee_micro_algo": deepcopy(sponsor),
            "job_hashes": {"type": "array", "minItems": 2, "maxItems": 2,
                           "items": {"type": "string", "pattern": "^[0-9a-f]{64}$"}},
        }),
    }

    # New profiles preserve the old two-item floor and use a fee-quote-bound
    # caller ceiling instead. Aggregate invoices have no inferred item price.
    multi = deepcopy(result["algorand-atomic-two-item-v1"])
    multi["properties"]["job_hashes"]["maxItems"] = 15
    multi["properties"]["max_sponsor_fee_micro_algo"] = deepcopy(amount)
    multi["description"] = "2–15 ordered item payments plus sponsor. The observed current fee quote must fit the caller ceiling."
    invoice = deepcopy(multi)
    invoice["properties"]["job_hashes"]["maxItems"] = 64
    del invoice["properties"]["max_item_amount_atomic"]
    invoice["required"].remove("max_item_amount_atomic")
    invoice["description"] = "Explicit merchant aggregate invoice: 2–64 jobs, one payment plus sponsor. Per-job price is unknown; item price caps are unsupported. 64 is the initial manifest budget, not a chain transaction limit."
    result["algorand-atomic-multi-item-v1"] = multi
    result["algorand-aggregate-invoice-v1"] = invoice
    return result


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
    endpoint = {"type": "string", "format": "uri", "minLength": 9, "maxLength": 4096,
                "pattern": r"^https://[^\s/?@#\\]+(?:/[^\s?#\\]*)?(?:\?[^\s#\\]*)?$",
                "description": "Exact HTTPS GET URL. Preserve query ordering and encoding. Runtime SSRF and request-context checks remain authoritative."}
    check_group = _closed({
        "url": deepcopy(endpoint),
        "buyer_limits": {"anyOf": [deepcopy(v) for v in limits.values()]},
        "require_route_binding": {"type": "boolean", "const": True},
    })
    check_group["title"] = "Check group offer"
    check_group["description"] = (
        "HTTP-only Check group offer (job chk_grp). Send url, buyer_limits caps and "
        "require_route_binding. The server auto-selects a codec from the live seller "
        "challenge. Buyers do not pass merchant_profile. Unknown or ambiguous wires "
        "fail closed. Requires explicit runtime codec enablement."
    )
    result["properties"].update({
        "probe_request": deepcopy(post),
        "buyer_limits": {"anyOf": [deepcopy(v) for v in limits.values()]},
    })
    result["oneOf"] = [exact, search, check_group]
    result["description"] = "Choose one closed HTTP request. Required evidence, payment, supported-method, byte, identity, economic and enabled-codec checks still apply on the server. The advertised MCP schema is separate."
    return result
