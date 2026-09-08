# Writing MCP tool descriptions

Tool descriptions should help an agent choose and call the right tool without opening a link. Keep server summaries short; give each tool its own decision guidance. The hosted definitions in `live402/mcp.py` are also what the credential-free [Glama adapter](glama-release.md) forwards.

## The current choices

| Tool | Choose it for | Choose another tool when |
| --- | --- | --- |
| `preview` | Free catalog discovery by capability; no new seller probe | Use `validate` to check a listed URL, or `route` to apply spending rules to a live selection |
| `validate` | Free readiness check of one exact catalog-listed HTTPS URL | Use `preview` to find candidates, or `route` for constraints and signed routing evidence |
| `route` | Live selection against explicit rules; seller purchase remains separate | Use the free tools for discovery or basic listed-endpoint readiness; paid completion needs an x402-capable HTTP client |

These are tool-selection examples, not paid requests:

```json
{"name":"preview","arguments":{"need":"weather","networks":["base"]}}
```

For `validate`, copy a concrete URL from a catalog result. For `route`, start with `need` or `url` plus the constraints the buyer actually requires. A request without payment returns the routing challenge; the Glama stdio adapter cannot sign or submit payment.

## Before changing or adding a tool

1. Lead with the task and the situation in which this tool is useful. Name sibling alternatives and say when to avoid this tool. A docs link supplements this explanation.
2. Explain semantics beyond types: units, defaults, omitted versus empty values, precedence, dependencies, mutually exclusive inputs, and what an unknown measurement does. Do not repeat every schema property in the overview.
3. State costs and external effects precisely. Distinguish an authorization from settlement, a catalog claim from a live observation, and a transport success from a usable result. Explain uncertainty without suggesting blind retries.
4. Trace each claim to its handler and shared parser. For these tools, review `pulse.preview_need`, `validate.validate_url`, `route.run_probe`, `policy.merge_constraints`, `select.parse_constraints` and `probe.probe_plan`. Review payment and evidence gates when changing billing language. Keep private admission policy and scoring methodology out of examples.
5. Keep the advertised schema, HTTP behavior and adapter capabilities aligned. Do not advertise an HTTP-only profile as an MCP argument unless the tool schema and supported client path expose it. Do not invent annotations or guarantees to improve a listing score.
6. Check real `tools/list` output for both supported protocol versions and its passage through the stdio adapter. Reuse focused behavioral tests for the constraints described; add a regression when documenting an uncovered interaction. Avoid tests that merely count description words or repeat implementation constants.

The [MCP tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) defines the wire contract. Glama's [tool-definition quality guidance](https://github.com/glama-ai/tool-definition-quality-score) is useful editorial feedback; a description score does not establish implementation correctness or payment safety.
