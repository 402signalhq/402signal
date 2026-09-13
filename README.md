# 402Signal

**The pre-flight check for agent payments.** Before your agent pays an x402 or MPP endpoint, 402Signal confirms the endpoint is live, confirms the price and recipient it is about to accept, and gives you a signed record of what it saw. Your application keeps its wallet, signing authority and final payment decision.

A qualifying check costs **$0.003 USDC**, paid over x402 with the same wallet. Completed normal misses are not settled: a check that finds no qualifying offer is free. Opening a hosted session costs $0.005 and lets you reuse one observation for 20 hops or 10 minutes. Seller payment, channel funding and network costs are separate, and a check is not a guarantee of delivery or output quality.

[Website](https://402signal.com/) · [Developer guides](https://402signal.com/developers) · [OpenAPI](https://402signal.com/openapi.json) · [MCP](https://402signal.com/mcp.json) · [Changelog](CHANGELOG.md) · [Security policy](SECURITY.md)

The service is also listed in third-party catalogues such as PayAPI Market (https://payapi.market/mcp); agents still pay https://402signal.com/route directly, and a listing is not an endorsement.

## Start in a minute

Ask for the checking-fee terms without paying anything:

```sh
curl -sS -D - https://402signal.com/route \
  -H 'Content-Type: application/json' \
  --data '{"need":"web search","networks":["base"],"max_price_usd":0.02,"require_route_binding":true}'
```

The HTTP 402 lists the fee requirements on Base, Solana and Algorand. Authorize the fee once with an x402-capable client and resend the identical request. Use `url` for an exact endpoint or `need` to discover candidates; `networks` is a hard filter and `prefer_network` only ranks.

**Already on the official x402 client?** One hook adds the check before every seller payment. It pays the fee with your own wallet, re-reads the seller's challenge, verifies the signed receipt with your pinned log key, and aborts a payment whose terms differ from what was verified:

```js
import { signalGuard } from "@402signal/route-guard/x402";
client.onBeforePaymentCreation(signalGuard({ fetchWithPayment, trustedLogVkey }));
```

**No wallet yet?** Ask for free check credits at ross@402signal.com (listed endpoints only), or run the offline checks with Node.js 22 or newer:

```sh
node integration/buyer-checks/run.mjs
```

The client and guard are published as GitHub release archives with checksums; from a reviewed checkout `node scripts/install_route_guard.mjs` downloads, verifies and installs the current release. npm publication with provenance is set up in `.github/workflows/publish-npm.yml`.

## What a check returns

| Result | Meaning |
|---|---|
| HTTP 402 before authorization | Checking-fee requirements; nothing has been checked yet |
| HTTP 200, `live: true` | A qualifying offer, `selected_payment`, `billing.settled: true`, and with `require_route_binding` a signed receipt to verify locally before signing |
| HTTP 200, `live: false` | A completed miss with a typed `miss_reason`; no fee |
| HTTP 503, `binding_error: route_binding_unavailable` | No probed candidate could be bound; a completed answer, not an outage. The reference wrap `wrapExactAuthorize` reports `state=binding_unavailable` with `keep_calling_route: true` |
| HTTP 503, other | Inspect `billing.settlement_state`: `not_attempted`, `settled` (fee settled, required evidence failed) or `unknown` (never reuse that authorization; use recovery) |

Read `live`, `payable`, `selected_payment` and `billing` together. A settled fee is not reversed if the seller's offer later changes.

## Evidence

Every qualifying check with `require_route_binding` returns an Ed25519-signed receipt bound to the exact URL, method, body hash and the seller's current x402 envelope, with an inclusion proof in an append-only log whose checkpoints are anchored on Algorand MainNet with a Falcon-1024 signature. Clients that need later verification must securely retain the complete paid `/route` response, including `pq_trust.transparency.receipt` and `pq_trust.transparency.reveal`, together with the original request. Private replay outcomes are short-term recovery, not long-term evidence storage. The reveal contains private request and decision evidence; do not put it in public logs.

Verify a saved record with `verifyReceipt` from the guard, or inspect the public log at [402signal.com/transparency](https://402signal.com/transparency).

## What is in this repository

| Path | Contents |
|---|---|
| `live402/` | The hosted service: router, probe pipeline, replay authority, MCP server, transparency log |
| `sdk/route-guard/` | Zero-dependency Node client and offline verifier, plus the `x402` client hook |
| `integration/` | Reference buyer, MPP clients, offline buyer checks, MCP interoperability tests and the controlled lab |
| `docs/` | Contracts, operating procedures and the [documentation index](docs/README.md) |
| `ops/`, `scripts/` | Database migrations, load test, report and release tooling |

## Develop

Python 3.12.14 and Node 24, matching CI. Fixture mode keeps every catalog and seller response synthetic; no test needs a wallet, a facilitator or the network.

```sh
python3 -m pip install --require-hashes -r requirements.txt
LIVE402_FIXTURE=1 PYTHONPATH=. python3 -m live402          # http://127.0.0.1:8081
LIVE402_FIXTURE=1 PYTHONPATH=. python3 -m unittest discover -s tests
npm --prefix sdk/route-guard test
```

`LOCAL_FREE=1` skips the paywall for local development and must never be set in production. See [CONTRIBUTING.md](CONTRIBUTING.md) for branches, reviews and the release train, and the [documentation index](docs/README.md) for the replay authority, readiness, backups and scaling plans. Historical TestNet broadcasting is a `402signal (router) env` capability: a security review must approve before anyone sets it to `1`. Signer never reads BROADCAST, and the flag does not enable MainNet anchoring, which has its own reviewed [runbook](docs/pq-automatic-anchoring.md).

## Contact

[MIT license](LICENSE) · [Security reports](SECURITY.md) · [ross@402signal.com](mailto:ross@402signal.com) · [@402Signal](https://x.com/402Signal)
