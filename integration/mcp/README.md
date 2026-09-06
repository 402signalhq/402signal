# MCP interoperability regression

The pinned official `@modelcontextprotocol/sdk` client starts a loopback Python
fixture and exercises initialization, notifications, listing, free tools, an
HTTP 402 challenge, synthetic paid routing, and private response replay. It
does not contact a facilitator or spend funds.

Run from the repository with Python 3.12.14 and Node 24:

```bash
npm --prefix integration/mcp ci --ignore-scripts
npm --prefix integration/mcp test
```

402Signal supports stateless Streamable HTTP with JSON responses, negotiating
`2025-06-18` or `2025-03-26`. Tool content is a JSON-encoded text block;
`structuredContent` is also present with the newer protocol. Tool failures
use `isError`; malformed calls use JSON-RPC errors. Notifications return HTTP
202 with an empty body. GET on the transport endpoint returns 405 because SSE
is not offered; the discovery manifest remains at `/mcp.json`.

The x402 HTTP 402 challenge is an extension: a general MCP client does not
automatically authorize a payment. A payment-capable client must obtain its
own spending authorization and send the payment and private `Replay-Key`
headers. The fixture supplies synthetic values solely for the test.

Protocol references: [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
and [tool results](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).
