# Contributing

Contributions are welcome to the public clients, verification contracts, buyer adapters, examples and documentation. Keep payment authority in buyer-owned code and preserve compatibility with published receipts and package contracts.

## Work locally

Use the runtime and lockfile declared by the package you change. The stdio MCP adapter requires Python 3.12 or later and only the standard library:

```sh
python -m unittest discover -s tests -p test_glama_stdio.py
```

For the JavaScript guard, follow its [package guide](sdk/route-guard/README.md). For the Python client, follow [its development instructions](sdk/python/README.md). Integration packages document their own build and test commands; start with the [offline buyer checks](integration/buyer-checks/README.md) when working on a buyer callback.

The root Dockerfile builds only the MCP stdio adapter. It forwards to the hosted service; it does not start a local routing backend. Adapter tests use local responses and need no wallet, payment or service credentials.

## Submit a change

- Explain the concrete behavior that changes and how you checked it.
- Preserve published wire formats, strict parsing, signed commitment domains and independently pinned verification keys. Treat compatibility changes explicitly.
- Keep examples and fixtures synthetic. Never include private keys, payment headers, recovery keys, admission tokens or customer evidence.
- Test refusals and recovery boundaries when changing buyer authorization logic. An unknown payment result must not become permission to pay again.
- Keep changes to MCP forwarding transparent: hosted names, descriptions, schemas, annotations and result payloads must not be rewritten.
- Use private [security reporting](SECURITY.md) for an unfixed vulnerability.

Changes to hosted-service behavior should describe the expected public API behavior and a safe reproduction. The hosted deployment and its operational configuration are maintained separately.
