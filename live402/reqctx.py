"""Per-request context. Request id only; never payment material."""

from __future__ import annotations

import contextvars

request_id: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")

# Derived by the HTTP server from its trusted transport; never a request header.
peer_ip: contextvars.ContextVar[str] = contextvars.ContextVar("peer_ip", default="unknown")

# Server-assigned hosted /route class. Empty until the paid path sets it.
# Never copied from a caller body or header.
traffic_class: contextvars.ContextVar[str] = contextvars.ContextVar(
    "traffic_class", default=""
)

# Set by the paid path once the facilitator has verified the payer and it is one
# of the operator's own wallets (LIVE402_SELF_PAYERS). Metrics and the payer day
# are then labelled "self"; the probe rows keep traffic_class, so the seller
# facts stay public. Never copied from a caller body or header.
self_payer: contextvars.ContextVar[bool] = contextvars.ContextVar("self_payer", default=False)
