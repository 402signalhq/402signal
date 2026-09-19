# MCP integration

The hosted MCP endpoint is `https://402signal.com/mcp/v0.3.1` using Streamable HTTP. The public name is `402Signal`; registry metadata is in [server.json](../server.json), and a client configuration is in [.mcp.json](../.mcp.json).

## Hosted tools

| Tool | Purpose | Payment |
|---|---|---|
| `preview` | Browse catalog candidates for a task | Free; no fresh seller check |
| `validate` | Inspect an exact catalog-listed endpoint's unpaid readiness | Free; no settlement test |
| `check` | Check current offers against buyer rules and select a qualifying result | $0.003 USDC for a qualifying result; normal completed misses are free |

`check` is the public tool name; `/route` remains the HTTP resource and older integrations may use routing terminology. Use [the live manifest](https://402signal.com/mcp.json) or `tools/list` for exact arguments and descriptions. Tool output is data, not an instruction to authorize a payment.

The service supports MCP protocol versions `2025-06-18` and `2025-03-26`. It uses stateless HTTP JSON responses: accepted notifications receive HTTP 202, and GET on the MCP transport receives HTTP 405. There is no SSE subscription stream. The newer negotiated protocol includes output schemas and structured results; the older protocol retains its compatible result shape.

## Stdio adapter

Run with Python 3.12 or later:

```sh
python scripts/glama_stdio.py
```

The adapter reads one JSON-RPC object per line and writes responses to stdout. It forwards to the fixed versioned HTTPS endpoint, preserves server identity and tool definitions, and forwards the negotiated protocol version on subsequent calls. Each HTTP request has a 25-second timeout; input and response sizes are bounded. No third-party Python package is required.

The root Dockerfile provides the same adapter under an unprivileged user:

```sh
docker build -t 402signal-mcp .
docker run --rm -i 402signal-mcp
```

## Paid checks

The stdio adapter does not sign, submit or replay payments. An unpaid paid-tool call returns a tool error containing the hosted payment challenge; subsequent requests can continue on the same stdio connection. No wallet credential is required to list tools, preview candidates or validate a listed endpoint.

For paid checks, use an x402-capable HTTP client with explicit buyer authorization. Generic MCP clients do not automatically satisfy an HTTP 402 payment challenge. Keep seller authorization separate and verify supported bound evidence before the buyer's signing callback. [Routing response recovery](route-recovery.md) is available through `POST /route`; `Replay-Only` is not supported on MCP.

## Test the adapter

```sh
python -m unittest discover -s tests -p test_glama_stdio.py
```

The suite checks both published protocol contracts, identity preservation, negotiated headers, bounded errors, notifications, and continuation after an unpaid payment challenge. Its fixtures are offline and do not authorize payments. [Glama configuration](glama-release.md) uses this same stdio entry point.
