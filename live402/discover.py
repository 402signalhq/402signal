"""Public discovery docs for x402scan, Ontario, pay-skills, GoPlausible."""

from __future__ import annotations

from live402 import payment, probe, schema_fields

ORIGIN = "https://402signal.com"
ROUTE = f"{ORIGIN}/route"
DESC = payment.CATALOG_DESCRIPTION
ROUTING_PRICE_USDC = payment.AMOUNT_USD.removeprefix("$")
# Catalog indexes copy DESC. OpenAPI info keeps the short operational remainder.
OPENAPI_INFO_DESCRIPTION = (
    DESC
    + " Authorize $0.003 USDC on Base, Solana, or Algorand. It settles only for a "
    "valid live eligible route backed by a current payment envelope; normal typed misses are not settled. "
    "Seller payment is separate. Reachable 200s are misses. "
    "MCP: GET /mcp.json."
)
GUIDANCE = (
    "POST /route with JSON {need and/or url}. Unpaid calls return HTTP 402. "
    "Agents that intend to pay should POST, not GET. "
    "GET /route with Accept: application/json (or no Accept) returns the 402 "
    "challenge so crawlers can index payment; browsers that send text/html "
    "get a human page. "
    "Wallet checklist: the routing authorization is 3000 atomic USDC ($0.003); "
    "include extra.feePayer on Solana and Algorand; "
    "retry the 402 with PAYMENT-SIGNATURE on POST, never GET; "
    "v1 top-level network is 'base', v2 accepts[].network is CAIP-2 eip155:8453; "
    "copy the target facilitator URL from accepts[].extra.facilitator — do not default to x402.org. "
    "Authorize $0.003 USDC then retry with PAYMENT-SIGNATURE or X-PAYMENT. "
    "We verify, probe, and settle only a valid live eligible route. "
    "Live means a parseable unpaid 402 (PAYMENT-REQUIRED or JSON accepts[]/x402Version), "
    "not merely reachable. HTTP 200 is a settled live winner or a completed unpaid miss with live:false, payable:false, selected_payment:null and billing.settlement_state=not_attempted; "
    "HTTP 503 retains operational failures: an unsettled failure has "
    "billing.settlement_state=not_attempted; a required-transparency failure after "
    "settlement has settlement_state=settled; and an ambiguous settlement has "
    "settlement_state=unknown. Inspect billing before retrying, and never reuse an "
    "authorization whose settlement state is unknown. Seller payment is separate. "
    "If inputSchema is missing on an otherwise live payable route, invocable is false and miss_reason is omitted; "
    "an explicit empty-object inputSchema (type object, no properties/required) advertises no required inputs and is invocable when payable; "
    "that is not a guarantee the seller call succeeds; "
    "no_input_schema is only the top-level miss when invocation schema is required and unmet. "
    "constraints_unmet includes the named unmet bounds in unresolved_constraints. "
    "GET /mcp.json lists the MCP route tool (type mcp, toolName route); "
    "POST /mcp initialize and tools/list need no payment; tools/call route is the paid probe. "
    "GET /preview?need= is a free request-time catalog search (not_probed:true). Optional prefer_network=base|solana|algorand is a weak ranking preference (still searches all rails). Optional networks= is a hard policy lock. GET /rails lists pay-in rails. "
    "GET /pulse and GET /dashboard are sample lookups. Pulse discovery copy is hybrid: "
    "current upstream catalogs plus a local shadow catalog. index_status is "
    "upstream-live, shadow-warm, both, or fixture. Pulse does not publish listing totals. "
    "GET /health is {ok:true} only. "
    "POST /validate {url} (or GET /validate?url=) is an unpaid seller probe: agent-ready? Fail-closed SSRF, not a /route paywall bypass. "
    "GET /attestation is a public sha256 of a recent 402signal_observed probe batch (not on-chain). "
    "GET /pq/log/checkpoint and /pq/log/tile/* are an experimental C2SP transparency log. "
    "Production transparency log identity targets Algorand MainNet. "
    "MainNet broadcasting is controlled by runtime policy; confirmed anchors are "
    "published in the public trust descriptor. "
    "Signer never reads BROADCAST and never POSTs. /route does not wait for chain. "
    "Falcon authorizes a checkpoint txn, not a merchant payment. "
    "A settled HTTP 200 winner is not atomic with log append (SEC-ROUTER-004 / A-14). "
    "A free typed miss creates no route-decision leaf. A settled winner does not "
    "require a durable signed leaf unless require_transparency or require_route_binding is true. "
    "Optional require_route_binding=true requests a signed v4 binding for buyer-side "
    "comparison with the current seller challenge before signing. Ordinary requests "
    "keep the v3 receipt path. Guide: https://402signal.com/developers#route-binding. "
    "logged_uncheckpointed is never success "
    "when require_transparency is set. "
    + schema_fields.TRANSPARENCY_RETENTION_DESC
    + " "
    "Probe budget is under 60s; a hang returns 503 JSON with miss_reason probe_timeout. "
    "If ranked candidates remain when the budget ends, miss_reason is probe_budget_exhausted "
    "(not no_candidates). If the request probe ceiling is hit with ranked candidates still untested and "
    "budget remaining, miss_reason/stop_reason is probe_limit_reached (not no_candidates). "
    "Typical probe plan is a first tranche of 3, then 2–4 more if no winner. Hard ceiling is 20. "
    "GET /preview adds discovery_matches, displayed, and a read-only "
    "observation from 402signal_observed history (not_yet_observed when never probed). "
    "Ordinary discovery probes use GET first, then POST {} only when GET is 405/501 AND the "
    "catalog explicitly declares POST AND does not require a request body. "
    "Never POST {} after GET 200/400/401/403/404/500. "
    "Never POST seller-declared or catalog-declared input bodies. If a required body "
    "means a valid unpaid probe cannot be constructed, miss_reason is unsafe_to_probe. "
    "The separate parallel-search-json-v1 profile permits a validated buyer-provided "
    "JSON body only to its fixed endpoint, with require_route_binding=true. "
    "DNS uses a bounded getaddrinfo pool (2s) and the TCP/TLS "
    "connection is pinned to those SSRF-checked public IPs with TLS SNI and HTTP Host "
    "set to the original hostname (re-pinned on each redirect hop)."
)

def _origin_from_resource(resource_url: str) -> str:
    raw = (resource_url or ROUTE).strip()
    if raw.endswith("/route"):
        return raw[: -len("/route")] or ORIGIN
    return ORIGIN


def well_known(resource_url: str = ROUTE) -> dict:
    """Bazaar-ish discovery blob. Same body for /.well-known/x402 and .json."""
    required = payment.payment_required(resource_url, dynamic=False)
    origin = _origin_from_resource(resource_url)
    accepts = list(required.get("accepts") or [])
    return {
        "version": 1,
        "x402Version": 2,
        "name": "402Signal",
        "description": DESC,
        "homepage": ORIGIN,
        "site": ORIGIN,
        "openapi": f"{origin}/openapi.json",
        "mcp": f"{origin}/mcp.json",
        "mcpEndpoint": f"{origin}/mcp",
        "accepts_payment": True,
        "payment_protocols": ["x402"],
        "default_network": "eip155:8453",
        "default_asset": payment.USDC_BASE,
        "price_usdc": ROUTING_PRICE_USDC,
        "price_atomic": int(payment.AMOUNT_ATOMIC),
        "billing": dict(required.get("billing") or {}),
        "resource": resource_url,
        "resources": [
            "POST /route",
            {
                "url": resource_url,
                "method": "POST",
                "type": "http",
                "description": DESC,
                "mimeType": "application/json",
                "serviceName": "402Signal",
                "price": payment.AMOUNT_USD,
                "price_usdc": ROUTING_PRICE_USDC,
                "price_atomic": payment.AMOUNT_ATOMIC,
                "billing": dict(required.get("billing") or {}),
                "networks": ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="],
                "accepts": accepts,
                "extensions": required.get("extensions") or {"bazaar": payment.BAZAAR_EXTENSION},
            },
        ],
        "accepts": accepts,
        "extensions": required.get("extensions") or {"bazaar": payment.BAZAAR_EXTENSION},
        "ownershipProofs": [
            payment.payto_address(),
            payment.payto_solana(),
            payment.payto_algorand(),
        ],
        "payTo": {
            "base": payment.payto_address(),
            "solana": payment.payto_solana(),
            "algorand": payment.payto_algorand(),
        },
        "pay_to": payment.payto_address(),
    }


def openapi_spec(resource_url: str = ROUTE) -> dict:
    """OpenAPI 3.1. Paid POST /route documents HTTP 402 + x-payment-info."""
    origin = _origin_from_resource(resource_url)
    required = payment.payment_required(resource_url, dynamic=False)
    miss_enum = list(schema_fields.MISS_REASONS)
    # A documentation-only seller quote; never a live quote or payment authority.
    example_seller_accept = {
        "scheme": "exact", "network": payment.BASE_CAIP2, "asset": payment.USDC_BASE,
        "amount": "10000", "payTo": "0x1111111111111111111111111111111111111111",
        "maxTimeoutSeconds": 60,
    }
    example_seller_envelope = {"x402Version": 2, "accepts": [example_seller_accept]}
    example_selected = payment.selected_payment_fields(
        payment.validate_observed_accept(example_seller_accept, example_seller_envelope)
    )
    probe_item = {
        "type": "object",
        "properties": {
            "method": {"type": "string"},
            "status": {"type": ["integer", "null"]},
            "miss_reason": {"type": "string", "enum": miss_enum},
        },
    }
    target_schema = {
        "type": "object",
        "properties": {
            "method": {"type": "string"},
            "inputSchema": schema_fields.seller_schema_field(),
            "outputSchema": schema_fields.seller_schema_field(),
            "accepts": {"type": "array", "items": {"type": "object"}},
            "facilitator": {"type": ["string", "null"]},
            "amountAtomic": {"type": ["string", "null"]},
            "displayAmount": {"type": ["string", "null"]},
            "timeoutSeconds": {"type": "integer"},
        },
    }
    live_schema = {
        "type": "object",
        "required": ["billing"],
        "properties": {
            "live": {"type": "boolean"},
            "challenge_observed": {"type": "boolean"},
            "payable": {"type": "boolean"},
            "invocable": {"type": "boolean"},
            "selected_payment": {
                "type": ["object", "null"],
                "description": (
                    "Exact CURRENT OBSERVED payment option that won this route. "
                    "Never a catalog-only rail."
                ),
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
            "url": {"type": ["string", "null"]},
            "status": {"type": ["integer", "null"]},
            "latency_ms": {"type": ["integer", "null"]},
            "has_402_challenge": {"type": "boolean"},
            "probed_at": {"type": "string"},
            "tried": {"type": "integer"},
            "discovery_matches": {"type": "integer"},
            "candidates_discovered": {"type": "integer"},
            "candidates_considered": {"type": "integer"},
            "candidates_probed": {"type": "integer"},
            "probe_ceiling": {
                "type": "integer",
                "description": "Per-request probe cap (typical 7, thorough 15, hard server ceiling 20).",
            },
            "probe_budget_exhausted": {"type": "boolean"},
            "interpreted_constraints": {
                "type": "object",
                "description": (
                    "Constraints actually used by the engine (structured body keys plus "
                    "compiled NL that reached selection). Empty only when unconstrained."
                ),
            },
            "applied_constraints": {
                "type": "object",
                "description": "Same echo as interpreted_constraints: bounds actually applied.",
            },
            "unmet_constraints": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Named bounds that failed among evaluated live candidates. "
                    "Tiny-price and high-min-observation misses stay distinct."
                ),
            },
            "unresolved_constraints": {
                "type": "array",
                "description": (
                    "Unparsed policy phrases and, when miss_reason is constraints_unmet, "
                    "the named bounds that no evaluated live candidate satisfied. "
                    "Empty only when no such requirement exists; constraints_unmet never "
                    "uses an empty list."
                ),
            },
            "candidate_evaluation_complete": {
                "type": "boolean",
                "description": (
                    "True iff every ranked/need-matching candidate in this request's "
                    "working set was probed. Does not imply global catalog completeness."
                ),
            },
            "evaluation_complete": {
                "type": "boolean",
                "description": "Alias of candidate_evaluation_complete.",
            },
            "discovered_count": {"type": "integer"},
            "probed_count": {"type": "integer"},
            "unprobed_count": {"type": "integer"},
            "stop_reason": {
                "type": "string",
                "enum": [
                    "winner_selected",
                    "candidate_set_exhausted",
                    "probe_limit_reached",
                    "probe_budget_exhausted",
                    "constraints_unmet",
                ],
                "description": (
                    "Why this request stopped probing. winner_selected may leave "
                    "ranked candidates untested (candidate_evaluation_complete=false). "
                    "probe_limit_reached means this request's probe_ceiling was hit "
                    "with untested ranked candidates remaining and the 55s budget still open."
                ),
            },
            "payTo": {"type": ["string", "null"]},
            "payTo_changed": {"type": "boolean"},
            "verified_at": {"type": ["string", "null"]},
            "verified_seconds_ago": {"type": ["integer", "null"]},
            "readiness": {"type": "string", "enum": ["discovered", "payable", "invocable", "recently_verified"]},
            "risk": {"type": "array", "items": {"type": "string"}},
            "history": {
                "type": "object",
                "properties": {
                    "success_24h": {"type": ["number", "null"]},
                    "success_7d": {"type": ["number", "null"]},
                    "n_24h": {"type": ["integer", "null"]},
                    "n_7d": {"type": ["integer", "null"]},
                    "p50_latency_ms": {"type": ["integer", "null"]},
                    "p95_latency_ms": {"type": ["integer", "null"]},
                },
            },
            "traction": {"type": "string"},
            "miss_reason": {"type": "string", "enum": miss_enum},
            "schema_source": {"type": ["string", "null"], "enum": ["envelope", "catalog", "bazaar"]},
            "claimed": schema_fields.claimed_output_schema(),
            "target": target_schema,
            "probes": {"type": "array", "items": probe_item},
            "health": {
                "type": "object",
                "properties": {
                    "live": {"type": "boolean"},
                    "last_probe": {"type": "string"},
                    "latency_ms": {"type": ["integer", "null"]},
                    "has_402_challenge": {"type": "boolean"},
                    "status": {"type": ["integer", "null"]},
                },
            },
            "reputation": {
                "type": "object",
                "description": (
                    "Transparent components first (observed, usage, tenure, stability, "
                    "source_count), then V2 reputation_score, reputation_confidence, "
                    "and scoring_model_id/hash. Score is never returned without components. "
                    "No public 0-100 catalog badge. Unique payer addresses are never listed."
                ),
            },
            "payment_authorization": {
                "type": "object",
                "properties": {
                    "pq_native": {
                        "type": "boolean",
                        "description": "Always false. x402 pay-in is not a Falcon authorization.",
                    }
                },
            },
            "decision_binding": schema_fields.decision_binding_schema(),
            "binding_error": {"type": "string", "enum": ["route_binding_unavailable"]},
            "pq_trust": {
                "type": "object",
                "description": (
                    "Optional experimental transparency receipt. Not atomic with a settled "
                    "winner (SEC-ROUTER-004 / A-14): settlement does not require a "
                    "durable signed leaf unless require_transparency or require_route_binding is true. Free typed "
                    "misses create no route-decision leaf. status is "
                    "pending (durable leaf + signed checkpoint, not MainNet-anchored), "
                    "logged_uncheckpointed (durable leaf, no signed checkpoint), or "
                    "unavailable (receipt unavailable; append may have occurred). logged_uncheckpointed is never success "
                    "when require_transparency is true. "
                    + schema_fields.TRANSPARENCY_RETENTION_DESC
                    + " Not a /trust page."
                ),
                "properties": {
                    "transparency": {
                        "type": "object",
                        "properties": {
                            "status": {
                                "type": "string",
                                "enum": list(schema_fields.TRANSPARENCY_STATUSES),
                            },
                            "state": {
                                "type": "string",
                                "enum": list(schema_fields.TRANSPARENCY_STATES),
                            },
                            "log_origin": {"type": "string"},
                            "leaf_type": {"type": "string"},
                            "index": {"type": "integer"},
                            "checkpoint_size": {"type": "integer"},
                            "receipt": {
                                "type": "object",
                                "description": (
                                    "Inclusion proof and signed checkpoint. Retain it with "
                                    "reveal for later verification."
                                ),
                            },
                            "reveal": {
                                "type": "object",
                                "description": (
                                    "Customer-private routing evidence and salt. Not published "
                                    "in the public log. Private replay outcomes may retain it; "
                                    "keep securely with receipt."
                                ),
                            },
                        },
                    }
                },
            },
            "objective": {
                "type": "string",
                "enum": [
                    "best",
                    "cheapest",
                    "fastest",
                    "most_reliable",
                    "lowest_total_cost",
                    "fastest_settlement",
                ],
            },
            "compared": {
                "type": "array",
                "description": (
                    "Slim probe rows (cap 5). The winner always occupies a slot. "
                    "success_7d is null when n_7d < 3, never an invented 0.0. "
                    "n_7d distinguishes 3/3 from 400/400."
                ),
                "items": {
                    "type": "object",
                    "properties": {
                        "url": {"type": ["string", "null"]},
                        "rail": {"type": ["string", "null"]},
                        "amount_atomic": {"type": ["integer", "null"]},
                        "latency_ms": {"type": ["integer", "null"]},
                        "success_7d": {"type": ["number", "null"]},
                        "n_7d": {"type": "integer"},
                        "readiness": {"type": ["string", "null"]},
                        "live": {"type": "boolean"},
                        "invocable": {"type": "boolean"},
                        "selected": {"type": "boolean"},
                        "selected_payment": {"type": ["object", "null"]},
                        "reputation": {"type": ["object", "null"]},
                        "economics": {
                            "type": ["object", "null"],
                            "description": (
                                "Rail economics for the selected_payment option. Every field "
                                "has provenance: 402signal_observed, protocol_reference, or unknown."
                            ),
                        },
                    },
                },
            },
        },
    }
    route_body = schema_fields.route_body_schema()
    route_body["properties"]["need"]["example"] = "erc20 token balance"
    route_body["properties"]["url"]["example"] = "https://example.com/x402/balance"
    example_402 = dict(required)
    return {
        "openapi": "3.1.0",
        "info": {
            "title": "402Signal",
            "version": "0.5.0",
            "description": OPENAPI_INFO_DESCRIPTION,
            "x-guidance": GUIDANCE,
            "contact": {"url": ORIGIN, "name": "402Signal", "email": "ross@402signal.com"},
        },
        "servers": [{"url": origin, "description": "This origin"}],
        "tags": [
            {"name": "Paid", "description": "x402-gated routes"},
            {"name": "Public", "description": "Catalog, preflight, rails, and liveness"},
        ],
        "paths": {
            "/route": {
                "get": {
                    "operationId": "getRoute",
                    "tags": ["Paid"],
                    "summary": "Get JSON 402 challenge or HTML page",
                    "description": "Agents and crawlers that omit Accept or send application/json receive HTTP 402 with accepts[]. Browsers that send text/html receive an HTML page. Agents that intend to pay should POST.",
                    "parameters": [
                        {
                            "in": "header",
                            "name": "Accept",
                            "required": False,
                            "description": "text/html returns HTML; application/json or omitted returns HTTP 402 with accepts[].",
                            "schema": {"type": "string", "example": "application/json"},
                        }
                    ],
                    "x-payment-info": {
                        "price": {"mode": "fixed", "currency": "USD", "amount": ROUTING_PRICE_USDC},
                        "protocols": [{"x402": {}}],
                        "networks": ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="],
                        "asset": "USDC",
                        "amountAtomic": payment.AMOUNT_ATOMIC,
                        "billingModel": payment.ROUTING_BILLING_MODEL,
                        "settlementCondition": payment.ROUTING_SETTLEMENT_CONDITION,
                        "typedMissesSettled": False,
                    },
                    "responses": {
                        "200": {
                            "description": "HTML page for browsers that send Accept: text/html",
                            "content": {
                                "text/html": {
                                    "schema": {"type": "string"},
                                }
                            },
                        },
                        "402": {
                            "description": "Payment challenge for agents and crawlers. JSON body includes accepts[].",
                            "headers": {
                                "PAYMENT-REQUIRED": {
                                    "description": "Base64 x402 PaymentRequired (v2)",
                                    "schema": {"type": "string"},
                                }
                            },
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "#/components/schemas/PaymentRequired"},
                                    "example": example_402,
                                }
                            },
                        },
                    },
                },
                "post": {
                    "operationId": "route",
                    "tags": ["Paid"],
                    "parameters": [{"$ref": "#/components/parameters/ReplayKey"}],
                    "summary": "Authorize $0.003 USDC; settle only for a valid live route",
                    "description": DESC,
                    "x-payment-info": {
                        "price": {"mode": "fixed", "currency": "USD", "amount": ROUTING_PRICE_USDC},
                        "protocols": [{"x402": {}}],
                        "networks": ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="],
                        "asset": "USDC",
                        "amountAtomic": payment.AMOUNT_ATOMIC,
                        "billingModel": payment.ROUTING_BILLING_MODEL,
                        "settlementCondition": payment.ROUTING_SETTLEMENT_CONDITION,
                        "typedMissesSettled": False,
                    },
                    "x-discovery": {
                        "ownershipProofs": [
                            payment.payto_address(),
                            payment.payto_solana(),
                            payment.payto_algorand(),
                        ]
                    },
                    "security": [{"paymentSignature": []}, {"xPayment": []}],
                    "requestBody": {
                        "required": False,
                        "content": {
                            "application/json": {
                                "schema": route_body,
                                "example": {
                                    "need": "erc20 token balance",
                                    "url": "https://example.com/x402/balance",
                                },
                            }
                        },
                    },
                    "responses": {
                        "200": {
                            "description": "Completed routing check: a settled live eligible winner or a normal unpaid miss (live:false, payable:false, selected_payment:null). Inspect billing.",
                            "content": {
                                "application/json": {
                                    "schema": live_schema,
                                    "examples": {
                                        "settled_winner": {"value": {
                                                "live": True,
                                                "payable": True,
                                                "invocable": True,
                                                "payTo": example_seller_accept["payTo"],
                                                "envelope": example_seller_envelope,
                                                "selected_payment": example_selected,
                                                "url": "https://example.com/x402/balance",
                                                "status": 402,
                                                "latency_ms": 87,
                                                "has_402_challenge": True,
                                                "probed_at": "2026-08-29T22:00:00-04:00",
                                                "tried": 1,
                                                "probes": [{"method": "GET", "status": 402}],
                                                "billing": {
                                                    "model": payment.ROUTING_BILLING_MODEL,
                                                    "condition": payment.ROUTING_SETTLEMENT_CONDITION,
                                                    "asset": "USDC",
                                                    "amount_atomic": payment.AMOUNT_ATOMIC,
                                                    "display_amount": payment.AMOUNT_USD,
                                                    "rail": "base",
                                                    "settlement_attempted": True,
                                                    "settled": True,
                                                    "settlement_state": "settled",
                                                },
                                                "target": {
                                                    "method": "GET",
                                                    "inputSchema": {"type": "object"},
                                                    "outputSchema": {"type": "object"},
                                                    "accepts": [example_seller_accept],
                                                    "facilitator": "https://api.cdp.coinbase.com/platform/v2/x402",
                                                    "amountAtomic": "10000",
                                                    "displayAmount": "$0.01",
                                                    "timeoutSeconds": 60,
                                                },
                                            }},
                                        "normal_typed_miss": {"value": {
                                                "live": False, "payable": False, "invocable": False,
                                                "selected_payment": None, "url": None, "miss_reason": "no_candidates",
                                                "billing": {
                                                    "model": payment.ROUTING_BILLING_MODEL,
                                                    "condition": payment.ROUTING_SETTLEMENT_CONDITION,
                                                    "asset": "USDC", "amount_atomic": payment.AMOUNT_ATOMIC,
                                                    "display_amount": payment.AMOUNT_USD, "rail": "base",
                                                    "settlement_attempted": False, "settled": False,
                                                    "settlement_state": "not_attempted",
                                                },
                                            }},
                                    },
                                }
                            },
                        },
                        "402": {
                            "description": "Authorize $0.003 USDC (3000 atomic). It settles only for a valid live eligible route; seller payment is separate.",
                            "headers": {
                                "PAYMENT-REQUIRED": {
                                    "description": "Base64 x402 PaymentRequired (v2)",
                                    "schema": {"type": "string"},
                                }
                            },
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "#/components/schemas/PaymentRequired"},
                                    "example": example_402,
                                }
                            },
                        },
                        "503": {
                            "description": "Fail-closed route outcome. Inspect billing before retrying: an operational failure can be not attempted, a required-transparency failure can already be settled, and an ambiguous settlement is unknown and must not reuse the authorization.",
                            "content": {
                                "application/json": {
                                    "schema": live_schema,
                                    "examples": {
                                        "unsettled_operational_failure": {
                                            "summary": "Probe timed out; routing fee not settled",
                                            "value": {
                                                "live": False,
                                                "invocable": False,
                                                "url": None,
                                                "tried": 0,
                                                "payable": False,
                                                "selected_payment": None,
                                                "miss_reason": "probe_timeout",
                                                "billing": {
                                                    "model": payment.ROUTING_BILLING_MODEL,
                                                    "condition": payment.ROUTING_SETTLEMENT_CONDITION,
                                                    "asset": "USDC",
                                                    "amount_atomic": payment.AMOUNT_ATOMIC,
                                                    "display_amount": payment.AMOUNT_USD,
                                                    "rail": "base",
                                                    "settlement_attempted": False,
                                                    "settled": False,
                                                    "settlement_state": "not_attempted",
                                                },
                                                "probes": [],
                                            },
                                        },
                                        "settled_transparency_failure": {
                                            "summary": "Routing fee settled; required transparency unavailable",
                                            "value": {
                                                "error": "transparency receipt unavailable",
                                                "live": False,
                                                "invocable": False,
                                                "billing": {
                                                    "model": payment.ROUTING_BILLING_MODEL,
                                                    "condition": payment.ROUTING_SETTLEMENT_CONDITION,
                                                    "asset": "USDC",
                                                    "amount_atomic": payment.AMOUNT_ATOMIC,
                                                    "display_amount": payment.AMOUNT_USD,
                                                    "rail": "base",
                                                    "settlement_attempted": True,
                                                    "settled": True,
                                                    "settlement_state": "settled",
                                                },
                                            },
                                        },
                                        "settlement_unknown": {
                                            "summary": "Settlement POST outcome ambiguous; do not retry authorization",
                                            "value": {
                                                "error": "Routing authorization outcome unknown; do not retry this authorization",
                                                "live": False,
                                                "invocable": False,
                                                "miss_reason": "settlement_unknown",
                                                "billing": {
                                                    "model": payment.ROUTING_BILLING_MODEL,
                                                    "condition": payment.ROUTING_SETTLEMENT_CONDITION,
                                                    "asset": "USDC",
                                                    "amount_atomic": payment.AMOUNT_ATOMIC,
                                                    "display_amount": payment.AMOUNT_USD,
                                                    "rail": "base",
                                                    "settlement_attempted": True,
                                                    "settled": None,
                                                    "settlement_state": "unknown",
                                                },
                                            },
                                        },
                                    },
                                }
                            },
                        },
                    },
                }
            },
            "/mcp.json": {
                "get": {
                    "operationId": "mcpManifest",
                    "tags": ["Public"],
                    "summary": "List MCP tools without a payment",
                    "description": "Three tools: route, preview, validate. Route calls require a payment authorization (HTTP 402 without one); preview and validate are unpaid.",
                    "responses": {"200": {"description": "MCP manifest"}},
                }
            },
            "/.well-known/mcp.json": {
                "get": {
                    "operationId": "mcpManifestWellKnown",
                    "tags": ["Public"],
                    "summary": "List MCP tools at the well-known path",
                    "responses": {"200": {"description": "MCP manifest"}},
                }
            },
            "/mcp": {
                "get": {
                    "operationId": "mcpManifestAlias",
                    "tags": ["Public"],
                    "summary": "Streamable HTTP endpoint; SSE is not offered",
                    "responses": {"405": {"description": "Use POST; tool metadata remains at /mcp.json"}},
                },
                "post": {
                    "operationId": "mcpJsonRpc",
                    "tags": ["Paid"],
                    "parameters": [{"$ref": "#/components/parameters/ReplayKey"}],
                    "summary": "Post MCP JSON-RPC; tools/call route is x402-gated",
                    "description": DESC,
                    "x-payment-info": {
                        "price": {"mode": "fixed", "currency": "USD", "amount": ROUTING_PRICE_USDC},
                        "protocols": [{"x402": {}}],
                        "billingModel": payment.ROUTING_BILLING_MODEL,
                        "settlementCondition": payment.ROUTING_SETTLEMENT_CONDITION,
                        "typedMissesSettled": False,
                    },
                    "responses": {
                        "200": {"description": "Correlated JSON-RPC result; tool content is in result.content and, for protocol 2025-06-18, result.structuredContent. Tool failures set result.isError."},
                        "202": {"description": "Accepted notification; empty body"},
                        "402": {"description": "Payment required for tools/call route"},
                    },
                }
            },
            "/preview": {
                "get": {
                    "operationId": "previewNeed",
                    "tags": ["Public"],
                    "summary": "Preview catalog hits without probing them",
                    "description": "Unpaid request-time catalog search. Returns discovery_matches, displayed hits, seller claims, and a read-only 402Signal observation when history exists. not_probed is always true. Does not probe and does not charge. Paid POST /route remains the fail-closed 402 probe. prefer_network is a weak ranking preference (still searches all rails). networks is a hard policy lock.",
                    "parameters": [
                        {
                            "in": "query",
                            "name": "need",
                            "required": True,
                            "schema": {"type": "string", "example": "weather"},
                            "description": "Plain-English lookup to search allowlisted catalogs.",
                        },
                        {
                            "in": "query",
                            "name": "prefer_network",
                            "required": False,
                            "schema": {"type": "string", "enum": ["base", "solana", "algorand"]},
                            "description": "Prefer this pay-in rail when ranking. Searches all supported rails; does not restrict to this rail. Use networks to restrict.",
                        },
                        {
                            "in": "query",
                            "name": "networks",
                            "required": False,
                            "schema": {
                                "type": "array",
                                "items": {"type": "string", "enum": ["base", "solana", "algorand"]},
                            },
                            "style": "form",
                            "explode": True,
                            "description": "Restrict searchable rails to this set. Repeat or comma-separate. Unlike prefer_network, other rails are not queried.",
                        },
                    ],
                    "responses": {
                        "200": {
                            "description": "Cached hits. not_probed is always true.",
                            "content": {
                                "application/json": {
                                    "schema": {
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
                                            "discovery_via": {
                                                "type": "object",
                                                "additionalProperties": {
                                                    "type": "string",
                                                    "enum": ["search", "pages", "error", "fixture"],
                                                },
                                                "description": "Per-rail how matches were returned. Compact; no internals.",
                                            },
                                            "discovery_exhaustive": {
                                                "type": "boolean",
                                                "description": "True only when every queried rail was untruncated and upstream_total equals returned.",
                                            },
                                            "hits": {
                                                "type": "array",
                                                "description": schema_fields.SELLER_TEXT_CLIENT_WARNING,
                                                "items": schema_fields.preview_hit_schema(),
                                            },
                                            "miss_reason": {"type": "string", "enum": miss_enum},
                                        },
                                    },
                                    "example": {
                                        "need": "weather",
                                        "not_probed": True,
                                        "freshness": "2026-08-30T14:00:00Z",
                                        "discovery_matches": 1,
                                        "displayed": 1,
                                        "hits": [
                                            {
                                                "need": "weather",
                                                "label": "weather",
                                                "url": "https://example.com/x402/weather",
                                                "price": "$0.01",
                                                "chain": "base",
                                                "origin": "catalog_claimed",
                                                "untrusted": True,
                                                "observation": {"status": "not_yet_observed"},
                                            }
                                        ],
                                    },
                                }
                            },
                        }
                    },
                }
            },
            "/rails": {
                "get": {
                    "operationId": "listRails",
                    "tags": ["Public"],
                    "summary": "List pay-in rails with facilitator health",
                    "description": "Three pay-in networks (Base, Solana, Algorand), asset, amountAtomic 3000, facilitators, feePayers, maxTimeoutSeconds, per-rail up+latency. Cached. Not stuffed into /health. Do not default facilitator to x402.org. v1 network is base; v2 accepts[].network is CAIP-2 eip155:8453.",
                    "responses": {
                        "200": {
                            "description": "Pay-in rails snapshot",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "properties": {
                                            "ok": {"type": "boolean"},
                                            "asset": {"type": "string"},
                                            "amountAtomic": {"type": "string"},
                                            "maxTimeoutSeconds": {"type": "integer"},
                                            "facilitators": {"type": "array", "items": {"type": "string"}},
                                            "feePayers": {"type": "object"},
                                            "rails": {"type": "array", "items": {"type": "object"}},
                                        },
                                    }
                                }
                            },
                        }
                    },
                }
            },
            "/health": {
                "get": {
                    "operationId": "health",
                    "tags": ["Public"],
                    "summary": "Check service liveness as JSON ok",
                    "responses": {
                        "200": {
                            "description": "ok",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "properties": {"ok": {"type": "boolean"}},
                                    }
                                }
                            },
                        }
                    },
                }
            },
            "/pulse": {
                "get": {
                    "operationId": "pulse",
                    "tags": ["Public"],
                    "summary": "Get JSON snapshot of sample lookups",
                    "description": (
                        "Sample lookups and observed facts. Discovery uses current upstream "
                        "catalogs and a local shadow catalog. index_status is upstream-live, "
                        "shadow-warm, both, or fixture. Does not publish listing totals or "
                        "sqlite paths. Rates omitted below n_7d=10. No binary healthy."
                    ),
                    "responses": {
                        "200": {
                            "description": "Public sample lookups snapshot",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "properties": {
                                            "ok": {"type": "boolean"},
                                            "index_status": {
                                                "type": "string",
                                                "enum": [
                                                    "upstream-live",
                                                    "shadow-warm",
                                                    "both",
                                                    "fixture",
                                                ],
                                            },
                                            "observed": {"type": "object"},
                                            "chains": {"type": "object"},
                                            "samples": {"type": "array"},
                                        },
                                    }
                                }
                            },
                        }
                    },
                }
            },
            "/validate": {
                "get": {
                    "operationId": "validateSellerGet",
                    "tags": ["Public"],
                    "summary": "Ask if a seller URL is agent-ready",
                    "description": "Unpaid seller probe: GET first, then POST {} only if justified. Never POST catalog-declared bodies. DNS IP-pin + fail-closed SSRF. Not a /route payment bypass. Never emits a binary healthy flag.",
                    "parameters": [
                        {
                            "in": "query",
                            "name": "url",
                            "required": True,
                            "schema": {"type": "string", "example": "https://example.com/x402"},
                            "description": "https URL of the seller endpoint to probe.",
                        }
                    ],
                    "responses": {
                        "200": {
                            "description": "Readiness, claimed vs observed, flags.",
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "#/components/schemas/ValidateResult"},
                                }
                            },
                        },
                        "400": {"description": "url missing or not https"},
                    },
                },
                "post": {
                    "operationId": "validateSeller",
                    "tags": ["Public"],
                    "summary": "Ask if a seller URL is agent-ready",
                    "description": "Unpaid seller probe: GET first, then POST {} only if justified. Never POST catalog-declared bodies. DNS IP-pin + fail-closed SSRF. Not a /route payment bypass. Never emits a binary healthy flag.",
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "url": {"type": "string", "example": "https://example.com/x402"},
                                    },
                                    "required": ["url"],
                                    "additionalProperties": False,
                                }
                            }
                        },
                    },
                    "responses": {
                        "200": {
                            "description": "Readiness, claimed vs observed, flags.",
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "#/components/schemas/ValidateResult"},
                                    "example": {
                                        "url": "https://example.com/x402",
                                        "readiness": "payable",
                                        "live": True,
                                        "payable": True,
                                        "invocable": False,
                                        "claimed": {"payTo": "0xabc", "amount": "10000", "schema_present": None},
                                        "observed": {"payTo": "0xabc", "amount": "10000", "schema_present": None, "http_status": 402, "latency_ms": 41},
                                        "flags": ["missing schema"],
                                        "n_7d": 1,
                                    },
                                }
                            },
                        },
                        "400": {"description": "url missing or not https"},
                    },
                },
            },
            "/pq/log/checkpoint": {
                "get": {
                    "operationId": "pqLogCheckpoint",
                    "tags": ["Public"],
                    "summary": "Experimental C2SP signed checkpoint",
                    "description": (
                        "text/plain C2SP tlog-checkpoint for the current / latest tree. "
                        "GET /pq/log/checkpoint/latest is the same alias. "
                        "Production log identity targets Algorand MainNet. "
                        "MainNet broadcasting is controlled by runtime policy; confirmed "
                        "anchors are published in the public trust descriptor. "
                        "/route does not wait for chain. Falcon authorizes a checkpoint "
                        "txn, not a merchant payment. May be newer than the latest confirmed MainNet anchor."
                    ),
                    "responses": {
                        "200": {"description": "Signed checkpoint note"},
                        "404": {"description": "No checkpoint yet"},
                    },
                }
            },
            "/pq/log/checkpoint/{tree_size}": {
                "get": {
                    "operationId": "pqLogCheckpointAtSize",
                    "tags": ["Public"],
                    "summary": "Experimental C2SP signed checkpoint at a tree size",
                    "description": (
                        "text/plain C2SP tlog-checkpoint for an exact historical tree size. "
                        "GET /pq/log/checkpoint remains the current / latest checkpoint."
                    ),
                    "parameters": [
                        {
                            "in": "path",
                            "name": "tree_size",
                            "required": True,
                            "schema": {"type": "integer", "minimum": 1},
                        }
                    ],
                    "responses": {
                        "200": {"description": "Signed checkpoint note for that tree size"},
                        "404": {"description": "No checkpoint at that size"},
                    },
                }
            },
            "/pq/log/tile/{level}/{n}": {
                "get": {
                    "operationId": "pqLogTile",
                    "tags": ["Public"],
                    "summary": "Experimental C2SP Merkle tile",
                    "description": (
                        "application/octet-stream tlog-tiles@v0.1.0. Path is /tile/<L>/<N> "
                        "(height 8 implicit), not sumdb /tile/H/L/N. Partial tiles use .p/<W>. "
                        "Production log identity targets Algorand MainNet. MainNet broadcasting is controlled by runtime policy."
                    ),
                    "parameters": [
                        {"in": "path", "name": "level", "required": True, "schema": {"type": "integer"}},
                        {"in": "path", "name": "n", "required": True, "schema": {"type": "string"}},
                    ],
                    "responses": {
                        "200": {"description": "Tile bytes"},
                        "404": {"description": "Unknown tile"},
                    },
                }
            },
            "/attestation": {
                "get": {
                    "operationId": "attestationHash",
                    "tags": ["Public"],
                    "summary": "Hash a recent observed probe batch",
                    "description": "sha256 of canonical JSON of 402signal_observed rows for a batch_id. Not on-chain. No signatures or keys.",
                    "parameters": [
                        {
                            "in": "query",
                            "name": "batch_id",
                            "required": False,
                            "schema": {"type": "string"},
                            "description": "Optional batch id. Default is the most recent observed batch.",
                        }
                    ],
                    "responses": {
                        "200": {
                            "description": "Public hash payload.",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "properties": {
                                            "batch_id": {"type": "string"},
                                            "created_at": {"type": ["string", "null"]},
                                            "n": {"type": "integer"},
                                            "algo": {"type": "string"},
                                            "hash": {"type": "string"},
                                        },
                                    }
                                }
                            },
                        },
                        "404": {"description": "No observed batch"},
                    },
                }
            },
            "/dashboard": {
                "get": {
                    "operationId": "dashboard",
                    "tags": ["Public"],
                    "summary": "Render HTML examples of sample lookups",
                    "responses": {"200": {"description": "HTML"}},
                }
            },
        },
        "components": {
            "parameters": {
                "ReplayKey": {
                    "name": "Replay-Key", "in": "header", "required": False,
                    "schema": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
                    "description": "Client-generated 32 random bytes, lowercase hex. Retain privately with the exact request for up to 120 seconds of authorized response retrieval. Never place it in payment metadata, logs, URLs or public receipts. Omission allows one execution but no cached response retrieval. Payment identity remains permanently one-use; expiry never authorizes a new charge."
                }
            },
            "securitySchemes": {
                "paymentSignature": {
                    "type": "apiKey",
                    "in": "header",
                    "name": "PAYMENT-SIGNATURE",
                    "description": "x402 v2 PaymentPayload, base64 JSON",
                },
                "xPayment": {
                    "type": "apiKey",
                    "in": "header",
                    "name": "X-PAYMENT",
                    "description": "x402 v1/v2 payment header",
                },
            },
            "schemas": {
                "ValidateResult": {
                    "type": "object",
                    "properties": {
                        "url": {"type": ["string", "null"]},
                        "readiness": {"type": "string", "enum": ["discovered", "payable", "invocable", "recently_verified"]},
                        "live": {"type": "boolean"},
                        "payable": {"type": "boolean"},
                        "invocable": {"type": "boolean"},
                        "claimed": {"type": "object"},
                        "observed": {"type": "object"},
                        "flags": {"type": "array", "items": {"type": "string"}},
                        "n_7d": {"type": "integer"},
                        "miss_reason": {"type": "string"},
                    },
                },
                "PaymentRequired": {
                    "type": "object",
                    "description": "x402 routing authorization. accepts[].amount is 3000 atomic USDC ($0.003); normal typed misses are not settled.",
                    "properties": {
                        "x402Version": {"type": "integer", "example": 2},
                        "error": {"type": "string"},
                        "payTo": {"type": "string"},
                        "network": {"type": "string"},
                        "asset": {"type": "string"},
                        "amount": {"type": "string", "example": payment.AMOUNT_USD},
                        "billing": {"type": "object"},
                        "resource": {"type": "object"},
                        "accepts": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "scheme": {"type": "string"},
                                    "network": {"type": "string"},
                                    "asset": {"type": "string"},
                                    "amount": {
                                        "type": "string",
                                        "description": "Atomic USDC. 3000 = $0.003",
                                        "example": payment.AMOUNT_ATOMIC,
                                    },
                                    "payTo": {"type": "string"},
                                },
                            },
                        },
                        "extensions": {"type": "object"},
                        "help": {"type": "object"},
                    },
                }
            },
        },
        "x-discovery": {
            "ownershipProofs": [
                payment.payto_address(),
                payment.payto_solana(),
                payment.payto_algorand(),
            ]
        },
        "x-examples": {
            "curl": (
                "curl -sS -D - https://402signal.com/route "
                "-H 'Content-Type: application/json' "
                "-d '{\"need\":\"YOUR_NEED\"}'\n"
                "# HTTP 402 + PAYMENT-REQUIRED. Select the matched/observed accept, then:\n"
                "curl -sS https://402signal.com/route "
                "-H 'Content-Type: application/json' "
                "-H \"PAYMENT-SIGNATURE: $SIG\" "
                "-d '{\"need\":\"YOUR_NEED\"}'\n"
                "# HTTP 200: settled winner or completed unpaid miss. Inspect live, payable, selected_payment and billing before seller execution; HTTP 503 can be unpaid, settled or unknown."
            ),
            "fetch": (
                "const r = await fetch('https://402signal.com/route', "
                "{method:'POST', headers:{'Content-Type':'application/json'}, "
                "body: JSON.stringify({need:'YOUR_NEED'})});\n"
                "// r.status === 402. Sign, then retry:\n"
                "const paid = await fetch('https://402signal.com/route', "
                "{method:'POST', headers:{'Content-Type':'application/json', "
                "'PAYMENT-SIGNATURE': sig}, body: JSON.stringify({need:'YOUR_NEED'})});\n"
                "// HTTP 200 can also be an unpaid miss. Inspect live, payable, selected_payment and billing; a 503 may be settled or unknown. Never automatically pay again."
            ),
            "mcp": (
                "POST https://402signal.com/mcp\n"
                '{"jsonrpc":"2.0","id":1,"method":"tools/call",'
                '"params":{"name":"route","arguments":{"need":"YOUR_NEED"}}}\n'
                "# unpaid HTTP 402. Sign, retry the same tools/call with PAYMENT-SIGNATURE. "
                "MCP result.isError is false for a winner or completed unpaid miss; operational failures are tool errors. Inspect the route body and billing before seller execution."
            ),
        },
    }


ROBOTS_TXT = """User-agent: *
Allow: /
Allow: /openapi.json
Allow: /.well-known/x402
Allow: /.well-known/x402.json
Allow: /pulse
Allow: /health
Allow: /llms.txt
Allow: /robots.txt
Allow: /mcp
Allow: /mcp.json
Allow: /.well-known/mcp.json
Allow: /preview
Allow: /rails
Allow: /validate
Allow: /attestation
Allow: /pq/log/checkpoint
Allow: /transparency

Sitemap: https://402signal.com/sitemap.xml
"""

LLMS_TXT = "# 402Signal\n\n" + DESC + """

## Start with the task

Free offline checks: https://402signal.com/developers/test-buyer
Add a purchase check: https://402signal.com/developers/check-offer
Select native MPP: https://402signal.com/developers/native-mpp
Sessions and invoices: https://402signal.com/developers/sessions-and-invoices
Inspect a listed API: https://402signal.com/developers/check-api-listing
Recover a routing attempt: https://402signal.com/developers/recover-routing-attempt
Reconcile a seller payment: https://402signal.com/developers/reconcile-seller-payment
Verify retained evidence: https://402signal.com/developers/evidence
Each recipe also has a .md URL. Exact packages, checksums and scope: https://402signal.com/capabilities.json
Use ordinary free APIs directly when no paid-offer check is needed. A hosted offer check, local verification guard and optional durable buyer client are different components.

## What 402Signal checks

402Signal checks a current paid API offer against a buyer's rules. We support Base, Solana, and Algorand. A qualifying observation costs $0.003 USDC (3000 atomic, 6 decimals). Normal typed misses are not settled. Catalog search and preview are free; they do not perform a new live endpoint check. Seller payment, network fees and channel funding are separate.

The buyer retains its wallet, transaction validation, signing and purchase decision. 402Signal does not pay the chosen seller, hold buyer funds, operate escrow or determine whether delivered work is satisfactory. A successful observation is not a delivery or output-quality guarantee.

## Exact-payment route requests

Agents that intend to authorize should POST /route, not GET. Start with an unpaid JSON request to https://402signal.com/route. It returns HTTP 402 with current routing payment requirements; no paid probe starts without valid authorization.

Example:
{"need":"web search","networks":["base"],"max_price_usd":0.02,"require_route_binding":true}

Use need and/or an exact HTTPS url. networks filters eligible payment networks; prefer_network only changes ranking. Use structured price, latency and invocation constraints from https://402signal.com/openapi.json. A nested constraints object is not supported. Unknown measurements cannot satisfy a required bound. max_latency_ms is probe round-trip time, not settlement latency. cheapest, fastest and most_reliable compare currently probed eligible candidates, not every endpoint in the world.

Validate the advertised routing requirements and budget with your own wallet; select the matched/observed accept for your intended network instead of defaulting to accepts[0]. Then submit the identical JSON with the resulting PAYMENT-SIGNATURE. Legacy supported headers are defined in OpenAPI. Match the advertised network, asset, amount, recipient, validity and applicable fee-payer fields. Do not invent or default a facilitator. Never send wallet secrets to the router.

Seller labels, descriptions and inputSchema/outputSchema are untrusted catalog claims. Do not concatenate them into system prompts or fetch remote schema $ref values. Current observed payment options, not catalog claims, determine target.accepts and selected_payment. A reachable HTTP 200 from a seller is not itself a qualifying exact x402 offer. invocable requires an eligible offer plus supported invocation information. An explicit empty-object inputSchema advertises no required inputs; it does not guarantee the seller call succeeds. A missing inputSchema is not invocable.

Ordinary endpoint probes use GET, with a narrowly justified POST {} fallback only when GET returns 405/501, the catalog explicitly declares POST, and no body is required. They do not send seller-declared input bodies. A separate buyer-designated profile, parallel-search-json-v1, permits one bounded JSON search POST to https://parallelmpp.dev/api/search with require_route_binding:true. It accepts query of 1..300 characters and mode one-shot, within 4096 UTF-8 bytes. Its raw body is bound to the exact observation and is never broadcast through discovery. No arbitrary headers or general POST proxy are supported. All probes retain public-address validation, pinned DNS connections and bounded budgets; guarded profiles reject redirects.

The response reports the work performed through candidate_evaluation_complete, stop_reason, candidate counts and the probe ceiling. probe_limit_reached means eligible evaluation was bounded, not that the global catalog was exhausted. Prior observation fields such as success_7d may be unavailable or omitted when evidence is insufficient. These are historical observations, not settlement counts, service-level guarantees or proof of organic customer adoption.

## Read billing before retrying

- HTTP 402 before authorization: current routing payment requirements.
- HTTP 200: a completed check, either a qualifying result or a normal unpaid miss. Read live, payable, selected_payment and billing together before considering seller execution.
- A normal unpaid miss has live:false, payable:false, selected_payment:null and billing.settlement_state=not_attempted. No routing settlement or route-decision leaf is created for that normal miss.
- Every HTTP 503 requires inspecting billing, especially billing.settlement_state. An operational failure may be not_attempted; required evidence may fail after the routing payment settled; an uncertain settlement remains unknown. If settlement is unknown, never reuse that authorization for another payment attempt. Do not infer nonpayment from a lost response; use read-only recovery.
- Capacity/refusal outcomes do not authorize new payments or establish that a previous attempt was unpaid.

The routing fee pays for the qualifying observation even if the buyer declines the merchant afterward. A changed offer or expired guard later does not reverse a settled routing fee.

## Client, guard and recovery

Published client and guard: https://github.com/402signalhq/402signal/releases/tag/route-guard-v0.7.0
Verify the published digest, then npm install ./402signal-route-guard-0.7.0.tgz . Node.js >=22 is required. This is a release archive, not an npm registry publication. Package exports include @402signal/route-guard, /client, /file-store, /recovery and the separate /batch guard. Full API: https://github.com/402signalhq/402signal/tree/main/sdk/route-guard

Set require_route_binding:true for a v4 exact-payment receipt. Preserve the original route request JSON, raw response JSON, exact seller URL/method/body and raw unpaid challenge. Immediately before signing, call withVerifiedRoute using an independently trusted log verification key. It checks the signature, inclusion, request binding, observed terms and expiry before invoking your buyer-owned callback. Unsupported, changed, malformed or expired evidence fails closed. The default freshness window is 60 seconds and is never renewed by replay, issuance or human approval.

Your wallet must independently validate the actual transaction, enforce budget and retain durable seller-operation identity. The guard does not hold keys, sign, send, guarantee exactly-once economics or guarantee fulfillment. Historical verifyReceipt validates evidence integrity after expiry; it does not authorize a new purchase. Contract: https://github.com/402signalhq/402signal/blob/main/docs/proof-carrying-route-v1.md

Use RouteClient with a private durable attempt store before paid submission. Recover the same attempt with client.recover(attemptId); do not create a fresh authorization after an uncertain result. The HTTP recovery-only contract reuses the same original JSON, payment authorization and private Replay-Key, plus Replay-Only: 1. Recovery returns the retained historical response within the finite private retention window and preserves its original expiry and uncertainty. Contract: https://github.com/402signalhq/402signal/blob/main/docs/route-recovery.md

Optional customer access keys identify a workload class; they are not wallet private keys. Payment headers and replay credentials are still sensitive. Keep credentials and private recovery stores outside public logs and repositories.

## Batch and session support

Supported profiles include Base batch settlement, Solana MPP push sessions, Algorand explicit atomic groups and aggregate invoices, and separate native Base and Algorand MPP charges. These are specific profiles, not a network/method cross-product. Dated controlled MainNet examples cover specific documented campaigns at owner-operated lab endpoints; they do not qualify every profile limit or external merchant. The published v0.7 client provides separate exact-payment and v5 batch/session guards. Controlled lab examples demonstrate specific contracts and limits. An ordinary v4 receipt does not authorize a batch or session.

The separate v5 proof binds one exact HTTPS GET API, merchant_profile, all buyer_limits and the raw observed challenge. It is a short-lived observation, not permission to deposit, issue vouchers or sign an arbitrary transaction. The router fee remains $0.003 per qualifying API observation; merchant charges, capital, fees and rent remain separate.

- Base base-x402-batch-v1: explicit EVM channel terms, receiver authorizer and buyer call/cumulative/capital caps. Voucher acceptance is distinct from eventual on-chain payout.
- Solana solana-mpp-session-v1: native MPP push sessions with a pinned program, operator and recipient. An observed session cap or minimum voucher increment does not establish the merchant's per-call price. The buyer owns opening, voucher signing and closing. This is not cross-channel batch settlement.
- Algorand algorand-atomic-two-item-v1: exactly two USDC payments to the same recipient for one exact HTTPS GET API, with item/total caps, sponsor terms and independently pinned job hashes. A complete versioned manifest is required. Atomic chain execution does not guarantee atomic HTTP delivery. The separate algorand-atomic-batch-v1 profile is the controlled lab example. algorand-atomic-multi-item-v1 permits 2..15 explicit job payments plus sponsorship; algorand-aggregate-invoice-v1 permits 2..64 explicit jobs in one invoice payment plus sponsorship. Invoice totals are not known per-job prices. See https://402signal.com/developers/sessions-and-invoices .

See https://github.com/402signalhq/402signal/blob/main/docs/batch-observation-v1.md . Profile-specific buyer adapters still validate chain state and transaction contents and retain durable one-shot intent. Never automatically sign or send again after uncertainty.

The x402 adapter for mppx is a gateway integration, separate from native MPP session settlement: https://github.com/402signalhq/402signal/tree/main/integration/mpp-client

## Preserve verification evidence

Clients requiring later verification must securely retain the complete paid /route response, original request, pq_trust.transparency.receipt and pq_trust.transparency.reveal. Private replay outcomes can retain the reveal for short-term recovery; they are not a recovery service for long-term evidence. Keep your own copy. The reveal contains private request and decision evidence; do not put it in public logs.

The public log commits a fingerprint, not the full private record. Immediate receipts use Ed25519. Production transparency log identity targets Algorand MainNet. MainNet broadcasting is controlled by runtime policy; confirmed anchors are published in the public trust descriptor. Cumulative checkpoints use Falcon-1024 authorization; a route response does not wait for chain confirmation. A pending leaf is not a confirmed anchor. Falcon authorizes a checkpoint transaction, not a merchant payment. It does not secure the seller's payment or output.

Settlement and log append are distinct. require_transparency or require_route_binding makes signed evidence required. If required evidence fails after settlement, billing still reports settled and no second settlement is attempted. Inspect the actual receipt status; never treat unavailable or logged_uncheckpointed evidence as a signed checkpoint. Historical leaf versions retain their original verification semantics. A public commitment does not promise unlinkable traffic.

Public evidence: https://402signal.com/transparency and GET /pq/log/checkpoint, /pq/log/tile/*, /pq/log/trust . Signer never reads BROADCAST and never POSTs. Signing authority and production runtime policy are separate from this guide.

## Interfaces

- GET /preview?need=weather: free catalog search, not_probed:true; discovery may be incomplete and seller claims remain untrusted.
- POST /validate {"url":"https://seller.example/x402"}: unpaid bounded probe for catalog-known URLs; also GET /validate?url= . Not an arbitrary URL proxy or a paid-route bypass.
- GET /attestation: a hash of a recent observation batch; not a signature or on-chain settlement proof.
- GET /rails: advertised routing pay-in networks and requirements.
- GET /pulse: historical operational snapshot; not a live guarantee or listing-total claim.
- GET /health: liveness only. GET /ready: readiness booleans for configured storage and authority; no paths or secrets.
- GET /openapi.json: full HTTP contract. GET /mcp.json and /.well-known/mcp.json: MCP manifest.
- POST /mcp: JSON-RPC initialize, tools/list and tools/call. preview and validate are unpaid; route uses the paid authorization flow.
- GET /route: text/html yields the human guide; application/json or no Accept yields the unpaid HTTP 402 challenge. Use POST for authorization.
- GET /llms.txt: this guide. Website: https://402signal.com/ . Docs index: https://github.com/402signalhq/402signal/blob/main/docs/README.md

MCP example:
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"route","arguments":{"need":"web search","require_route_binding":true}}}

## Public listings and discovery

These links are discovery locations, not endorsements or service guarantees.

Free third-party catalogues may help agents find us; confirm any returned `base_url` or MCP endpoint resolves to https://402signal.com (or https://402signal.com/mcp) before paying. Paid checks still use POST https://402signal.com/route on Base, Solana, and Algorand; $0.003 USDC only when a qualifying live route is found. Canonical rails: https://402signal.com/rails

- Glama: https://glama.ai/mcp/servers/402signalhq/402signal
- MCP Registry: https://registry.modelcontextprotocol.io/?q=402signal
- Smithery: https://smithery.ai/servers/live402/signal
- PayAPI Market listing: https://payapi.market/api/402signal
- PayAPI Market free catalogue MCP: https://payapi.market/mcp
- Agentic Market: https://agentic.market/services/402signal-com
- GoPlausible: https://facilitator.goplausible.xyz/dashboard/merchants/56466a9400d70f08
- x402scan: https://www.x402scan.com/recipient/0xb18fc2275f36dae99eb215caeff03b431f887d16
- CDP discovery: https://api.cdp.coinbase.com/platform/v2/x402/discovery/search?query=402signal
- PayAI discovery: https://facilitator.payai.network/discovery/resources
- GoPlausible discovery: https://facilitator.goplausible.xyz/discovery/resources

Security contact: https://402signal.com/.well-known/security.txt . Never submit wallet keys or private production records in a public issue.
"""
