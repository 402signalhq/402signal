# MCP integration

Connect a Streamable HTTP client to `https://402signal.com/mcp/v0.3.1`.
The hosted tools are `check`, `preview` and `validate`; `route` remains an
accepted legacy alias for `check`.

For a stdio host, run `python scripts/glama_stdio.py` from the repository root
with Python 3.12 or later. The adapter forwards the hosted tool definitions and
responses without implementing a local routing service.

Preview and validation are free. Paid checks require an x402-capable HTTP client
with explicit buyer authorization. The stdio adapter does not sign or submit
payments; it returns an unpaid check's payment challenge as a tool error.

See the [MCP guide](../../docs/mcp.md) for supported protocol versions, payment
boundaries, container setup and offline adapter tests, or
[Glama configuration](../../docs/glama-release.md) for that client.
