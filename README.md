# 402Signal

Check a paid API's current offer against your buyer's rules, verify the evidence before signing, and keep a record of the decision. 402Signal supplies a hosted offer check, an offline guard and optional buyer clients for named x402 and MPP profiles. Your application keeps its wallet, signing authority and final payment decision.

A qualifying hosted observation costs **$0.003 USDC**. Completed normal misses are not settled. Seller payment, channel funding and network costs are separate. The observation does not guarantee delivery or output quality.

[Website](https://402signal.com/) · [Choose an integration](https://402signal.com/developers) · [Customer guide index](docs/customer/README.md) · [Free catalog](https://402signal.com/catalog) · [OpenAPI](https://402signal.com/openapi.json) · [MCP](https://402signal.com/mcp.json)

## Building or testing a payment client?

Start without a funded wallet. From a reviewed checkout, use Node.js 22 or newer:

```sh
node integration/buyer-checks/run.mjs
node integration/buyer-checks/run.mjs --self-test
```

The real exact-x402 verifier runs against synthetic Base evidence. A matching offer must reach the fake callback once; changed price, recipient, request or expiry must stop it. The historical cases show an original saved record verifying and an edited policy failing verification. The default test run makes no external request and supplies no wallet.

[Connect your own trusted callback](integration/buyer-checks/README.md) to test your integration, rather than only running our library tests. The harness measures its supplied callback; custom adapter code is trusted, not sandboxed. Keep production credentials and networking out of the test environment. A reference pass is not proof that your signing path is correctly connected or that a merchant will settle.

Coding agents can load the [optional buyer-checks skill](skills/402signal-buyer-checks/SKILL.md) through their host's supported process. It is task guidance, not permission to install globally or spend. An ordinary free API call does not need a paid 402Signal route.

## Selling an API?

Search by the capability a buyer asks for. Inspect your exact listing, price units, network, schema and source. Then run free readiness validation for an exact catalog-listed HTTPS endpoint.

The [seller guide](docs/customer/sellers.md) explains how to compare seller claims with an unpaid observation. An unlisted URL is not probed. This does not establish token-account existence, settlement, delivery, uptime, adoption or market share. It is a useful development diagnostic, not an unrestricted scanner or a ranking guarantee.

## Check an offer before signing

Send a capability or exact API URL with your buyer's constraints. The hosted API observes the supported current offer and returns a qualifying route or an explicit reason to stop. Request `require_route_binding=true` and integrate the local guard for buyer-side comparison before signing.

```sh
curl -sS -D - https://402signal.com/route \
  -H 'Content-Type: application/json' \
  --data '{"need":"web search","networks":["base"],"max_price_usd":0.02,"require_route_binding":true}'
```

This unpaid request returns HTTP 402 with the checking-fee requirements. Validate those requirements and your budget in the buyer, authorize the $0.003 fee once, and submit the identical request with the resulting payment header. Never send a wallet private key to the service.

For an existing endpoint, use `url` instead of `need`. `networks` is a hard filter. `prefer_network` only affects ranking within that filter. Unknown measurements do not satisfy required bounds. HTTP probe time is not settlement latency. The [developer guide](https://402signal.com/developers#route-binding) and [OpenAPI](https://402signal.com/openapi.json) define the actual request and response contracts.

## Choose the component that fits

| Task | Guide | Important boundary |
|---|---|---|
| Find candidates | [Preview and catalog](https://402signal.com/catalog) | No new seller probe |
| Check a listed endpoint | [Seller readiness](docs/customer/sellers.md) | Catalog-listed exact URL only; no signed routing evidence |
| Check an exact x402 purchase | [Guard and client](sdk/route-guard/README.md) | Buyer still validates transactions and owns the wallet |
| Compose a complete buyer | [Reference buyer](integration/reference-buyer/README.md) | Planning, durable limits, signing and execution are buyer-owned |
| Select a native Base MPP charge | [Native Base guide](integration/mpp-client/NATIVE.md) | Base USDC EIP-3009; not all EVM methods |
| Select a native Algorand charge | [Native Algorand guide](integration/mpp-algorand/README.md) | Explicit supported transaction and fee profile |
| Use x402 through mppx | [Gateway adapter](integration/mpp-client/README.md) | Separate from native MPP |
| Continue a funded session | [Session Client](integration/session-client/README.md) | Fixed buyer policy; no automatic top-up or new observation |
| Pay a group or invoice | [Algorand manifests](docs/algorand-manifests-v2.md) | Explicit merchant manifest; job/payment counts differ |
| Use MCP | [MCP adapter](integration/mcp/README.md) | Actual manifest inputs only; credential-free stdio cannot complete paid routing |
| Review an old check | [Evidence and oversight](docs/customer/evidence.md) | Retained observation, not all agent actions or new payment authority |

Use the exact reviewed archive and published digest from [GitHub Releases](https://github.com/402signalhq/402signal/releases). A package name does not imply npm registry publication. The guard requires Node 22 or newer; reference and session clients have their own Node24 and private POSIX-storage requirements. A source checkout, published archive, enabled hosted profile and successful external merchant campaign are different facts.

Use `RouteClient` to retain an attempt before submission and `withVerifiedRoute` before the buyer's own signing callback. The offline guard does not sign or implement a wallet. Optional buyer clients orchestrate their documented lifecycle through customer-supplied components; do not assume every client is offline merely because the guard is.

Customer access keys identify a workload, not a wallet. Keep them, payment authorizations and private attempt stores confidential.

## Supported requests and funding scope

Exact x402 observations cover supported offers across Base, Solana and Algorand. The ordinary request path uses GET, with a narrowly justified empty-object POST fallback. The opt-in `parallel-search-json-v1` profile accepts an exact bounded body only at its named endpoint. It is not an arbitrary POST proxy. See the [exact-request contract](docs/proof-carrying-route-v1.md).

Native MPP charge selection preserves the complete original offer and requires one match under pinned profile and buyer requirements. Do not select by response order, discard alternate terms from the original evidence or fall back to another offer after signing fails.

Base batch and Solana push-session clients separate the initial observation from a separately approved continuation policy. Current controller bounds are 1 to 64 sequential calls and a deadline up to 24 hours. They are not throughput promises or proof of a 24-hour external campaign. Base receiver/token activity remains serialized. An uncertain operation stops subsequent calls.

Larger Algorand groups cover 2 to 15 job payments plus sponsorship. Aggregate invoices cover 2 to 64 explicit jobs represented by one invoice payment plus sponsorship. The aggregate invoice does not establish individual job price allocation. The earlier two-item profile remains a distinct contract. On-chain atomicity is not atomic HTTP delivery.

The hosted router observes one explicitly requested batch/session API. It does not deposit capital, aggregate seller payments or issue vouchers. The checking fee is separate from merchant economics. See the [batch contract](docs/batch-observation-v1.md), [buyer adapters](integration/batch-buyer/algorand/README.md) and [dated controlled qualification](integration/lab/BATCH_QUALIFICATION.md). Do not treat that earlier bounded qualification as universal or as evidence for every newer continuation profile.

## Outcomes, recovery and evidence

Read `live`, `payable`, `selected_payment` and `billing` together. HTTP 200 alone does not authorize a seller payment.

| Result | Meaning |
|---|---|
| HTTP 402 before authorization | Checking-fee requirements; no paid check yet |
| Completed normal miss, HTTP 200 | `live:false`, `payable:false`, `selected_payment:null`, `billing.settlement_state=not_attempted`; no checking-fee settlement |
| Qualifying result, HTTP 200 | Eligible observed offer and explicit billing; buyer still validates before paying the seller |
| Operational or uncertain failure, HTTP 503 | Inspect `billing.settlement_state`; it can be unattempted, settled before required evidence failed, or unknown |

A later refusal does not reverse an already-settled observation fee. Never interpret a lost response as proof of nonpayment. Recover the original attempt before considering another authorization. The [recovery contract](docs/route-recovery.md) uses the original request, authorization and private credential. It preserves the original outcome and expiry rather than retrying an uncertain payment.

Clients that need later verification must securely retain the complete paid `/route` response, including `pq_trust.transparency.receipt`, `pq_trust.transparency.reveal` and the original request. Private replay outcomes are short-term recovery, not long-term evidence storage. The reveal contains private request and decision evidence; do not put it in public logs.

Compare the retained observation with separately retained operator-approved policy and wallet records. It records what was submitted and checked, not everything the agent did or proof of human approval. It cannot reveal bypassed purchases or recover deleted private evidence.

Immediate Ed25519 receipts and later cumulative MainNet anchors are distinct. Falcon-1024 authorizes checkpoint transactions on Algorand. The local historical receipt verifier does not verify those later anchors. Post-quantum checkpoint authorization is an additional integrity control, not a blanket claim for every receipt, hash assumption, or seller payment. See [Trust](https://402signal.com/how#trust), [Transparency](https://402signal.com/transparency), and [evidence contracts](docs/README.md#protocol-and-evidence).

## Develop and operate

Use an isolated environment with Python 3.12 and the hash-locked dependencies. Fixture mode keeps catalog and seller responses synthetic.

```sh
python3 -m pip install --require-hashes -r requirements.txt
LIVE402_FIXTURE=1 PYTHONPATH=. python3 -m live402
LIVE402_FIXTURE=1 PYTHONPATH=. python3 -m unittest discover -s tests -v
```

The development server defaults to `127.0.0.1:8081`. `LOCAL_FREE=1` is a test-only bypass and must never be enabled in production. The [lab](integration/lab/README.md) provides controlled buyer/seller scenarios. Synthetic tests and live payment evidence are reported separately.

PostgreSQL replay authority supplies durable payment identities across processes. Catalog/history and ordered transparency writes retain the documented single-writer boundary. Shared replay storage is not proof of horizontal capacity or millions of requests per day. Follow the [managed PostgreSQL runbook](docs/runbooks/managed-postgres-functions.md), [readiness checks](docs/fly-ready-check.md), [backup guide](docs/backup.md) and [scaling plan](docs/scale-20m.md). Never replace uncertain authority with a stale backup or unfenced SQLite source.

Production admission policy, customer identities and live limits remain private operator configuration. Historical observation metadata is not a promise of future reliability or proof of adoption. See [admission operations](docs/admission-operations.md).

The [documentation index](docs/README.md) separates current contracts from historical release gates. Preserve economic identities, signed history and recovery material during upgrades. Historical TestNet broadcasting is a `402signal (router) env` capability: 402security must GO before anyone sets it to `1`. Signer never reads BROADCAST. This historical flag does not enable MainNet; use the separate reviewed [MainNet anchoring runbook](docs/pq-automatic-anchoring.md).

## Repository and contact

`live402/` contains the service. `sdk/route-guard/` contains local verification and the HTTP client. `integration/` contains buyer packages, offline checks, MCP and controlled lab code. `docs/`, `ops/` and `scripts/` contain contracts and reviewed operating procedures.

[MIT license](LICENSE) · [Private security contact](https://402signal.com/contact#security) · [ross@402signal.com](mailto:ross@402signal.com)
