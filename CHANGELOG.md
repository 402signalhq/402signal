# Changelog

All notable changes to the hosted service, the client packages and the MCP
server. The format follows Keep a Changelog; dates are UTC.

## Unreleased

- `@402signal/route-guard` 0.7.7 release candidate (security review refresh,
  SDK side): the x402 hook's fee exemption is pinned to the published fee
  terms (`DEFAULT_FEE_TERMS`: `exact` and USDC per fee rail, `feeTerms`
  override) on top of the 0.7.6 bounds (S1); `fetchChallenge` meters Node
  readable bodies and refuses an unmetered transport that declares no
  `Content-Length` within the bound (`challenge_unbounded_transport`, S2);
  the TypeScript declarations carry every hook option, the exported defaults
  and `fetchChallenge`'s options, and the packaged type check compiles a POST
  consumer against the installed tarball (F5); `classifyRouteResponse` and
  `isUnsettledRouteMiss` accept every published fee shape (`FEE_SHAPES`: the
  check, the $0.005 session open, $0.000 hops and typed session misses), the
  classification gains `routeOutcome`, and the hosted-session miss reasons
  count as unsettled misses (found by the 2026-09-14 paid captures: a session
  open and a hop both classified `unclassified`). Pending `capabilities.json`
  row with the provisional pair (`383f2041…` tarball, `37f73ef3…`
  SHA256SUMS); the installer, llms.txt and the site keep the published 0.7.6
  pin until the release.
- `@402signal/route-guard` 0.7.6 published: tag `route-guard-v0.7.6` on the
  PR #250 merge commit (5ea0df9), GitHub release 2026-09-14T15:52:55Z with the
  reviewed pair (`8fbf694f…` tarball, `00572428…` SHA256SUMS; the downloaded
  bytes were verified against it) and `@402signal/route-guard@0.7.6` on the
  npm registry with provenance. `capabilities.json` flips the row to
  `published`, `verifier_package` moves to 0.7.6, and the installer script,
  its tests, `llms.txt`, the developer guide, the README and the docs point at
  0.7.6. 0.7.4 stays published and unchanged.
- `@402signal/route-guard` 0.7.6 release candidate (security review
  2026-09-14, SDK side; the pending `capabilities.json` row carries the
  provisional pair, the installer and site pins stay on the published 0.7.4
  until the release). 0.7.5 was tagged on 2026-09-14 but never reached npm:
  its publish run's package test hung because the new challenge-timeout timer
  was `unref`'d and the runner's event loop drained around a stalled mock
  fetch; 0.7.6 keeps the timer strong (the deadline must fire even when the
  stalled seller response is the only pending work) and is otherwise the same
  code. The 0.7.5 GitHub release is withdrawn; nothing consumed it.
  The changes:
  - S1: the x402 hook's recursion exemption is granted only while the hook's
    own check request is in flight, for the exact check URL, to one of
    402Signal's fee recipients (`DEFAULT_FEE_RECIPIENTS`, from `GET /rails`;
    `feeRecipients` overrides) and at most `maxFeeAtomic` (5000). A seller
    challenge that names the router's origin outside those bounds is refused
    whatever `onMiss` says; before, any challenge claiming the router's origin
    was allowed through with no check or receipt verification.
  - S2: `fetchChallenge` reads the seller's reread through a bounded stream:
    64 KiB and 10 s end to end, cancelled on either bound
    (`challenge_too_large`, `challenge_timeout`), caller `AbortSignal`
    forwarded; `maxChallengeBytes` and `challengeTimeoutMs` tune it.
  - S3: `prepareVerifiedNativeBaseMpp` carries the routing evidence's expiry
    into the deferred credential; authorize, signer entry and credential
    return stop at the earlier of the evidence and merchant deadlines
    (`expired_route_evidence`).
  - F4: `mppGuard` reports the verifier's typed reason instead of a generic
    `verification_failed` when the batch verifier refuses.
  - F5: `method: "POST"` requires `challengeFor`, `requestFor` and `bodyFor`;
    the exact body is bound into verification. GET is unchanged.
- Security review 2026-09-14 (independent assessment of `d824de2`), server side:
  - F1 alerts: a scan with more changes than one delivery holds (200) now
    sends the oldest batch and moves the subscription's cursor only past what
    it sent, keeping cut liveness transitions in their previous state, so the
    rest goes out on the next scan instead of being skipped for good; each
    scan delivers to at most 25 subscriptions (`MAX_DELIVERIES_PER_SCAN`) so
    slow webhooks cannot hold the writer's housekeeping loop (R2).
  - F2 accounting: `route.settled.<traffic>` counts every settled checking
    fee; `route.qualified.<traffic>` (the north-star "receipts") is counted
    only after a durable signed receipt came back with a 200, so a fee that
    settled and then failed its required receipt is no longer a receipt.
    `north_star` and the rollup report both numbers.
  - F3 probing: observed MPP challenges now ride from the winning attempt into
    the probe result; an MPP-only seller reported live with no offers, not
    payable and not invocable on the ordinary path.
  - F7 selection: with a network lock, price ranking looks only at options on
    the locked rails; a seller's cheap offer on an excluded network no longer
    ranks its expensive offer on the locked one first.
  - F8 reputation: ISO 8601 change clocks are parsed, so a recipient, rail,
    price or schema change in the last seven days lowers the stability score
    the way an epoch clock always did.
  - S4 replay authority: `signal_replay.api_admit_shard` becomes SECURITY
    INVOKER (`ops/replay-postgres-hotpath.sql`; standalone re-apply
    `ops/replay-postgres-admit-shard-invoker.sql`, owner sheet section L), so
    a reader login can no longer move a shard's admitted counter without an
    entry and trip the fence's consistency check. Loopback contract test added.
  - S5 installer: `scripts/install_route_guard.mjs` stages the archive and
    SHA256SUMS in a fresh private `mkdtemp` directory with exclusive creates,
    verifies and installs the same staged bytes, and removes the directory on
    exit; a predictable, precreated PID-named directory is never used.
  The SDK findings (S1 fee-exemption bypass, S2 unbounded challenge reread,
  S3 native Base signing after evidence expiry, F4 error class, F5 POST body)
  ship with route-guard 0.7.5 in a separate change. The website findings (F6)
  landed with the buyer-journey change above.
- Observation rail correctness. A probe row now carries the rail of the option
  it observed (the first accept with a recipient, the same option that supplies
  the recorded recipient and amount) instead of the catalog listing's rail.
  Since the shadow catalog began, the routed path had stamped every row with
  the listing's rail, so a seller listed by an Algorand feed but answering with
  Solana terms was filed under Algorand. On the 2026-09-13 copy, 750 of 2,145
  rows with a recipient disagreed with the catalog's rail for that recipient
  (465 rows labelled Solana carrying 0x recipients, 138 labelled Algorand
  carrying Solana recipients), which skewed the by-rail rates on host pages
  and in the report, and made recipient comparisons on those rows
  case-sensitive. A one-time writer job (`history_rail_repair`) relabels the
  stored rows from their own recipient and the catalog (rules in
  `history.repaired_rail`: the catalog's single rail for that recipient, else
  the recipient's shape; a 0x recipient keeps an EVM rail or falls back to
  Base) and ships the corrections to the replica. A claim is now read from the
  catalog accept on the observed rail, so claimed and observed compare like
  for like, and its stored row carries the claim's own rail (from the accept
  that names the claimed recipient) instead of inheriting the observed one;
  the public `claimed` block is unchanged. api.syraa.fun/news, printed with rail
  Algorand in the September report, was observed on Solana: its recipient is
  the seller's Solana address on all three discovery feeds.
- Observed EVM networks, next three by shadow-catalog listing share (about
  765, 549 and 545 claims on 2026-09-13): Sei (`eip155:1329`, rail `sei`) and
  Celo (`eip155:42220`, rail `celo`) are classified and priced in dollars for
  their native Circle USDC, which is the asset their catalog claims use;
  Robinhood Chain (`eip155:4663`, rail `robinhood`) is classified and
  selectable but stays unpriced because its stablecoin is Paxos Global Dollar
  (USDG), not Circle USDC. `tempo`, `sei`, `celo` and `robinhood` are accepted
  as `networks` / `prefer_network` names next to their CAIP-2 ids; host pages
  and the endpoint report name Tempo, Celo and Robinhood Chain instead of a
  bare id. The checking fee is still paid on Base, Solana or Algorand only.
  Non-EVM families seen in the catalog (XRP Ledger, Stellar, Hedera) are not
  observed yet.
- Website: buyer-first homepage with a labeled synthetic offer example and profile limits; official-client hook first in its guide; explicit customer-owned evidence storage, compact audience links, scoped evaluations and monthly quoted Platform plans; no invented numerical tier prices or hosted-retention promises. The unpaid sample displays observed atomic amount and supplied asset/network fields with explicit unknowns. September report corrects network-membership labels, price-change arithmetic, traffic cohorts and an unresolved seller-network attribution. Payment behavior and pricing are unchanged.

- Production shadow catalog ships to the replay authority (`LIVE402_CATALOG_BACKEND = "dual"` in `fly.toml`; the owner functions in `ops/catalog-postgres-managed.sql` are installed). The SQLite file stays the reader; the writer backfills it once and logs parity hourly. Fourth step of the second-machine plan.
- Production probe history ships to the replay authority (`LIVE402_HISTORY_BACKEND = "dual"` in `fly.toml`; the owner functions in `ops/history-postgres-managed.sql` are installed). The SQLite file stays the reader; the writer backfills it once and logs parity hourly. Third step of the second-machine plan.
- Accuracy: the recipient-change statistic says the same thing everywhere.
  The one recipient change in the September period was a discovery feed's
  claim changing (a listed change), verified against the off-host history
  copy: no `url_state` change clock and no successive observed `payTo`
  values differ in the window. The homepage stat now reads "one listed
  recipient change (a catalog claim, not observed in a live challenge)"; the
  report's method section and its Markdown twin define observed changes (a
  live challenge differs from 402Signal's previous trusted observation of the
  same URL within the period) and listed changes (a feed claim changed,
  never counted as observed); `/endpoints` "Method and neutrality" carries the
  same definition, and each host page reports observed and listed counts
  separately instead of one summed number.
- OpenAPI and the MCP output schema now name every recipient-comparison
  field a real `/route` answer carries: `claimed_payTo_match`,
  `payTo_pending`, `payTo_changed`, `risk`, `payTo_age_s`, `observed_age_s`,
  the `observed` block (`payTo`, `amount`, `observed_at`, ...),
  `claimed.claimed_at`/`facilitator`, and
  `reputation.stability.{payTo,price,schema,rail}_changes {count, changed_at}`,
  each with the comparison semantics (claimed = catalog listing at
  `claimed_at`; observed = live challenge at `verified_at`; `payTo_changed` =
  observed differs from the catalog claim or the last trusted observed
  destination). `/validate` reuses the `claimed` and `observed` schemas. The
  developer page and `docs/proof-carrying-route-v1.md` state the two
  outcomes: a `payTo_pending` exclusion is judged against 402Signal's own
  observation history and an updated catalog claim does not clear it; the
  guard's binding digest covers the whole raw challenge, so a recipient change
  fails closed like a price change.
- Shadow catalog replica on the replay PostgreSQL (`live402/catalog_replica.py`,
  `LIVE402_CATALOG_BACKEND=sqlite|dual`, owner migration
  `ops/catalog-postgres-managed.sql`, schema `signal_catalog`): fourth step of
  the second-machine plan, the same outbox pattern as the history replica.
  Listings, their sources and payment claims, source sweeps and claim events
  (and the event cap's deletions) are captured inside each SQLite transaction
  and shipped in order by the writer's maintenance loop through `api_apply`;
  a backfill copies the file once in chunks and an hourly parity line compares
  counts. The full-text index and the short-lived finalist schema cache are
  derived and not copied. Default unchanged (SQLite only). `PostgresReplica`
  in `history_replica.py` now takes its schema and columns as parameters and
  serves both copies.
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
