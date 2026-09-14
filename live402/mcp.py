"""Stdlib JSON-RPC MCP over HTTP with live checks and free catalog preflight."""

from __future__ import annotations

import json
from live402 import payment, pulse, replay, schema_fields, validate
from live402.route import handle_route

# Every description leads with the task, names the sibling tools and when to
# use them instead, states cost and side effects, then explains the parameter
# interactions the schema cannot (docs/mcp-tool-descriptions.md). Each claim
# traces to a handler: route.run_probe, policy.merge_constraints,
# select.parse_constraints, probe.probe_plan, pulse.preview_need and
# validate.validate_url.
CHECK_DESCRIPTION = (
    "Runs the paid pre-flight check on a live paid API endpoint: probes one exact HTTPS url, or "
    "the candidates discovered for a need, applies the buyer's price, network and readiness "
    "rules, and returns the selected offer with signed evidence of what the seller quoted "
    "(price, recipient, asset, network, expiry) before the agent pays the seller. Does not buy "
    "the seller's service, hold keys or pay anything for the agent; the agent keeps its wallet "
    "and pays the seller separately.\n\n"
    "Use preview to discover candidates without paying, validate for a free readiness check of "
    "one listed URL, and check when a fresh live observation or a signed receipt is needed "
    "before a seller payment. Never call check to pay a seller. After "
    "billing.settlement_state=unknown, stop and reconcile; never create another authorization. "
    "route is the former name of this tool and is still accepted.\n\n"
    "Cost and outcomes: the first unsigned call answers HTTP 402 with the $0.003 USDC "
    "checking-fee terms (Base, Solana or Algorand), which an x402-capable HTTP client pays. The "
    "fee settles only when a qualifying live offer is found; a completed miss (HTTP 200, "
    "live=false, typed miss_reason) is free; a settled fee is not reversed if the offer later "
    "changes. HTTP 503 with binding_error=route_binding_unavailable means the seller answered "
    "but no probed candidate could be bound to a signed receipt: a completed unpaid answer, not "
    "an outage (the reference wrapExactAuthorize reports state=binding_unavailable with "
    "keep_calling_route true).\n\n"
    "Parameter interactions: need or url is required; with both, url is probed directly and no "
    "discovery runs. policy is plain English compiled into the structured fields; an explicit "
    "structured field wins over the compiled value, and phrases that do not compile are echoed "
    "in unresolved_constraints, never guessed. networks is a hard allowlist judged on the "
    "current 402; prefer_network only orders results and never filters. Three independent "
    "price bounds: max_price_usd (seller price in USD), max_amount_atomic (atomic units of the "
    "seller's asset) and max_total_cost_usd (seller price plus known fees); every bound fails "
    "closed when its value is unknown. require_route_binding=true implies require_transparency "
    "and may select the next bindable candidate. Defaults: objective best, search_depth "
    "standard (up to 7 probes; thorough up to 15; hard ceiling 20), accept_payTo_change false, "
    "require_route_binding false. Guide: https://402signal.com/developers#route-binding"
)
# Tool names that carry the checking fee. Everything else is unpaid. route is
# the former name of check: not listed, still callable for existing clients.
PAID_TOOLS = frozenset({"route", "check"})
FORMER_TOOL_NAMES = {"route": "check"}
PROTOCOL_VERSION = "2025-06-18"
SUPPORTED_PROTOCOLS = ("2025-03-26", PROTOCOL_VERSION)

PREVIEW_DESCRIPTION = (
    "Discovers catalog-listed paid API endpoints by capability without paying or contacting "
    "sellers. Returns claimed listings and earlier observations; not_probed=true means no new "
    "live check. Results may be incomplete.\n\n"
    "Free and read-only: no fee, no seller contact, nothing recorded; safe to repeat. It "
    "queries the current upstream catalogs and the local shadow catalog. Use validate for a "
    "free readiness check of one listed URL, and check for a fresh paid observation or a signed "
    "receipt before paying.\n\n"
    "Pass a nonblank need (capability), not a URL; a URL in need finds nothing. networks is a "
    "hard allowlist and prefer_network only orders the results within it; an empty or "
    "unrecognized networks value restricts to nothing rather than widening to every network. "
    "Seller-written fields in hits are catalog claims, not observations."
)

INPUT_SCHEMA = schema_fields.route_body_schema(surface="mcp")

OUTPUT_SCHEMA = {
    "type": "object",
    "required": ["billing"],
    "properties": {
        "live": {"type": "boolean"},
        "url": {"type": ["string", "null"]},
        "challenge_observed": {"type": "boolean"},
        "payable": {"type": "boolean"},
        "invocable": {"type": "boolean"},
        "selected_payment": {
            "type": ["object", "null"],
            "properties": {
                "rail": {"type": ["string", "null"]},
                "network": {"type": ["string", "null"]},
                "asset": {"type": ["string", "null"]},
                "amount_atomic": {"type": ["integer", "null"]},
                "display_amount": {"type": ["string", "null"]},
                "normalized_usd": {"type": ["number", "null"]},
                "payTo": {"type": ["string", "null"]},
                "facilitator": {"type": ["string", "null"]},
            },
        },
        "billing": {
            "type": "object",
            "description": "402Signal checking-fee outcome. Seller payment is separate.",
            "properties": {
                "model": {"type": "string", "const": payment.ROUTING_BILLING_MODEL},
                "condition": {"type": "string", "const": payment.ROUTING_SETTLEMENT_CONDITION},
                "asset": {"type": "string", "const": "USDC"},
                "amount_atomic": {"type": "string", "enum": [payment.AMOUNT_ATOMIC, payment.SESSION_AMOUNT_ATOMIC]},
                "display_amount": {"type": "string", "enum": [payment.AMOUNT_USD, payment.SESSION_AMOUNT_USD]},
                "rail": {"type": "string", "enum": ["base", "solana", "algorand"]},
                "settlement_attempted": {"type": ["boolean", "null"]},
                "settled": {"type": ["boolean", "null"]},
                "settlement_state": {
                    "type": "string",
                    "enum": ["settled", "not_attempted", "rejected", "unknown"],
                    "description": "Inspect before retrying. unknown means do not reuse this authorization.",
                },
            },
            "required": [
                "model", "condition", "asset", "amount_atomic", "display_amount",
                "rail", "settlement_attempted", "settled", "settlement_state",
            ],
        },
        "changes": {
            "type": "object",
            "properties": {
                "payTo_changed_at": {"type": ["string", "integer", "null"]},
                "price_changed_at": {"type": ["string", "integer", "null"]},
                "schema_changed_at": {"type": ["string", "integer", "null"]},
            },
        },
        "target": {
            "type": ["object", "null"],
            "properties": {
                "method": {"type": "string"},
                "inputSchema": schema_fields.seller_schema_field(),
                "outputSchema": schema_fields.seller_schema_field(),
                "accepts": {"type": "array"},
                "facilitator": {"type": ["string", "null"]},
                "amountAtomic": {"type": ["string", "null"]},
                "displayAmount": {"type": ["string", "null"]},
                "timeoutSeconds": {"type": "integer"},
            },
        },
        "claimed": schema_fields.claimed_output_schema(),
        "observed": schema_fields.observed_output_schema(),
        "payTo": {"type": ["string", "null"], "description": "Recipient of the selected offer as observed in the live challenge."},
        **schema_fields.recipient_flag_properties(),
        "verified_at": {"type": ["string", "null"], "description": "When the observed live challenge was taken."},
        "readiness": {"type": "string", "enum": ["discovered", "payable", "invocable", "recently_verified"]},
        "miss_reason": schema_fields.miss_reason_schema(),
        "tried": {"type": "integer"},
        "discovery_matches": {"type": "integer"},
        "candidates_discovered": {"type": "integer"},
        "candidates_considered": {"type": "integer"},
        "candidates_probed": {"type": "integer"},
        "probe_ceiling": {"type": "integer"},
        "probe_budget_exhausted": {"type": "boolean"},
        "candidate_evaluation_complete": {"type": "boolean"},
        "evaluation_complete": {"type": "boolean"},
        "discovered_count": {"type": "integer"},
        "probed_count": {"type": "integer"},
        "unprobed_count": {"type": "integer"},
        "interpreted_constraints": {"type": "object"},
        "applied_constraints": {"type": "object"},
        "unmet_constraints": {"type": "array", "items": {"type": "string"}},
        "unresolved_constraints": {"type": "array"},
        "stop_reason": {
            "type": "string",
            "enum": list(schema_fields.STOP_REASONS),
        },
        "latency_ms": {"type": ["integer", "null"]},
        "schema_source": {"type": ["string", "null"], "enum": ["envelope", "catalog", "bazaar", None]},
        "reputation": schema_fields.reputation_output_schema(),
        "objective": {
            "type": "string",
            "enum": list(schema_fields.OBJECTIVES),
        },
        "decision_binding": schema_fields.decision_binding_schema(),
        "binding_error": {
            "type": "string",
            "enum": ["route_binding_unavailable"],
            "description": (
                "HTTP 503 when require_route_binding is true and no remaining "
                "already-probed selectable candidate could bind. Policy working, "
                "not a crash; wrapExactAuthorize reports state=binding_unavailable "
                "with keep_calling_route true."
            ),
        },
        "pq_trust": {
            "type": "object",
            "description": schema_fields.TRANSPARENCY_RETENTION_DESC,
            "properties": {
                "transparency": {
                    "type": "object",
                    "description": schema_fields.TRANSPARENCY_RETENTION_DESC,
                    "properties": {
                        "status": {"type": "string", "enum": list(schema_fields.TRANSPARENCY_STATUSES)},
                        "state": {"type": "string", "enum": list(schema_fields.TRANSPARENCY_STATES)},
                        "log_origin": {"type": "string"},
                        "leaf_type": {"type": "string"},
                        "index": {"type": "integer"},
                        "checkpoint_size": {"type": "integer"},
                        "receipt": {
                            "type": "object",
                            "description": "Retain with reveal for later verification.",
                        },
                        "reveal": {
                            "type": "object",
                            "description": (
                                "Customer-private evidence, not in the public log. Private "
                                "replay outcomes may retain it; keep securely with receipt."
                            ),
                        },
                    },
                }
            },
        },
        "compared": {
            "type": "array",
            "description": (
                "Slim probe rows. selectable, payTo_pending, payTo_changed, risk and "
                "excluded_reason show why a live row was not eligible. "
                "excluded_reason binding_unavailable marks a skipped binding failure."
            ),
        },
    },
}

PREVIEW_INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "need": {"type": "string", "description": "Nonblank capability to search for, such as weather or web search. Searches catalogs; does not probe a URL."},
        "prefer_network": {
            "type": "string",
            "enum": list(schema_fields.RAILS),
            "description": schema_fields.PREFER_NETWORK_DESC,
        },
        "networks": {
            "type": "array",
            "items": {"type": "string", "enum": list(schema_fields.RAILS)},
            "description": "Hard policy lock. Restricts searchable rails to this set. Unlike prefer_network, this is not a ranking preference.",
        },
    },
    "required": ["need"],
}

PREVIEW_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "need": {"type": "string"},
        "not_probed": {"type": "boolean"},
        "freshness": {"type": ["string", "null"]},
        "cached_s": {"type": ["number", "null"]},
        "discovery_matches": {"type": "integer"},
        "displayed": {"type": "integer"},
        "truncated": {"type": "boolean"},
        "total": {"type": ["integer", "null"]},
        "discovery_via": {"type": "object"},
        "discovery_exhaustive": {"type": "boolean"},
        "hits": {
            "type": "array",
            "description": schema_fields.SELLER_TEXT_CLIENT_WARNING,
            "items": schema_fields.preview_hit_schema(),
        },
        "miss_reason": schema_fields.miss_reason_schema(),
    },
}

VALIDATE_DESCRIPTION = (
    "Checks unpaid readiness for one concrete HTTPS seller URL already listed in the local "
    "catalog (for example a URL from preview). Compares claimed against observed payment and "
    "readiness flags without buying the service.\n\n"
    "Free: one unpaid probe of the seller, no fee, nothing paid, and the public numbers do not "
    "change; safe to repeat. Use preview to find listed URLs; use check instead when the URL "
    "is not listed, when price or network rules must apply, or when a signed receipt is "
    "needed before paying.\n\n"
    "Supply the exact listed URL including its query string. Unlisted or modified URLs return "
    "miss_reason=unlisted without a probe (not listed, not proven offline). Inspect live, "
    "readiness, observed and miss_reason; HTTP 200 alone is not success. No price or network "
    "filter and no signed receipt."
)

VALIDATE_INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "url": {"type": "string", "description": "Exact concrete HTTPS URL already listed in the local catalog, including its query string. Unlisted URLs are not probed."},
    },
    "required": ["url"],
}

VALIDATE_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "url": {"type": ["string", "null"]},
        "readiness": {"type": "string", "enum": ["discovered", "payable", "invocable", "recently_verified"]},
        "live": {"type": "boolean"},
        "payable": {"type": "boolean"},
        "invocable": {"type": "boolean"},
        "claimed": schema_fields.claimed_output_schema(),
        "observed": {"type": "object"},
        "flags": {"type": "array", "items": {"type": "string"}},
        "n_7d": {"type": "integer"},
        "miss_reason": schema_fields.miss_reason_schema(),
    },
}

# MCP tool annotations (protocol 2025-03-26 and later). Hints, stated as they
# are: check spends the checking fee and probes sellers; preview queries
# catalogs only; validate probes one seller without paying. None deletes or
# overwrites anything the caller owns.
CHECK_ANNOTATIONS = {
    "title": "Paid pre-flight check",
    "readOnlyHint": False,
    "destructiveHint": False,
    "idempotentHint": False,
    "openWorldHint": True,
}
PREVIEW_ANNOTATIONS = {
    "title": "Free catalog discovery",
    "readOnlyHint": True,
    "destructiveHint": False,
    "idempotentHint": True,
    "openWorldHint": True,
}
VALIDATE_ANNOTATIONS = {
    "title": "Free readiness check",
    "readOnlyHint": True,
    "destructiveHint": False,
    "idempotentHint": True,
    "openWorldHint": True,
}

# Listed surface: three distinct tools. The paid tool is check; its former
# name route is accepted by tools/call (PAID_TOOLS) but no longer listed.
TOOLS = [
    {
        "name": "check",
        "description": CHECK_DESCRIPTION,
        "inputSchema": INPUT_SCHEMA,
        "outputSchema": OUTPUT_SCHEMA,
        "annotations": CHECK_ANNOTATIONS,
    },
    {
        "name": "preview",
        "description": PREVIEW_DESCRIPTION,
        "inputSchema": PREVIEW_INPUT_SCHEMA,
        "outputSchema": PREVIEW_OUTPUT_SCHEMA,
        "annotations": PREVIEW_ANNOTATIONS,
    },
    {
        "name": "validate",
        "description": VALIDATE_DESCRIPTION,
        "inputSchema": VALIDATE_INPUT_SCHEMA,
        "outputSchema": VALIDATE_OUTPUT_SCHEMA,
        "annotations": VALIDATE_ANNOTATIONS,
    },
]


def manifest() -> dict:
    return {
        "name": "402Signal",
        "version": "0.5.0",
        "description": payment.CATALOG_DESCRIPTION,
        "tools": TOOLS,
    }


def jsonrpc_initialize(req_id, version=PROTOCOL_VERSION) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "result": {
            "protocolVersion": version if version in SUPPORTED_PROTOCOLS else PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "402Signal", "version": "0.5.0"},
        },
    }


def jsonrpc_tools_list(req_id) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}}


def jsonrpc_error(req_id, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


def is_paid_call(payload: dict) -> bool:
    if not isinstance(payload, dict):
        return False
    if payload.get("method") != "tools/call":
        return False
    params = payload.get("params") or {}
    return isinstance(params, dict) and params.get("name") in PAID_TOOLS


def is_preview_call(payload: dict) -> bool:
    if not isinstance(payload, dict):
        return False
    if payload.get("method") != "tools/call":
        return False
    params = payload.get("params") or {}
    return isinstance(params, dict) and params.get("name") == "preview"


def is_validate_call(payload: dict) -> bool:
    if not isinstance(payload, dict):
        return False
    if payload.get("method") != "tools/call":
        return False
    params = payload.get("params") or {}
    return isinstance(params, dict) and params.get("name") == "validate"


def uses_discovery_admission(payload: dict) -> bool:
    """Unpaid MCP surfaces: preview, handshake, ping, notifications, unknown methods."""
    return not is_paid_call(payload) and not is_validate_call(payload)


def _preview_result(args: dict) -> dict:
    need = ""
    if isinstance(args, dict) and isinstance(args.get("need"), str):
        need = args.get("need") or ""
    prefer = args.get("prefer_network") if isinstance(args, dict) else None
    networks = args.get("networks") if isinstance(args, dict) else None
    return pulse.preview_need(need, prefer_network=prefer, networks=networks)


def _tool_result(req_id, body: dict, code: int, version: str) -> dict:
    result = {"content": [{"type": "text", "text": json.dumps(body, separators=(",", ":"))}],
              "isError": code >= 400}
    if version == PROTOCOL_VERSION:
        result["structuredContent"] = body
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def handle_mcp(payload: dict, headers, resource_url: str) -> tuple[int, dict | None, dict | None]:
    """Stateless Streamable HTTP JSON responses; x402 remains an HTTP extension."""
    if replay.recovery_requested(headers):
        return 400, jsonrpc_error(None, -32600, "recovery_unsupported"), {"Cache-Control": "no-store"}
    version = next((v for k, v in headers.items() if str(k).lower() == "mcp-protocol-version"), "2025-03-26")
    if version not in SUPPORTED_PROTOCOLS:
        return 400, jsonrpc_error(None, -32600, "Unsupported protocol version"), None
    if not isinstance(payload, dict) or payload.get("jsonrpc") != "2.0":
        return 400, jsonrpc_error(None, -32600, "Invalid Request"), None
    req_id = payload.get("id")
    if "id" in payload and type(req_id) not in (int, str):
        return 400, jsonrpc_error(None, -32600, "Invalid request id"), None
    method = payload.get("method")
    if not isinstance(method, str):
        return 400, jsonrpc_error(req_id, -32600, "Invalid Request"), None
    # Notifications never execute tools and never receive JSON-RPC responses.
    if "id" not in payload:
        return 202, None, None
    params = payload.get("params", {})
    if not isinstance(params, dict):
        return 200, jsonrpc_error(req_id, -32602, "Invalid params"), None
    if method == "initialize":
        return 200, jsonrpc_initialize(req_id, params.get("protocolVersion")), None
    if method == "ping":
        return 200, {"jsonrpc": "2.0", "id": req_id, "result": {}}, None
    if method == "tools/list":
        result = jsonrpc_tools_list(req_id)
        if version != PROTOCOL_VERSION:
            result["result"]["tools"] = [{k: v for k, v in tool.items() if k != "outputSchema"} for tool in TOOLS]
        return 200, result, None
    if method == "tools/call":
        name, args = params.get("name"), params.get("arguments", {})
        if not isinstance(args, dict):
            return 200, jsonrpc_error(req_id, -32602, "arguments must be an object"), None
        if name == "preview":
            return 200, _tool_result(req_id, _preview_result(args), 200, version), None
        if name == "validate":
            url = args.get("url")
            code, body = validate.validate_url(url if isinstance(url, str) else "")
            return 200, _tool_result(req_id, body, code, version), None
        if name not in PAID_TOOLS:
            return 200, jsonrpc_error(req_id, -32602, "Unknown tool"), None
        code, body, extra = handle_route(args, headers, resource_url, bazaar=payment.BAZAAR_MCP)
        if code == 402:
            return code, body, extra
        return 200, _tool_result(req_id, body, code, version), extra
    return 200, jsonrpc_error(req_id, -32601, "Method not found"), None
