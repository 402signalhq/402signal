# 402Signal

402Signal checks x402 routes across Base, Solana, and Algorand before spending. $0.003 only when a valid live route is found. Normal typed misses are not settled. Seller payment is separate. Your agent keeps the wallet. Routing evidence enters the PQ Trust log on Algorand MainNet. Optional require_route_binding=true adds a signed v4 receipt for buyer-side comparison with current seller terms before signing. Guide: https://402signal.com/developers#route-binding

[Website](https://402signal.com/) · [Developer guide](https://402signal.com/developers) · [Free catalog](https://402signal.com/catalog) · [OpenAPI](https://402signal.com/openapi.json) · [MCP](https://402signal.com/mcp.json)

## Check an offer before signing

Send a capability or an exact API URL with your buyer's constraints. 402Signal observes the endpoint's current payment offer, applies those constraints, and returns a qualifying route or a typed miss. Your application keeps its wallet, validates the actual transaction and decides whether to purchase from the seller.

- **Explore:** catalog search and preview are free. They do not perform a new live endpoint check.
- **Observe:** a qualifying API observation costs $0.003 USDC. Completed normal misses are not settled.
- **Verify:** request bound evidence and integrate the buyer guard to compare the exact request and fresh offer before your own payment code signs.
- **Keep evidence:** retain the private verification record so you can check its integrity later.

Seller payment, network fees and any channel funding are separate. The routing fee pays for the observation even if you decline the seller's offer afterward. A later guard rejection does not reverse a settled routing fee. An observation does not guarantee delivery or output quality; 402Signal does not hold buyer funds, operate escrow or decide disputes.

## Start with an unpaid request

```sh
curl -sS -D - https://402signal.com/route \
  -H 'Content-Type: application/json' \
  --data '{"need":"web search","networks":["base"],"max_price_usd":0.02,"require_route_binding":true}'
```

An unpaid call returns HTTP 402 with the current routing payment requirements. Validate those requirements and your budget in the buyer, then authorize the $0.003 USDC fee with your own wallet. Submit the identical request with the resulting payment header. Never send a wallet private key to the service.

For an existing integration, use `url` instead of discovery. `networks` is a hard filter when supplied; omit it to search all supported rails. `prefer_network` only affects ranking within that filter. Unknown measurements do not satisfy required limits. The [developer guide](https://402signal.com/developers#request) and [OpenAPI schema](https://402signal.com/openapi.json) define supported fields and response semantics.

## Install the buyer client

The [v0.5.0 release](https://github.com/402signalhq/402signal/releases/tag/route-guard-v0.5.0) contains the Node/TypeScript client, private attempt store and offline guard. Download the [verified archive](https://github.com/402signalhq/402signal/releases/download/route-guard-v0.5.0/402signal-route-guard-0.5.0.tgz) and check its published digest before installing. Node.js 22 or newer is required; this is a release tarball, not an npm registry publication.

```sh
npm install ./402signal-route-guard-0.5.0.tgz
```

Use `RouteClient` to retain an attempt before submission, then `withVerifiedRoute` immediately before the buyer's own signing callback. The guard checks signed evidence, exact request identity, current seller terms and expiry against an independently trusted log key. It does not sign transactions or implement a wallet.

- [Client, guard and recovery API](sdk/route-guard/README.md)
- [Reference buyer and useful external workflows](integration/reference-buyer/README.md)
- [x402 gateway adapter for mppx](integration/mpp-client/README.md)
- [MCP adapter](integration/mcp/README.md)

Customer access keys identify a 402Signal integration or workload class. They are not wallet private keys. Keep access credentials, payment authorizations and attempt stores private.

## Supported requests and batch scope

Exact x402 observations cover Base, Solana and Algorand. The ordinary request path uses GET, with a narrowly justified empty-object POST fallback. The opt-in `parallel-search-json-v1` profile accepts an exact, bounded JSON search request only at `https://parallelmpp.dev/api/search`. Its body is bound to the observation and is not broadcast through discovery. This is not an arbitrary POST proxy. See the [exact-request contract](docs/proof-carrying-route-v1.md).

**Batch and session support:** the published v0.5 client includes a separate v5 guard for the profiles below. Controlled MainNet tests are complete for the profiles below, including merchant payments and independently confirmed settlement. These examples use owner-operated lab endpoints with explicit limits.

| Profile | Supported scope | Buyer responsibility |
|---|---|---|
| Base EVM batch settlement | Explicit channel terms, recipient and buyer caps | Validate funding, vouchers and eventual payout independently; voucher acceptance is not on-chain settlement |
| Solana native MPP push sessions | A supported channel, operator and recipient | Own opening, voucher signing, fees/rent and closing; no claim of cross-channel batch settlement |
| Algorand two-item atomic grouping | One exact HTTPS GET API, two USDC payments to one recipient, explicit item/total caps and job hashes | Validate the full group and sponsor terms; atomic chain execution does not promise atomic HTTP delivery |

The router observes one explicitly requested API; it does not aggregate seller payments, deposit capital or issue vouchers. The $0.003 observation fee is separate from merchant economics. The [batch contract](docs/batch-observation-v1.md), [Algorand buyer adapter](integration/batch-buyer/algorand/README.md) and [lab qualification guide](integration/lab/BATCH_QUALIFICATION.md) describe the bounded mechanisms and the controlled live test scope. The x402 mppx gateway adapter is separate from native MPP sessions.

## Outcomes, recovery and evidence

Read `live`, `payable`, `selected_payment` and `billing` together. HTTP 200 alone does not authorize a seller payment.

| Result | Meaning |
|---|---|
| HTTP 402 before authorization | The routing payment requirements; no paid check yet |
| Completed normal miss, HTTP 200 | `live:false`, `payable:false`, `selected_payment:null`, `billing.settlement_state=not_attempted`; no routing settlement |
| Qualifying result, HTTP 200 | Current eligible offer and explicit routing billing outcome; the buyer still decides and validates before seller payment |
| Operational or uncertain failure, HTTP 503 | Inspect `billing.settlement_state`; settlement may be unattempted, settled before an evidence failure, or unknown |

Never interpret a lost response as proof that no payment occurred. Recover the original attempt before considering a new authorization. The [private response recovery contract](docs/route-recovery.md) uses the same request, payment authorization and private replay credential; recovery preserves the original outcome and expiry. It does not retry an uncertain payment.

Clients that need later verification must securely retain the complete paid `/route` response, including `pq_trust.transparency.receipt`, `pq_trust.transparency.reveal` and the original request. Private replay outcomes are short-term recovery, not long-term evidence storage. The reveal contains private request and decision evidence; do not put it in public logs.

Immediate signed receipts and later cumulative MainNet anchors are distinct. The public log contains commitments rather than full private records. Falcon-1024 authorizes the checkpoint transaction; it does not secure seller payments. Inspect [Transparency](https://402signal.com/transparency) and the [evidence contracts](docs/README.md#protocol-and-evidence).

## Develop and operate

Use an isolated development environment with Python 3.12 and the hash-locked dependencies. Fixture mode keeps the catalog and seller responses synthetic.

```sh
python3 -m pip install --require-hashes -r requirements.txt
LIVE402_FIXTURE=1 PYTHONPATH=. python3 -m live402
LIVE402_FIXTURE=1 PYTHONPATH=. python3 -m unittest discover -s tests -v
```

The development server defaults to `127.0.0.1:8081`. `LOCAL_FREE=1` is a test-only bypass and must never be enabled in production. The [lab](integration/lab/README.md) provides controlled buyer/seller scenarios; synthetic qualification and live payment evidence are reported separately.

PostgreSQL replay authority provides durable payment identities across processes. Catalog/history and ordered transparency writes still require the documented single-writer boundary. A shared replay database is not proof of horizontal capacity or millions of requests per day. Follow the [managed PostgreSQL runbook](docs/runbooks/managed-postgres-functions.md), [readiness checks](docs/fly-ready-check.md), [backup guide](docs/backup.md) and [scaling plan](docs/scale-20m.md). Never replace an uncertain authority with a stale backup or unfenced SQLite source.

Production admission policy, customer identities and live policy limits stay in private operator configuration. Public historical observation metadata is not a promise of future reliability or proof of customer adoption. See [admission operations](docs/admission-operations.md).

The [documentation index](docs/README.md) separates current contracts from historical release gates. Preserve economic identities, signed history and recovery material during upgrades. Historical TestNet broadcasting is a `402signal (router) env` capability: 402security must GO before anyone sets it to `1`. Signer never reads BROADCAST. This historical flag does not enable MainNet; use the separate reviewed [MainNet anchoring runbook](docs/pq-automatic-anchoring.md).

## Repository and contact

| Path | Purpose |
|---|---|
| `live402/` | Router, discovery, probing, payment verification and evidence |
| `sdk/route-guard/` | Buyer client and local evidence verification |
| `integration/` | Reference buyers, MCP adapter and controlled lab |
| `tests/` | Synthetic functional and security regressions |
| `docs/`, `ops/`, `scripts/` | Protocol contracts and reviewed operating tools |

[MIT license](LICENSE) · [Private security contact](https://402signal.com/contact#security) · [ross@402signal.com](mailto:ross@402signal.com)
