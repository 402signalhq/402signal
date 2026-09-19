# 402Signal

**Endpoint selection. Buyer protection. Verifiable records.**

402Signal helps an automated buyer choose a paid API that fits its task and purchase rules, check the current offer, and retain evidence of the decision. Connect it before your existing payment client signs. Your wallet keeps control of funds and authorization.

| Start with | What 402Signal does |
|---|---|
| A task and criteria | Discover candidates, compare current offers against your budget and allowed networks, and select from the eligible candidates evaluated. |
| An endpoint URL | Check that service's current offer against your purchase rules. |

A qualifying check costs **$0.003 USDC**, including discovery when needed, current-offer comparison and selection, and bound evidence when requested on a supported profile. Completed normal misses are free. Seller payments and network costs are separate. Selection is bounded by the candidates checked; it does not establish a whole-market optimum.

Use the local guard to verify the signed record against your original request and the current seller offer before your authorization callback runs. Local verification and reuse within the guard's validity limits do not require a second paid check. The signed record supports later review of the recorded criteria, selected terms and decision evidence; it does not guarantee seller delivery or output quality.

[How it works](https://402signal.com/how) · [Developer guides](https://402signal.com/developers) · [Supported profiles](https://402signal.com/developers/supported-profiles) · [Pricing](https://402signal.com/pricing) · [Trust and verification](https://402signal.com/trust)

## Start here

1. [Choose a service](https://402signal.com/developers/choose-service) with a task, budget, allowed networks and selection priority, or [check a known endpoint](https://402signal.com/developers/check-offer).
2. Request bound evidence on the matching supported profile. Verify the response with your original request and independently pinned log key.
3. Let your own payment client enforce wallet policy and authorize the seller payment. Retain the private evidence, payment records and delivery result separately.

```sh
npm install @402signal/route-guard@0.7.7
npm audit signatures
```

The [JavaScript quickstart](https://402signal.com/developers/check-offer) connects the guard to an existing x402 client with an explicit network and price cap. The [route-guard package](sdk/route-guard/README.md) also exposes offline verification and caller-owned authorization helpers. For receipt verification and bounded HTTP requests in Python:

```sh
pip install 402signal==0.1.2
```

The [Python client](sdk/python/README.md) does not sign or pay. Try the [offline buyer checks](integration/buyer-checks/README.md) without a wallet, or use the [free readiness check](https://402signal.com/try) to inspect a listed endpoint's unpaid response.

## MCP

Connect a Streamable HTTP client to **https://402signal.com/mcp/v0.3.1**. The hosted tools are `check`, `preview` and `validate`. Preview and validation are free; paid checks require an x402-capable HTTP client and explicit payment authority.

For a stdio host, run `python scripts/glama_stdio.py` with Python 3.12 or later. This small adapter forwards requests to the hosted service. It has no third-party Python dependencies, does not sign or submit payments, and reports paid challenges as tool errors. See [MCP integration](docs/mcp.md) and [Glama configuration](docs/glama-release.md).

## What is in this repository

| Path | Purpose |
|---|---|
| [sdk/route-guard](sdk/route-guard/README.md) | JavaScript receipt and offer verification, payment-client hook and recovery helpers |
| [sdk/python](sdk/python/README.md) | Python HTTP client and offline receipt verifier |
| [integration](docs/README.md#integration-packages) | Buyer-owned reference clients, supported payment adapters and offline checks |
| [protocol](protocol/README.md) | Public contract snapshots, receipt/checkpoint primitives and independent anchor-verification instructions |
| [docs](docs/README.md) | Integration guides, record formats, recovery and compatibility boundaries |
| [scripts/glama_stdio.py](scripts/glama_stdio.py) | Standard-library stdio adapter for the hosted MCP endpoint |
| [tests/fixtures/mcp](tests/fixtures/mcp/README.md) | Published MCP tool contracts for forwarding tests |

The hosted routing service operates at [402signal.com](https://402signal.com). This repository contains public clients, adapters and verification contracts; it is not a self-hosted deployment of that service. Published client release assets and package versions have their own identities; check [capabilities](https://402signal.com/capabilities.json) for current install pins and digests.

## Evidence and payment boundaries

The immediate receipt uses an Ed25519 checkpoint and inclusion proof. A later cumulative Algorand Falcon checkpoint is separate evidence; pending is not confirmed. Public log entries contain salted commitments, not your private request or complete purchase history. Keep your own original request, receipt and private reveal: private response recovery is limited to 120 seconds from the original request start.

Supported fee-payment networks, seller-observation profiles and buyer signing adapters are different capabilities. Check the [current compatibility guide](https://402signal.com/developers/supported-profiles) before choosing a rail. A chain appearing in a seller offer does not imply that every scheme, asset or wallet is supported.

The guard complements wallet policy. It does not custody funds, insure purchases, promise refunds, certify a seller, or force a compromised buyer runtime to obey its checks. Never create a new payment automatically after an uncertain result; reconcile the original attempt first.

## Contribute and report issues

See [CONTRIBUTING.md](CONTRIBUTING.md) for local validation and [SECURITY.md](SECURITY.md) for private vulnerability reporting. The root [MIT license](LICENSE) applies except where a package supplies its own license. The JavaScript and Python SDKs include their Apache-2.0 licenses and notices; check the license in the package you use.
