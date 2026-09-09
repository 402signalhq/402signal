# Glama release: hosted-service stdio adapter

**HOLD — needs Ross per-channel GO before any Glama write.** Discovery
copy and the operator checklist live in
[track-c-discovery-drafts.md](track-c-discovery-drafts.md)
(`DRAFT / NO EXTERNAL WRITE`). A README or adapter change is not a Glama
release.

The Glama container runs `python scripts/glama_stdio.py`. It connects to the
public hosted MCP endpoint `https://402signal.com/mcp/v0.3.1` and forwards its
live tool definitions and responses. It does not start a self-hosted router.
Python 3.12 is sufficient; no additional packages, credentials, wallet, or
environment variables are required. Internet access to 402signal.com is required.

`preview` and `validate` are free and usable through stdio. A paid `route` call
returns a tool error containing the HTTP 402 payment challenge. Use an
x402-capable HTTP client at the endpoint above to sign and submit payments.
This adapter does not handle wallets, forward payment headers, or bypass payment.
Seller payment remains separate from the 402Signal routing fee.

This preserves the hosted server's identity, protocol negotiation, tool schemas,
and successful results. Initialization also discloses the adapter's payment
limitation. An HTTP 402 response does not terminate the stdio connection, so free
tools remain usable afterward. Requests have a 25-second network timeout.

## Glama build configuration

- Python: `3.12`
- Build steps: `[]`
- CMD arguments: `["python", "scripts/glama_stdio.py"]`
- Environment schema: `{"type":"object","properties":{},"additionalProperties":false}`
- Placeholder parameters: `{}`
- Pinned commit: the reviewed commit containing this adapter

Run Build, inspect the successful test and discovered tools, then create a Glama
release only after Ross GO. Glama releases are separate from GitHub releases and
from the hosted service version. The adapter's initial release version is
`0.1.0` (`User-Agent: 402Signal-Glama-stdio/0.1.0`). A later Glama index
refresh may appear as a distinct listing version; do not treat that as a new
adapter contract or as permission to publish.

## Validation

Run `python -m unittest discover -s tests -p test_glama_stdio.py` for the adapter
regression tests. Live smoke checks should initialize, list the three real tools,
call free preview and validate, and confirm that a route call without payment
returns a payment challenge while a subsequent free call still succeeds.
Do not provide payment credentials for these checks.
