"""Per-request context. Request id only; never payment material."""

from __future__ import annotations

import contextvars

request_id: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")

# Derived by the HTTP server from its trusted transport; never a request header.
peer_ip: contextvars.ContextVar[str] = contextvars.ContextVar("peer_ip", default="unknown")
