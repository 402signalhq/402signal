# 402Signal

**Signed proof of what your agent was offered before it paid.** 402Signal checks the endpoint, the price and the recipient at the moment of payment, on x402 and MPP, and gives you a third-party record you can verify offline. Your application keeps its wallet, signing authority and final payment decision.

A qualifying check costs **$0.003 USDC**, paid over x402 with the same wallet. Completed normal misses are not settled: a check that finds no qualifying offer is free. Opening a hosted session costs $0.005 and lets you reuse one observation for 20 hops or 10 minutes. Seller payment, channel funding and network costs are separate, and a check is not a guarantee of delivery or output quality. Platform plans are priced on receipts issued and records retained: see [pricing](https://402signal.com/pricing).

[Website](https://402signal.com/) · [Try a sample check](https://402signal.com/try) · [Developer guides](https://402signal.com/developers) · [Trust](https://402signal.com/trust) · [OpenAPI](https://402signal.com/openapi.json) · [MCP](https://402signal.com/mcp.json) · [Changelog](CHANGELOG.md) · [Security policy](SECURITY.md)

The service is also listed in third-party catalogues such as PayAPI Market (https://payapi.market/mcp); agents still pay https://402signal.com/route directly, and a listing is not an endorsement.

## Three doors

| You are | Start here | You get |
|---|---|---|
| A buyer or a platform embedding payments | [Add the check to your client](https://402signal.com/developers#route-binding) | Every payment checked as it is made; a receipt per qualifying check; alerts when a seller you depend on changes |
| A seller | [Find your host](https://402signal.com/endpoints) | Your listing as buyers see it, a readiness badge, and the same public numbers as everyone else |
| An auditor or compliance reviewer | [Verify a record](https://402signal.com/trust) | The receipt format, the public log, the anchor, and the [Offer Evidence Record](docs/evidence-record.md) specification |

## Start in a minute

**Official x402 client.** One hook adds the check before every seller payment. It pays the fee with your own wallet, re-reads the seller's challenge, verifies the signed receipt with your pinned log key, and aborts a payment whose terms differ from what was verified:

```sh
npm install @402signal/route-guard@0.7.4 && npm audit signatures
```

```js
import { signalGuard } from "@402signal/route-guard/x402";
client.onBeforePaymentCreation(signalGuard({ fetchWithPayment, trustedLogVkey }));
```

**mppx.** The same guard as an `onChallenge` hook: `import { mppGuard } from "@402signal/route-guard/mpp"`.

**Any language.** Ask for the checking-fee terms without paying anything, then resend the identical request with the payment authorization:

```sh
curl -sS -D - https://402signal.com/route \
  -H 'Content-Type: application/json' \
  --data '{"need":"web search","networks":["base"],"max_price_usd":0.02,"require_route_binding":true}'
```

The HTTP 402 lists the fee requirements on Base, Solana and Algorand. Use `url` for an exact endpoint or `need` to discover candidates; `networks` is a hard filter and `prefer_network` only ranks. Over MCP, call the `check` tool with the same arguments (`route`, its former name, is still accepted).

**Python.** `pip install 402signal` gives you the unpaid challenge, the paid check, read-only recovery and an offline receipt verifier (`signal402.verify.verify_route_receipt`).

**No wallet yet?** [Run a sample check in the browser](https://402signal.com/try) against a listed endpoint, ask for free check credits at ross@402signal.com (listed endpoints only), or run the offline checks with Node.js 22 or newer:

```sh
node integration/buyer-checks/run.mjs
```

The client and guard are published on npm with a provenance attestation and as GitHub release archives with checksums; from a reviewed checkout `node scripts/install_route_guard.mjs` downloads, verifies and installs the current release.

## What a check returns

| Result | Meaning |
|---|---|
| HTTP 402 before authorization | Checking-fee requirements; nothing has been checked yet |
| HTTP 200, `live: true` | A qualifying offer, `selected_payment`, `billing.settled: true`, and with `require_route_binding` a signed receipt to verify locally before signing |
| HTTP 200, `live: false` | A completed miss with a typed `miss_reason`; no fee |
| HTTP 503, `binding_error: route_binding_unavailable` | No probed candidate could be bound; a completed answer, not an outage. The reference wrap `wrapExactAuthorize` reports `state=binding_unavailable` with `keep_calling_route: true` |
| HTTP 503, other | Inspect `billing.settlement_state`: `not_attempted`, `settled` (fee settled, required evidence failed) or `unknown` (never reuse that authorization; use recovery) |
| HTTP 409, `authorization_already_used` | The same authorization was already final; the state and billing are disclosed, the private output is not |

Read `live`, `payable`, `selected_payment` and `billing` together. A settled fee is not reversed if the seller's offer later changes.

## Keys, credits and alerts

- **Check credits** (`X-402Signal-Trial`): operator-issued, listed endpoints only, for evaluation without a funded wallet.
- **Admission keys** (`X-402Signal-Key`): agreed ingress and capacity for platforms; never a wallet key.
- `GET /keys/usage` answers only for the credentials you present: remaining credits, ceiling, expiry, or the key's recognized capacity.
- **Change alerts**: with a key, `POST /alerts` subscribes a public HTTPS webhook to up to 20 seller hosts and delivers signed `price_changed`, `recipient_changed` and `liveness_changed` events drawn from the same public observations the endpoint pages count. Guide: [docs/customer/alerts.md](docs/customer/alerts.md).

## Evidence

Every qualifying check with `require_route_binding` returns an Ed25519-signed receipt bound to the exact URL, method, body hash and the seller's current x402 envelope, with an inclusion proof in an append-only log whose checkpoints are anchored on Algorand MainNet with a Falcon-1024 signature. Clients that need later verification must securely retain the complete paid `/route` response, including `pq_trust.transparency.receipt` and `pq_trust.transparency.reveal`, together with the original request. Private replay outcomes are short-term recovery, not long-term evidence storage. The reveal contains private request and decision evidence; do not put it in public logs.

The record format is documented as the [Offer Evidence Record, version 1](docs/evidence-record.md), with a [draft x402 extension proposal](docs/proposals/offer-evidence-extension.md). Verify a saved record with `verifyReceipt` from the guard, with the Python package, or in the browser at [402signal.com/verify](https://402signal.com/verify); inspect the public log at [402signal.com/transparency](https://402signal.com/transparency).

## What is in this repository

| Path | Contents |
|---|---|
| `live402/` | The hosted service: check pipeline, replay authority, keys and alerts, MCP server, transparency log |
| `sdk/route-guard/` | Zero-dependency Node client and offline verifier, plus the `x402` and `mpp` client hooks |
| `sdk/python/` | The `402signal` Python package: challenge, check, recovery and offline verification |
| `integration/` | Reference buyer, MPP clients, offline buyer checks, MCP interoperability tests and the controlled lab |
| `docs/` | Contracts, the evidence-record specification, operating procedures and the [documentation index](docs/README.md) |
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
