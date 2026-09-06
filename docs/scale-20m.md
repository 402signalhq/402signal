# 20M/day scale architecture

Status: implementation plan. Current production behavior is unchanged until each phase is explicitly deployed.

## Objective

Prepare 402Signal to sustain approximately 20,000,000 logical routing attempts per day without changing its product contract:

- the buyer keeps its wallet, private keys, signing authority, seller payment, and execution;
- 402Signal checks candidate x402 services immediately before spend;
- a normal typed miss costs $0;
- a successful confirmed route costs $0.003 USDC;
- seller payment remains separate;
- optional PQ transparency / route-binding evidence remains available;
- no second economic action is allowed after an ambiguous settlement outcome.

20,000,000 requests/day is 231.48 requests/second on average. Capacity planning must target at least 5x average burst traffic (~1,158 requests/second) and must size downstream probes separately from incoming requests.

## Current-budget rule

Until real external demand justifies expansion, total recurring infrastructure spend should remain at or below $100/month across application hosting, database/storage, monitoring, and chain/RPC providers. Do not provision dedicated high-throughput infrastructure preemptively.

The scale architecture must therefore be feature-flagged and incrementally deployable. Current low-volume production may remain a single writer while the shared-state path is implemented and tested.

## Target architecture

### 1. Stateless API tier

The public HTTP/MCP tier should become horizontally replaceable. It may validate requests, enforce abuse controls, perform routing orchestration, and return results, but it must not own globally authoritative payment-safety state in process memory or on a machine-local volume.

Target characteristics:

- multiple identical API instances can serve the same route authorization safely;
- request identity and replay decisions are resolved through one shared durable authority;
- API instances may be added or removed without changing economic correctness;
- per-IP controls remain for abuse, while commercial quotas can additionally key on integration/wallet identity;
- local process caches are advisory only.

### 2. Shared replay / settlement authority

The existing replay ledger is the first mandatory scale boundary. Before more than one paid-routing writer is enabled, authorization fingerprints and settlement states must move behind a shared transactional store.

Required invariants:

- UNIQUE authorization identity is global across all API instances;
- states remain settlement_pending, unknown, settled, not_settled, rejected;
- unknown and pending never authorize a second economic action;
- response recovery remains private and bounded;
- raw payment material is never persisted;
- durable uniqueness outlives response-cache expiry;
- failover must not create a second facilitator POST;
- storage-capacity failure remains fail-closed.

A low-cost hosted SQLite-compatible service (for example Turso/libSQL) is a reasonable first shared-store candidate because it can start below the $100/month current budget and preserves SQLite-like semantics. It is not a permanent cost commitment: at hundreds of millions of monthly writes, usage pricing must be re-evaluated against Postgres or another strongly consistent store.

Do not enable multi-writer routing merely because a remote database is reachable. The exact reserve/finish/unknown state machine and concurrent duplicate tests must pass first.

### 3. Probe worker pool

Incoming API concurrency and outbound merchant probing must be separated logically so one slow seller cannot occupy all route capacity.

Target behavior:

- bounded global probe concurrency;
- bounded per-host concurrency;
- absolute request deadlines preserved;
- SSRF/DNS protections preserved;
- candidate ranking happens before expensive probing;
- standard requests probe a small first tranche and expand only when needed;
- no stale cached success is substituted for a required current payment-term check;
- equivalent in-flight observations may be coalesced only when request context, seller target, and freshness requirements are demonstrably identical.

At 20M logical attempts/day, 3-7 probes per route implies 60M-140M outbound probes/day. The worker pool must therefore be sized by observed seller latency, not simply by HTTP request rate.

### 4. Catalog/read path

Catalog discovery, normalized metadata, and historical reliability reads should be independently cacheable and should not share the hottest write path with replay protection.

Suggested split:

- local/in-memory read cache for catalog snapshots;
- durable shared catalog source or replicated snapshot artifact;
- asynchronous catalog refresh;
- live probing remains authoritative for spend-time terms.

### 5. Transparency log

Paid route success and PQ evidence must stay decoupled from Algorand anchoring latency.

Target design:

- one authoritative ordered log identity;
- durable append before required-transparency success is acknowledged;
- append operations may be transactionally micro-batched without changing leaf order;
- checkpoints may cover many leaves;
- Algorand Falcon anchors commit cumulative roots rather than one chain transaction per route;
- required route binding still returns verifiable evidence for that route;
- default/best-effort transparency behavior remains unchanged unless the caller explicitly requires evidence.

The existing benchmark shows durable SQLite commit-per-leaf work is a bottleneck. Scale work should optimize durable batching, not weaken durability or hash semantics.

### 6. Object/archive storage

Do not create one object-storage object per route at high volume. Batch immutable evidence/history into indexed segments to avoid request-operation costs and object-count explosion.

Keep permanent economic replay tombstones compact. Detailed response/reveal/history retention may use shorter hot retention plus durable batched archive where product requirements permit.

## Payment economics

Current routing price: $0.003 USDC per successful confirmed route.

If the facilitator charges $0.001 for that successful route settlement, gross contribution before infrastructure and any other provider/network costs is $0.002 per success.

That is not, by itself, a reason to lower the customer price. At scale, the more useful optimization is to reduce settlement cost per paid route while preserving the $0.003 product price and success-only contract.

A batch/channel payment scheme may be added later for repeat buyers if all of these remain true:

- no charge advances for a normal typed miss;
- the buyer can independently reconcile cumulative authorized spend;
- route evidence and route-binding functionality are unchanged;
- seller payment remains separate;
- ambiguous settlement state cannot be retried into a second charge;
- ordinary per-call exact payment remains supported for buyers that do not use batching.

Pricing should be reconsidered only if conversion data shows $0.003 materially suppresses adoption, or if provider/gas costs cause contribution margin to become unattractive. Infrastructure cost alone should be a small fraction of revenue at meaningful paid volume.

## Tatum boundary

Tatum is not currently a 402Signal x402 facilitator in the reviewed implementation. The router uses CDP for Base, PayAI for Solana, and GoPlausible for Algorand verify/settle.

Tatum is relevant to the PQ anchoring subsystem as an independent Algorand confirmation/RPC provider. That background confirmation workload is low-rate and does not need to scale one-for-one with route volume because a single cumulative anchor can cover many route-decision leaves.

Therefore:

- keep Tatum on a low-cost/free background-confirmation role while volume is low;
- do not route every user request through Tatum;
- do not buy a dedicated Tatum key solely for the 20M/day target unless measured anchor/confirmation traffic requires it;
- maintain at least one independent confirmation provider option so anchoring verification is not coupled to the routing facilitator.

## Budget profile: now (<= $100/month)

A practical current profile is:

- existing single Fly application machine and volume: keep current low-cost footprint;
- no additional always-on API replicas yet;
- shared replay-store development may use a free or low-cost Turso plan when activated;
- Tatum background confirmation stays on free/shared capacity while it remains sufficient;
- no paid Redis cluster; use process-local cache until multiple API writers are enabled;
- object storage only for verified backups / batched archives, with bounded retention;
- free/low-cost monitoring first, with sampling and coarse metrics rather than per-request paid tracing.

Before any recurring service is added, update the monthly budget table in this document and confirm total expected baseline remains <= $100/month.

## Scale profile: later

Future spend is demand-triggered, not pre-provisioned. Add capacity only after measured thresholds are crossed.

Suggested gates:

1. >25% sustained CPU or probe-slot saturation during peak windows: benchmark a larger/second worker before purchase.
2. replay ledger approaching 50% of its safe current capacity: shared ledger migration must already be proven; do not wait for exhaustion.
3. >1 paid API writer required: shared replay authority becomes mandatory.
4. facilitator/RPC rate limiting observed: negotiate/provider-upgrade based on actual rail mix.
5. transparency writer p95 or queue depth rises: enable durable micro-batching before adding hardware.
6. archive/storage growth exceeds budget: shorten hot-detail retention and batch immutable segments; never delete economic uniqueness solely to save space.

## Implementation sequence

### Phase 0 - no behavior change

- establish this architecture and cost contract;
- add repeatable capacity calculations;
- add load-test fixtures that use controlled merchants and simulated facilitator adapters;
- record current measured route/probe/database timings.

### Phase 1 - shared replay backend

- extract replay persistence behind a storage interface;
- retain the existing SQLite backend as the default;
- add an opt-in remote transactional backend;
- run concurrent duplicate, crash, timeout, and ambiguous-settlement tests against both;
- keep production on the local backend until the remote backend passes migration/recovery drills.

### Phase 2 - horizontal API readiness

- remove process-local assumptions from paid request correctness;
- introduce identity-aware distributed rate/quota controls while retaining IP abuse limits;
- validate two API instances against one shared replay authority;
- only then allow more than one paid-routing writer.

### Phase 3 - probe scaling

- make process probe concurrency configurable with safe bounds;
- benchmark worker sizes against controlled sellers;
- separate probe-worker scaling from API request concurrency where useful;
- add queue/backpressure metrics and fail-closed overload behavior.

### Phase 4 - transparency batching

- batch durable leaf commits in small ordered transactions;
- preserve exact Merkle semantics and receipt verification;
- benchmark at target append rate;
- keep Algorand anchor cadence cumulative and independent of request latency.

### Phase 5 - payment batching option

- implement only after per-call paid traffic exists in enough volume to justify it;
- preserve ordinary exact payment and all current route/PQ functionality;
- measure real effective facilitator cost per successful route before changing public pricing.

## Capacity proof before claiming 20M/day

Do not market 20M/day capacity until a representative 24-hour test demonstrates at least 20M logical route attempts with defined latency/error SLOs and no violation of payment safety.

Required failure tests include:

- duplicate authorization sent concurrently to separate API instances;
- API crash after durable reserve;
- lost facilitator settle response;
- database failover during reserve and finish;
- replay after response-cache expiry;
- merchant timeouts and concentrated single-host load;
- transparency writer crash before/after durable append;
- backup restore followed by duplicate authorization replay.

The success criterion is economic correctness first, throughput second.
