"""Stdlib JSON-RPC MCP over HTTP with live routing and free catalog preflight."""

from __future__ import annotations

import json
from live402 import payment, pulse, replay, schema_fields, validate
from live402.route import handle_route

ROUTE_DESCRIPTION = (
    "Use route when you need a live paid-API selection that satisfies spending and readiness "
    "rules. Use preview instead for free catalog discovery without probing, or validate for a "
    "free readiness check of one catalog-listed URL without constraint-based selection or signed "
    "routing evidence. Route does not buy the seller's service.\n\n"
    "Start with need (a capability such as weather), or url (one concrete HTTPS endpoint). If "
    "both are supplied, url selects the endpoint; need can still supply policy context. Add only "
    "the rules you require: networks is a hard allowlist, while prefer_network only ranks within "
    "it. Omit networks for all supported rails; [] permits none. objective defaults to best "
    "among eligible candidates actually probed. search_depth defaults to standard; "
    "max_candidates_to_probe sets a ceiling capped at 20, not a promise to probe that many. "
    "Direct URL requests check one endpoint.\n\n"
    "Price bounds concern the seller, not the separate routing fee: max_price_usd bounds its "
    "price; max_total_cost_usd also requires known fees. Required unknown price, latency or "
    "history measurements fail the constraint. max_probe_latency_ms takes precedence over its "
    "max_latency_ms alias; neither is service latency nor settlement latency. Structured "
    "constraints override constraints interpreted from policy (or need when policy is absent); "
    "inspect unresolved_constraints rather than assuming prose was enforced.\n\n"
    "For buyer-side comparison before merchant signing, set require_route_binding=true; it also "
    "requires transparency even if require_transparency=false. A later expired or changed seller "
    "offer does not reverse an already settled routing fee.\n\n"
    "The first unsigned call returns an HTTP 402 routing-fee challenge; completing it requires "
    "an x402-capable HTTP client, not a wallet key or payment argument. The credential-free "
    "Glama stdio adapter cannot complete paid route calls. The $0.003 USDC routing fee settles "
    "only for a qualifying live result; completed misses are not settled. Inspect billing, not "
    "just HTTP status; on an unknown outcome stop and reconcile rather than creating another "
    "authorization. MCP does not provide recovery-only requests. Seller payment remains "
    "separate."
)
PROTOCOL_VERSION = "2025-06-18"
SUPPORTED_PROTOCOLS = ("2025-03-26", PROTOCOL_VERSION)

PREVIEW_DESCRIPTION = (
    "Use preview first when you need to discover paid APIs by capability without paying or "
    "contacting seller endpoints. It searches upstream catalogs plus the local catalog; returned "
    "claims and any earlier observations are not a new live check (not_probed=true). The "
    "freshness timestamp describes this search response, not when each seller was last probed. "
    "Results can be limited or non-exhaustive.\n\n"
    "Pass a nonblank need describing the capability, not a URL to test. Omit networks to search "
    "all supported rails; an empty list searches none. networks is a hard allowlist; "
    "prefer_network only ranks results and cannot add an excluded rail. A chain mentioned in "
    "need can influence ranking when prefer_network is omitted.\n\n"
    "Use validate next for an unpaid readiness check of one concrete catalog-listed URL. Use "
    "route instead when you need fresh selection against price, network or readiness rules, or "
    "signed routing evidence. Preview does not enforce a purchase budget, reserve a price or "
    "authorize payment."
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
            "description": "402Signal routing-fee outcome. Seller payment is separate.",
            "properties": {
                "model": {"type": "string", "const": payment.ROUTING_BILLING_MODEL},
                "condition": {"type": "string", "const": payment.ROUTING_SETTLEMENT_CONDITION},
                "asset": {"type": "string", "const": "USDC"},
                "amount_atomic": {"type": "string", "const": payment.AMOUNT_ATOMIC},
                "display_amount": {"type": "string", "const": payment.AMOUNT_USD},
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
        "reputation": {"type": "object"},
        "objective": {
            "type": "string",
            "enum": list(schema_fields.OBJECTIVES),
        },
        "decision_binding": schema_fields.decision_binding_schema(),
        "binding_error": {"type": "string", "enum": ["route_binding_unavailable"]},
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
        "compared": {"type": "array"},
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
    "Use validate for an unpaid readiness check of one concrete HTTPS seller endpoint already "
    "listed in the local catalog, for example a URL returned by preview. It compares claimed and "
    "observed payment/readiness information and returns flags; it does not purchase the service "
    "or add a routing observation to history.\n\n"
    "Supply the exact listed URL, including its query string. The URL must be nonblank HTTPS; "
    "private/local destinations and unresolved path templates are refused. An unknown or "
    "modified URL can return miss_reason=no_candidates without any seller probe; this means not "
    "listed, not proven offline. Inspect live, readiness, observed and miss_reason rather than "
    "treating HTTP 200 as success.\n\n"
    "Use preview instead to find endpoints by capability. Use route for live constraint-based "
    "selection or signed routing evidence, including when you need to evaluate a direct URL "
    "outside the catalog subject to routing safety checks. Validate has no price or network "
    "filter, produces no signed route receipt, and is not proof that a paid call will deliver "
    "the desired result."
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

TOOLS = [
    {
        "name": "route",
        "description": ROUTE_DESCRIPTION,
        "inputSchema": INPUT_SCHEMA,
        "outputSchema": OUTPUT_SCHEMA,
    },
    {
        "name": "preview",
        "description": PREVIEW_DESCRIPTION,
        "inputSchema": PREVIEW_INPUT_SCHEMA,
        "outputSchema": PREVIEW_OUTPUT_SCHEMA,
    },
    {
        "name": "validate",
        "description": VALIDATE_DESCRIPTION,
        "inputSchema": VALIDATE_INPUT_SCHEMA,
        "outputSchema": VALIDATE_OUTPUT_SCHEMA,
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
    return isinstance(params, dict) and params.get("name") == "route"


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
        if name != "route":
            return 200, jsonrpc_error(req_id, -32602, "Unknown tool"), None
        code, body, extra = handle_route(args, headers, resource_url, bazaar=payment.BAZAAR_MCP)
        if code == 402:
            return code, body, extra
        return 200, _tool_result(req_id, body, code, version), extra
    return 200, jsonrpc_error(req_id, -32601, "Method not found"), None
