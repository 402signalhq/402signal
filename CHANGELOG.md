# Changelog

All notable changes to the hosted service, the client packages and the MCP
server. The format follows Keep a Changelog; dates are UTC.

## Unreleased

- Production shadow catalog ships to the replay authority (`LIVE402_CATALOG_BACKEND = "dual"` in `fly.toml`; the owner functions in `ops/catalog-postgres-managed.sql` are installed). The SQLite file stays the reader; the writer backfills it once and logs parity hourly. Fourth step of the second-machine plan.
- Production probe history ships to the replay authority (`LIVE402_HISTORY_BACKEND = "dual"` in `fly.toml`; the owner functions in `ops/history-postgres-managed.sql` are installed). The SQLite file stays the reader; the writer backfills it once and logs parity hourly. Third step of the second-machine plan.
- Probe history replica on the replay PostgreSQL (`live402/history_replica.py`,
  `LIVE402_HISTORY_BACKEND=sqlite|dual`, owner migration
  `ops/history-postgres-managed.sql`, schema `signal_history`): third step of
  the second-machine plan. The SQLite history file on the writer's volume
  stays the source of truth and the reader; with `dual`, every committed
  change to it (probe, observations, per-URL change clocks, cap deletes,
  sealed batches, scoring models) is captured inside the same SQLite
  transaction as an outbox row and shipped in order by the writer's
  maintenance loop through one owner function (`api_apply`, SECURITY
  DEFINER, gated on the pinned runtime login like the replay, lease and
  session functions). A backfill copies the existing file once, oldest probe
  first, in chunks; an hourly parity line compares counts on both sides and
  is the gate for moving the endpoint pages to the copy. Nothing in the
  request path waits on PostgreSQL; a replica outage leaves the outbox row
  for the next drain. Default unchanged: the SQLite file only. Loopback
  contract tests in the `replay-postgres` workflow.
- Production session store switches to the replay authority (`LIVE402_SESSION_BACKEND = "postgres"` in `fly.toml`; the owner functions in `ops/session-postgres-managed.sql` are installed). The writer copies the machine's SQLite session state in once on its first lease acquisition; the SQLite file stays as the observation cache only. Second step of the second-machine plan.
- MCP: the listed tools are `check` (paid), `preview` and `validate`. `route`
  is the former name of `check`: `tools/call route` keeps working for
  existing clients, but it is no longer listed, because two identical listed
  tools confused agents and tool graders. Every description now leads with
  the task, names the sibling tools and when to use them instead, states cost
  and side effects, and explains the parameter interactions the schema
  cannot (structured fields win over `policy`, the three price bounds, the
  defaults). Each tool carries MCP annotations (`title`, `readOnlyHint`,
  `destructiveHint`, `idempotentHint`, `openWorldHint`) that state what its
  handler does. The CDP bazaar entry, `/mcp.json`, `llms.txt`, the README
  and the Glama adapter note name `check`.
- `@402signal/route-guard` 0.7.4 published: tag `route-guard-v0.7.4` on the
  PR #232 merge commit (5bc1e65), GitHub release 2026-09-13T23:35:35Z with
  the reviewed pair (`164a1328…` tarball, `d414db64…` SHA256SUMS; the
  downloaded bytes were verified against it) and `@402signal/route-guard@0.7.4`
  on the npm registry with provenance. `capabilities.json` flips the row to
  `published`, `verifier_package` moves to 0.7.4, and the installer script,
  its tests, `llms.txt`, the developer guide, the README and the docs point
  at 0.7.4. `402signal` 0.1.1 is on PyPI (tag `python-v0.1.1`, same commit).
- `@402signal/route-guard` 0.7.4 (release candidate; the capabilities row is
  `pending` with provisional pack digests until the tag is uploaded and the
  downloaded bytes are verified, then a follow-up flips it to `published` and
  moves the installer and site pins): the quote digest accepts any finite
  number within plus or minus 2^53 and lays it out as `JSON.stringify` does,
  so a seller challenge with decimal values (agent402.tools' bazaar example)
  verifies against the server's receipt instead of failing `invalid_json`;
  numbers bind by value (`1.0` is `1`), anything beyond the range, `NaN` and
  `Infinity` still fail closed. `isUnsettledRouteMiss` recognizes the HTTP 503
  `binding_unavailable` answer. Licence: Apache-2.0 from this release
  (`LICENSE`, `NOTICE` in the package); 0.7.3 and earlier stay MIT. The
  conformance fixture `tests/fixtures/route-binding-v1.json` gains a fifth
  signed case whose challenge carries decimals in every ES6 layout class; the
  generator pins the public test recipients so the four existing cases are
  byte-identical.
- `402signal` (Python) 0.1.1: `signal402.verify.canonical` lays decimal numbers
  out as JavaScript does (RFC 8785 section 3.2.2.3; `1e-07` was Python's
  spelling of `1e-7`, `1e+16` of `10000000000000000`), so a record with
  decimals verifies offline; new layout vectors from Node. Licence: Apache-2.0
  from this release (`LICENSE`, `NOTICE` in the sdist and wheel); 0.1.0 stays
  MIT.
- Seller challenges that carry decimal values bind. The v1 quote profile accepted safe integers only, so a challenge whose bazaar output example quotes a price such as `67234.12` (agent402.tools does) failed route binding with `invalid_json` and never got a receipt. Finite numbers within plus or minus 2^53 are now accepted and laid out exactly as JavaScript's `JSON.stringify` does (`live402/pq/jcs.py`, RFC 8785), verified against Node on the same bytes. Route-guard 0.7.3 still refuses such a challenge at the buyer's guard (`invalid_json`, fail closed, no payment) until 0.7.4 ships; the Python verifier 0.1.0 accepts it.
- Lab self-tests see a recipient rotation. Self-test observations never touch the public per-URL state, so a lab seller that changed its pay-to could never trigger the `payTo_pending` refusal a public buyer meets. A self-test observation is now compared with the lab's own previous live observation of that URL (`history._lab_payto_rotation`, probe rows only, nothing public written): the first run after a rotation is refused as a typed miss with `payTo_pending`, `payTo_changed` and `risk: ["payTo_changed"]`, the next run with the same recipient settles again.
- A paid check whose seller answered with a live challenge but whose signed binding could not be built no longer reads as `no_402_envelope`: the HTTP 503 answer now says `error` and `binding_error` `route_binding_unavailable`, `miss_reason: binding_unavailable` (new public reason), keeps `has_402_challenge` and the challenge's terms, drops `unmet_constraints`, and omits the seller's input and output schemas (kilobytes of JSON Schema that only matter for a route that will be executed). Nothing is billed, as before. Separately, `unmet_constraints` no longer lists `networks` when the requested network was offered and only the price bound failed. Docs: `docs/route-miss-http-status.md`.
- Production writer lease moves from the volume lock file to the replay authority (`LIVE402_LEADERSHIP_BACKEND = "postgres"`, the `signal_router` lease functions already in `ops/router-leadership-managed.sql`). Renewed every 5 s, held 15 s by the database clock; a machine that stops renewing stops publishing before anyone else can acquire. First step of the second-machine plan; `file` stays the rollback value.
- Shared session store (`live402/session_store.py`, `LIVE402_SESSION_BACKEND=sqlite|postgres`, owner migration `ops/session-postgres-managed.sql`): hosted windows, check credits, the private counters and payer days and the alert subscriptions with their deliveries can live in the replay PostgreSQL instead of the machine's SQLite file, so a second machine finds the same window, credit or subscription. Every write goes through an owner function that refuses every login except the pinned replay runtime login and fences a broadened login; reads use the runtime login's read-only access. The observation cache stays per machine. A hop that cannot reach the store answers HTTP 503 `session_store_unavailable` (retry the same hop); a credit that cannot be read counts as spent; alert calls answer 503 `alerts_unavailable`. On the first lease acquisition with the shared store the writer copies its local file in once (`session.import_local_state`, marked in both stores). `scripts/session_stats.py` exports the rollup input and `scripts/organic_rollup.py --session-stats` reads it. Default unchanged: the SQLite file. Second step of the second-machine plan.
- `/ready` reports `writer` (true while this process holds the writer lease) as a top-level boolean beside `ok` and `checks`; it never changes the status code, so a standby machine without the lease stays healthy. Documented in `docs/fly-ready-check.md`; `/status` shows it as its own row and states what the outside monitoring watches (instance up, server-error share, traffic, memory and volume use, with a person paged by email) next to the ten-minute external probe.
- Two developer guides served from the site with `.md` twins: `/developers/alerts` (change alerts: subscribe, payload, signature, failures, management) and `/developers/evidence-record` (the Offer Evidence Record v1). `llms.txt`, `/trust`, `/try` and the report point at them instead of the repository.
- Website and docs, proof-first: the homepage leads with the signed record
  ("Signed proof of what your agent was offered before it paid"), opens three
  doors (buyers and platforms, sellers, auditors and compliance), names the
  outputs (receipt, record, report), replaces the invented illustrations with
  named incidents from September's probe history (api.kadec0.xyz +67%,
  api.agentstools.dev tripled, api.syraa.fun doubled overnight against an
  unchanged listing) and gathers its limitations in one block. New pages:
  `/pricing` (per-check on-ramp, platform plans priced on receipts issued and
  records retained, credits and keys), `/trust` (what a receipt contains, how
  to verify it offline, the log and the anchor, the record format) and `/try`
  (a real unpaid readiness check on a listed endpoint, no wallet). The
  navigation points at real URLs instead of anchors; the endpoint index sorts
  by listings, probes or live rate and every host page carries a claim link.
  "Router" and "routing fee" leave the public copy (`llms.txt`, the catalog
  description, OpenAPI guidance, MCP descriptions, README, guides); contract
  field names are unchanged. `llms.txt` now lists `/keys/usage`, change
  alerts, `/try`, `/pricing` and `/trust`. New docs: the Offer Evidence
  Record specification (`docs/evidence-record.md`, versioned and protocol
  independent, with a reserved mandate reference) and a draft x402
  `offer-evidence` extension proposal (`docs/proposals/`).
- Public core, private edge (phase 1): operator runbooks (replay hot-path
  migration, leaf outbox, managed-functions contract, lab route testing), the
  capacity evidence (replay throughput benchmark, HTTP load test, Merkle
  measurements, scaling plan), the private metrics procedure and the k6
  load-test harness move to the private operations repository. The replay SQL
  stays public because CI exercises it. `/security` states capacity and reviews
  as commitments (classes fixed, the measured number) instead of linking the
  harness and the lab records. The SDK licence switch to Apache-2.0 lands
  with `route-guard` 0.7.4 and `402signal` 0.1.1 (above); the published 0.7.3
  and 0.1.0 stay MIT. The repository root stays MIT.
- North-star metric, private: after every settled qualifying check the
  writer records the SHA-256 of the verified payer per UTC day
  (`payer_days`, never the address) and logs `north_star` hourly: signed
  receipts issued and distinct organic payers over the trailing seven days.
  `scripts/organic_rollup.py` prints the pair first. Nothing is published.
- Change alerts for admission-key holders (`live402/alerts.py`, `POST /alerts`,
  `GET /alerts`, `GET /alerts/{id}`, `POST /alerts/{id}/test`,
  `DELETE /alerts/{id}`): a subscription names up to 20 seller hosts and one
  public HTTPS webhook; the writer's maintenance loop (`alerts_scan`, every
  two minutes) delivers one signed batch (`X-402Signal-Signature:
  t=<unix>,v1=<hex HMAC-SHA256>`) of `price_changed`, `recipient_changed` and
  `liveness_changed` events drawn from the same public observations the
  endpoint pages count. Webhook targets pass the probe's SSRF guard at
  creation and on every delivery; delivery is at least once with backoff,
  disabled after 20 consecutive failures, re-enabled by a successful test
  ping. Every call answers only for the presented key's own subscriptions.
  Guide: `docs/customer/alerts.md`; OpenAPI tag `Keys` also documents
  `GET /keys/usage`.
- `GET /keys/usage` (`live402/keys.py`): a caller-scoped, read-only view of
  the two customer credentials. With `X-402Signal-Trial` it returns the
  credit's `remaining`, `used`, `ceiling`, `active` and `expires_at`; with
  `X-402Signal-Key` it reports whether the admission key is recognized and
  the `ingress` / `unpaid` capacities it carries per policy window. Unknown,
  malformed or expired credentials read as `recognized: false` or
  `active: false` with HTTP 200, never as an error, and the answer never
  echoes the secret. No listing, no minting. `Cache-Control: no-store`.
- Keyless recovery, minimal: repeating a payment authorization whose replay
  identity is already final, without a `Replay-Key`, returns HTTP 409
  `authorization_already_used` with `replay.state`, the matching `billing`
  outcome and `new_payment_allowed: false` instead of the coarse unknown
  outcome. The private response stays sealed behind the key; pending or
  uncertain identities are unchanged. New miss reason `authorization_used`.
- MPP challenges are observed on every check (`live402/mpp_offers.py`): each
  `WWW-Authenticate: Payment` challenge is parsed for its method, intent and
  request terms. A classified `charge` on Tempo (`eip155:4217`, new rail
  `tempo`) or an EVM chain becomes a payment option with scheme `mpp-charge`,
  so an MPP-only seller reports live, payable and a selected payment; session
  and subscription terms (unit price, suggested deposit, period) are returned
  as observed terms in `mpp_offers`, never as a fixed price; unknown methods
  stay visible as unclassified. Signed v4 route binding stays x402 exact.
- Observed EVM networks beyond Base: seller offers on Polygon, Arbitrum One,
  Monad, World Chain, X Layer, BNB Smart Chain, HyperEVM, Ethereum, OP
  Mainnet and Avalanche are classified by their exact CAIP-2 id, priced in
  dollars when the asset is that chain's native Circle USDC, validated as
  EVM recipients, and selectable with `networks` / `prefer_network` by rail
  name or CAIP-2 id (`live402/evm_chains.py`, `payment.OBSERVED_RAILS`). The
  checking fee is still paid on Base, Solana or Algorand only
  (`payment.SUPPORTED_RAILS`, alias `FEE_RAILS`).
- Transparency-leaf outbox (`LIVE402_PQ_OUTBOX=1` plus the owner migration
  `ops/replay-postgres-leaf-outbox.sql`): a router process without the writer
  lease completes plain paid checks by queueing the public leaf bytes in the
  shared replay authority; the writer drains the queue in order into the log.
  Such responses carry `pq_trust.transparency.status = "queued"` and no
  checkpoint; `require_transparency`, `require_route_binding`, the Check
  group offer and hosted sessions still wait for the writer. Runbook:
  `docs/runbooks/leaf-outbox.md`.
- Replay hot path: the PostgreSQL replay client keeps a bounded pool of
  connections per process (`LIVE402_REPLAY_POOL_SIZE`, default 8) and runs
  each paid admission write as one pipelined round trip. The owner migration
  `ops/replay-postgres-hotpath.sql` moves the admission and byte counters to
  sixteen shard rows so reservations stop serializing on the authority row;
  every guard, the identity primary key and exact quota enforcement are
  unchanged. `api_capacity` reports live totals; `fence_status` reconciles
  against the shards. Runbook: `docs/runbooks/replay-hotpath-migration.md`.
- `@402signal/route-guard` 0.7.3 is published: the GitHub release archive
  (`route-guard-v0.7.3`, digest pinned in `/capabilities.json`) and the npm
  registry package with a provenance attestation. `capabilities.json` records
  the published digests, `verifier_package` moves to 0.7.3, the installer
  script and every install instruction point at 0.7.3, and the developer
  guide leads with `npm install` plus `npm audit signatures`.
- MCP: `check` is a paid alias of `route` with the same schema, fee and
  result, listed right after `route` in `tools/list` and the manifest.
- Website: new homepage built around the one-minute try and the two client
  hooks, with the returns table, field numbers and a shorter evidence
  section; the September "State of x402 endpoints" report is published at
  `/insights/state-of-x402-endpoints-2026-09` and listed in the sitemap.
- Public per-host endpoint pages at `/endpoints/<host>` (catalog listings,
  declared networks, 30-day public probe results, an embeddable SVG badge), a
  host index at `/endpoints`, and `/endpoints/sitemap.xml`. Only public
  organic probes from trusted observation classes are counted; nothing a
  seller pays for changes the numbers.
- `/verify`: receipt verification in the browser with WebCrypto and a key you
  pin yourself; nothing is uploaded. Checked in CI against the conformance
  fixture under Node.
- `/status` (live readiness booleans, monitoring method, incident issues) and
  `/security` (custody boundaries, controls, automated checks, reviews so
  far); Status and Security links in every footer.
- Developer guides show the x402 `onBeforePaymentCreation` hook and the mppx
  `onChallenge` hook next to the existing wrap.
- Replay authority runbook records the move to the Basic cluster
  `402signal-replay-v3`.
- Python package `402signal` (import `signal402`, `sdk/python`): unpaid
  challenge, paid check and read-only recovery helpers, outcome
  classification, and an offline receipt verifier (reveal commitment, leaf
  hash, RFC 6962 inclusion, Ed25519 checkpoint signature) that matches the
  server implementation on the conformance fixture. Published from
  `publish-pypi.yml` with PyPI Trusted Publishing on `python-v*` tags.
- `@402signal/route-guard`: new `./mpp` export with `mppGuard`, an mppx
  `onChallenge` hook plus `challenge.received` observer that runs the hosted
  Check group offer observation for Base USDC charges, verifies the receipt
  locally and aborts when the live challenge's terms differ.
- `@402signal/route-guard`: new `./x402` export with `signalGuard`, an
  `onBeforePaymentCreation` hook for the official x402 client that runs the
  hosted check, verifies the receipt locally and aborts mismatched payments.
- Replay identities now expire on Solana and Algorand too (conservative
  bounds from verification time), not only on Base.
- Check credits (API key v0): operator-issued credits can now cover up to
  1,000 listed-URL checks for up to 30 days.
- MCP tool descriptions cut to about a third of their length.
- `scripts/endpoint_report.py` renders the "State of x402 endpoints" report
  from catalog and probe history copies; the September 2026 edition is
  published under `docs/insights/`.
- README, homepage and `llms.txt` now open with a one-minute start (unpaid
  curl, the x402 hook, evaluation credits) and document the `./x402` hook.
- The provisional route-guard 0.7.3 pack digest is re-pinned because the
  `x402` adapter joined the package.
- `ops/loadtest/`: k6 scripts for the free and paid paths and a disposable
  free-path staging config; `docs/load-test.md` records the procedure and
  results.
- Repository hygiene: external uptime probe with incident issues, OpenSSF
  Scorecard, npm publish workflow with provenance, security and contributing
  policies, issue and pull request templates.
- Historical release gates, closeouts and operator runbooks moved to the
  private operations repository; public docs now describe current contracts
  only.
- Production image labels are `api-<sha>`.

## 2026-09-13

- Router lease for managed PostgreSQL without GRANT or REVOKE (#196).
- Replay instance fence with verified re-pin after a database restart and
  attested recovery after a failover or restore (#197).
- Replay admission throughput benchmark on Managed Postgres (#198): about
  45 admissions per second per router process, 100 to 120 across processes.
- Base and Solana routing-fee treasuries rotated (#199).

## 2026-09-12

- Replay identities expire once their Base authorization can no longer settle
  (#195).
- Per-payer budget for verified attempts that do not settle; gated production
  deploy workflow (#194).
- Writer lease, private organic metrics, backup schedule, readiness cache,
  graceful drain, separate free and paid discovery pools, IPv6 /64 abuse
  identity, $0.005 session accounting fix (#193).
- Hosted session price and hop shape published (#191, #192).

## 2026-09-11

- Postgres replay authority cut over on the production writer (#190).
- Hosted session open ($0.005) and hops, hashed trial credits (#184 to #188).
- Only the billable winner is promoted to settled history (#185).

## 2026-09-10

- `@402signal/route-guard` 0.7.2: Check group offer without `merchant_profile`,
  digest-checked install, default `wrapExactAuthorize` (#168 to #179).
- Canonical origin and site disclosure pages (#182).

## 2026-09-09

- `@402signal/route-guard` 0.7.1: pinned log keys win over response-offered
  keys (#154, #156).
- Bounded unpaid public request admission (#155); separate unpaid discovery
  budget (#150).
- MCP Registry metadata 0.3.2 (#157).

## 2026-09-08

- `@402signal/route-guard` 0.7.0, `session-client` 0.1.1, `mpp-client` 0.1.0,
  `algorand-batch-buyer` 0.2.0 release archives.
- Native MPP charge integrations for Base and Algorand (#139); bounded
  sessions and Algorand payment manifests (#138).
