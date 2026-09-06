# PR109 release proposal: SQLite first

Status: DRAFT / NO DEPLOYMENT GO / NO MAINNET GO / NO POSTGRESQL ACTIVATION GO.
This document prepares a reviewable proposal. It does not authorize execution,
change an automation role, or relax any existing release gate.

## Candidate and review disposition

- Application candidate: `0221d5eef65b1dd2065d17d08040c16f94006263` on main.
- Reviewed PR109 head: `3e92f3d6edee5ef1075c775dbdaff37f2f0f8bb4`.
- Both trees: `684b81d7f5e112deeca8c3c209123c1496829607`.
- Rechecked 2026-09-06: post-merge [tests](https://github.com/402signalhq/402signal/actions/runs/34047292778),
  [PostgreSQL](https://github.com/402signalhq/402signal/actions/runs/34047292788)
  and [CodeQL](https://github.com/402signalhq/402signal/actions/runs/34047292771)
  completed successfully.
- External feedback relayed by the operator accepts the committed foundation
  and explicitly withholds deployment/activation GO. It is not a GitHub approval.
- Code and fixture review is not independent release sign-off. PR109 merged
  before the relayed independent feedback; record that sequence accurately.
- The candidate changes the live replay implementation even in SQLite mode.
  It is inert only while undeployed. An unchanged Dockerfile does not make a
  deployment behavior-neutral.
- Current production image/release/SHA must be freshly identified by 402ops.
  A reported old release is context, not fresh deployment evidence.

Future replay/authority changes must receive exact-diff security feedback and
functional review before merge. Any material code change invalidates previous
exact-diff conclusions. Follow [GitHub protection](../github-protection.md);
do not bypass or weaken rules to manufacture approval.

## Hosting and execution

Keep the existing Fly.io router, lab seller, separate signer, GitHub and Tatum.
Development and fixture tests run in hosted tooling without laptop installs.
The operator now also permits using their existing computer for deployment. Prior
nonsecret setup evidence identifies a WSL/Ubuntu terminal with Fly CLI; this hosted
session has no connection to that terminal. Reusing operator execution does not
require moving hosting or copying credentials to the assistant. An operator can
launch a cloud-built reviewed image from that terminal once release gates pass.
This first release does not require purchasing a database or upgrading Tatum.

A proposed deployment mechanism is an operator-controlled GitHub Actions job
targeting the existing Fly app. "Protected" means an exact reviewed commit,
restricted production credentials, explicit operator release authorization,
serialized deployment, and retained nonsecret evidence. It is not a new host.

This repository currently has no Fly release workflow. The current connector
can prepare repository changes, but has no Fly deployment, secret-administration,
or workflow-dispatch capability. A workflow file alone does not establish access.
Any release workflow requires its own security/QA review before merge, plus
operator configuration of the actual GitHub production environment.

Design requirements for that separate workflow:

- Manual release initiation by 402ops; release exact reviewed SHA/image digest,
  with successful applicable checks and recorded review evidence.
- Scope a short-lived Fly deploy credential to the existing router app; keep it
  in the protected production environment. Verify actual plan/protection support.
  Do not expose it to PR jobs, logs, or the assistant.
- Pin build/action dependencies; never execute an arbitrary branch with production
  credentials. Serialize releases; do not cancel a deployment midway.
- Do not put buyer keys, signer keys, production database copies, or private
  payment reports in this public repository or its Actions artifacts.
- Preserve [automation roles](../automation-security-boundaries.md).
  An available credential does not promote 402dev/QA into 402ops.

## Evidence required before asking for release GO

| Evidence | Required result | Current state |
| --- | --- | --- |
| Exact candidate review | 402security and 402QA release disposition for candidate and procedure | Deployment GO withheld |
| Cloud release access | Reviewed operator execution mechanism; actual environment protections | Not established in this session |
| Production identity | Release/image/SHA, region, volume mapping, exactly one router/PQ writer | Operator check outstanding |
| PQ and anchor baseline | Existing identity/history retained; no unresolved AUTHORIZED, SEND_ATTEMPTED, SUBMITTED or HALTED anchor operation | Operator check outstanding |
| Recovery | Consistent encrypted off-host recovery copy, integrity checks, isolated restore rehearsal and reviewed recovery procedure | Production evidence outstanding |
| Budget | Verified all-services inventory under $100/month including at least $10 contingency | Account evidence incomplete |
| Buyer execution | Existing dedicated wallets, policies, cumulative ledger and trust pin preserved; authorized execution location identified | Funded lab acknowledged; execution access unresolved |
| MainNet preflight | Correct network/assets/recipients/fee payers, balance/opt-ins/token accounts and explicit transaction limits | Read-only operator preflight outstanding |

Do not publish private bills. Inventory router, lab, separate signer, all machines,
volumes/snapshots, databases, backup/archive storage, monitoring, egress, domains,
tax and staging without counting an app twice within the Fly organization total.
Tatum credits and automatic-upgrade status require account evidence; a missing
toggle is unresolved, not proof that automatic upgrades are off.

Daily snapshots alone do not protect writes since the last snapshot. A restored
older payment ledger must never be used to silently reopen admission. Prove a
recovery point that retains acknowledged economic identities or keep admission
stopped while reconciling. Rehearsals use isolated resources with spending and
signer authority absent.

## Cost estimate before any purchase

Public list prices checked 2026-09-06; these are estimates, not measured invoices
or provider-enforced caps. Regional rates, tax, existing storage usage and billing
cadence must be checked before an approval request.

| Item | Estimate and scope |
| --- | --- |
| Code preparation and standard GitHub Actions runner minutes | $0 runner minutes in this public repository; keep storage within included limits |
| First SQLite deployment | No additional recurring service subscription; existing compute/storage/traffic remain billable |
| Temporary rehearsal compute | Example: one 1 GB shared-cpu-1x at $0.0082/hour for 24 hours is about $0.20, before storage/network/tax |
| Temporary volume | $0.15 per provisioned GB-month, prorated; a retained 1 GB volume still costs $0.15/month |
| Fly snapshot storage | First 10 GB free monthly, then $0.08/GB-month; availability of free allowance unverified |
| Tatum | Retain current Free plan for this proposal, conditional on remaining credits/account controls; no upgrade purchase |
| Optional future PostgreSQL or hosted buyer | Not selected; quote resources and durability/security requirements separately before approval |
| Live transaction exercise | Separate variable payment costs, not infrastructure; quote after read-only buyer preflight |

No full monthly total is certified here. Existing account costs and backup needs
remain unverified. Do not reserve or spend the entire apparent headroom; at least
$10 of the $100 total remains contingency. Annual prepayment can exceed a monthly
cash limit even when its annualized rate fits.

For a proposed three-rail purchase pass, routing fees are 3 x $0.003 = $0.009.
If each reviewed seller quote is capped at $0.001, combined router plus seller
amounts are at most $0.012 for those three successes. This is conditional, not a
verified live seller quote, and excludes network/facilitator fees and funding
transactions. Normal misses have zero routing charge. Replays must not create a
new charge. The buyer's durable USDC caps do not by themselves cap gas; preflight
must verify fee-payer policy and native-fee limits. Do not trigger live sends until
a concrete run count and total spending policy receive Ross approval.

Sources:
- [Fly resource pricing](https://fly.io/docs/about/pricing/)
- [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [Fly GitHub deployment](https://fly.io/docs/launch/continuous-deployment-with-github-actions/)
- [Fly snapshots](https://fly.io/docs/volumes/snapshots/)
- [Tatum pricing and plan limits](https://tatum.io/pricing)

## Proposed first release: one SQLite router

Only after the evidence above is complete and Ross records GO for this exact
candidate, procedure, cost limits and execution window:

1. 402ops verifies deployment identity, one router/PQ writer and safe anchor
   state; records existing volume, identity and backend configuration without
   dumping process environments or secrets.
2. Preserve SQLite at `/data/live402-replay.sqlite`, existing history/catalog/PQ
   volumes, MainNet identity and signer boundaries. Do not configure PG, apply a
   migration, activate a fence, add replicas, or change AUTO/LAB policy.
3. Use a reviewed drain/maintenance procedure that proves no overlapping writers
   and protects in-flight economic actions. Do not assume a generic rolling
   deployment is safe for this app. Record expected interruption before GO.
4. Make the consistent off-host recovery copy and execute the reviewed deployment
   to the existing app. Observe startup and both /health and /ready. Confirm the
   exact image/SHA and actual one-router state; an environment assertion alone
   does not prove machine inventory.
5. Compare PQ public identity, root-history continuity and anchor operations with
   the baseline. Run public unpaid contract checks before any paid test.
6. 402ops launches the approved bounded lab exercise below. Observe errors,
   latency, replay capacity and memory/storage during an agreed observation
   window, with stop criteria in force.
7. Record results and remaining risks. This release is not horizontal routing
   readiness or a 20M/day capacity demonstration.

Prepare the recovery image and procedure in advance, preserving the current ledger
and all post-deploy economic records. Do not automatically restore an old snapshot,
delete rows, or roll back to a pre-fence binary to clear an error. Unexpected fence
or backend state requires stopping and reconciliation. Broader PG rollback rules
remain in [scale-production-gates](../scale-production-gates.md).

## Existing lab and bounded live validation

The existing seller origin is documented in [lab-route-testing](lab-route-testing.md).
That runbook places buyer keys on the operator laptop and keeps spending endpoints
off the public seller. The operator confirms dedicated lab wallets already exist
and are funded. Do not generate replacements or request keys in chat.

Identify where the buyer currently executes. If it remains laptop-only, cloud-only
paid testing needs a separately reviewed private operator execution arrangement
using existing providers, or an existing authorized runner. It must preserve wallet
ownership, cumulative budgets, pending/unknown reservations, ledger history and the
independently pinned public PQ key. Moving keys or adding a remote spending interface
is outside this proposal and requires its own explicit security review.

Proposed exercise, with one bounded operation at a time:

- Read-only preflight and unpaid route-contract inspection on Base, Solana and
  Algorand. Verify the actual router and seller policy; funding one rail does not
  prove another rail's readiness.
- One success per supported rail through the normal route and seller paths,
  verifying $0.003 routing price, seller quote/recipient/constraints, chain
  confirmation, V4 binding, private receipt and actual seller delivery.
- One deliberate normal price/constraint miss per rail with no routing settlement
  or trusted-history/PQ append.
- Scoped replay/duplicate checks, including restart and 120-second expiry checks
  under the separately approved restart procedure. Preserve and reuse the original
  authorization privately; do not issue fresh signatures as a duplicate test.
- Wrong-scope replay must not expose private output. Replays must not settle,
  promote history or append a PQ leaf again.
- Independently verify receipt/key binding and inspect existing automatic anchor
  evidence; do not manually invoke the signer or manufacture production leaves.

Operator-owned test traffic follows normal production history/PQ rules and is
labeled self-test, not customer adoption. Private receipt/reveal and raw payment
material remain in the operator's private reports; publish only sanitized results.

## Uncertain commits: written call-site check

Source review at the candidate identified the routing settlement call in
`live402/route.py::_paid_execute`. It is reached only after verification and
`replay.authorize(fp)`; authorization requires an acknowledged durable reservation.
The recorded outcome cannot authorize another facilitator settlement.

| Failure | Required call-site behavior | Existing fixture evidence |
| --- | --- | --- |
| Replay lookup/authority unavailable | Reject before executing paid route; no economic action | PostgreSQLRuntimeContracts.test_authority_outage_blocks_application_before_economic_action |
| Reservation committed but acknowledgement lost | authorize returns false; no probe or settle; retained row blocks after restart | test_application_lost_admission_ack_does_not_probe_or_settle |
| Settlement completed, finish acknowledgement lost | Retain economic identity; reconcile/return known result where available; never settle again | test_application_lost_finish_ack_never_settles_twice |
| Finish fails before recording terminal state | Previously committed pending row remains; restart rejects duplicate | test_application_failed_finish_retains_pending_on_restart |
| Concurrent identical application calls | Exactly one facilitator settlement | test_multiprocess_route_calls_settle_exactly_once |

Nuance: `replay._ledger_finish` suppresses storage errors after an acknowledged
admission. A known settled HTTP result may still be returned/cached even if final
persistence is uncertain. Do not describe every PG error as an HTTP-unavailable
response, or treat a 503 as proof of no charge. The safety rule is no second
economic action; reconciliation must preserve evidence of any completed settlement.

All listed PostgreSQL tests are in `tests/test_replay_storage.py` and use isolated
fixture services. Before any future PG activation, rerun them on the exact candidate
and rehearse commit-ack loss in isolated staging with a counting synthetic
facilitator. No intentional live-provider failure injection is authorized here.

Stop paid validation/admission under the approved operator procedure on any
duplicate charge, unexplained unknown payment, identity discontinuity, backend/
fence mismatch, loss of durable readiness, or privacy/binding discrepancy.
Reconcile instead of retrying payment or switching authority.

## Prepare PostgreSQL now; activate after the prerequisite release

Recommendation: prepare and qualify Fly Managed Postgres Basic while traffic is
low, then migrate through the existing staged procedure. SQLite-first is the
required fence-aware deployment step, not a recommendation to wait for a million
daily authorizations. PostgreSQL activation remains NO until separately approved.

Current source limits at the application candidate are material:

| Component | Reviewed implementation | Consequence |
| --- | --- | --- |
| HTTP serving | 32 default concurrent handlers; bounded thread creation | Slow seller/facilitator calls consume finite slots |
| Paid-route abuse limit | 12 requests/minute per client IP by default; configurable | A legitimate shared-egress integration can hit 429 long before CPU saturation |
| SQLite replay | 100,000 retained rows and 256 MiB capacity guard | Cumulative limits, not daily quotas; starting empty, 1M new retained identities/day would reach the row limit in 2.4 hours, potentially sooner at the byte guard |
| PostgreSQL replay | Module lock, adapter lock, one connection, serialized authority counter | Changing backend alone does not make database admission concurrent |
| Catalog/history/PQ | Process-local state and ordered log assumptions | Multiple API writers still blocked |

These are source facts, not a fresh read of live overrides, usage or measured
throughput. Never increase caps or disable abuse checks without capacity and
economic-safety evidence. Track growth rate and time to exhaustion, not only
percentage used; retained verified misses can consume replay capacity too.

### Preferred provider and cost

Fly Managed Postgres Basic is the first provider to qualify, in the router's
existing iad region. Current advertised price is $38/month plus $0.28 per
provisioned GB-month; the starting 10 GB makes the database $40.80/month. This
includes HA, backups and pooling, not a throughput guarantee or an invoice cap.
Storage can grow automatically and must be included in budget controls.

| Candidate | Published database cost at 10 GB | Decision |
| --- | --- | --- |
| Fly Managed Postgres Basic, 1 GB RAM | $40.80/month | Preferred qualification target; purchase still unapproved |
| Fly Managed Postgres Starter, 2 GB RAM | $74.80/month | Do not choose preemptively; leaves little room under the all-services ceiling |
| Self-managed Fly PostgreSQL | Machine/volume costs plus operations | Not preferred for payment authority; cheaper compute does not include managed recovery/HA duties |

For any verified existing baseline B and other uncovered costs U, the Basic
proposal must satisfy B + $40.80 + U + at least $10 contingency <= $100.
Do not substitute the user's partial-period estimate for B in the approval
inventory. A one-day separate Basic/10 GB staging cluster is approximately $1.36
before network, tax and additional resources; it requires a reviewed lifecycle and
purchase approval. Do not reuse the live authority for destructive testing.

Keep Tatum Free while verified credits and confirmation traffic permit. It remains
a background independent Algorand confirmation source, not a per-route dependency.
A paid Tatum plan must fit the same inventory and have its actual billing cadence
and upgrade controls approved; willingness to upgrade is not a purchase instruction.

Before selecting Fly MPG for payment authority, resolve these compatibility gates:

- Demonstrate hostname/certificate verification with the adapter's required
  sslmode=verify-full. Default encrypted connectivity alone is insufficient.
- Prove custom runtime grants exclude authority activation/identity/cap changes;
  the provider's generic broad Writer role is not automatically sufficient.
- Obtain evidence of acknowledged-write survival on promoted replicas and of the
  behavior when a synchronous replica is unavailable. HA marketing and local
  synchronous_commit/fsync checks do not establish a zero-loss recovery point.
- Confirm patching/version-upgrade responsibility: the current overview still
  lists those capabilities as under development. Do not assume their status.
- Test the selected PgBouncer mode with the actual driver. Current default Session
  mode preserves prepared-statement compatibility; Transaction mode requires a
  reviewed driver configuration and corresponding real-pooler tests.
- Add and test bounded connection lifetime/idle recycling between completed
  operations. Fly documents 600-second lifetime and 300-second idle guidance.
  Do not transplant generic retry advice into uncertain payment-state writes.
- Verify runtime limits and aggregate connections; Fly documents Basic at 200
  client connections and 50 database connections. Those counts are not route RPS.

If these requirements cannot be met, do not relax them to keep a preferred
provider. Present the concrete unresolved issue and a separately priced alternative.

Primary provider references checked 2026-09-06:
- [Managed Postgres pricing and lifecycle caveats](https://fly.io/docs/mpg/)
- [Regions, 10 GB starting storage and HA](https://fly.io/mpg/)
- [Client connections and pooler compatibility](https://fly.io/docs/mpg/client-configuration/)
- [Roles and configuration](https://fly.io/docs/mpg/cluster-configuration/)
- [Self-managed PostgreSQL responsibilities](https://fly.io/docs/postgres/getting-started/what-you-should-know/)

### Implementation and qualification order

1. Complete the reviewed SQLite prerequisite release, source/rollback fence
   checks, recovery evidence and bounded existing-lab tests. In hosted fixtures,
   measure current complete-route behavior and verify existing overload controls.
2. Prepare integration-specific authenticated quotas while retaining anonymous/IP
   abuse controls and global economic-work limits. A caller-supplied wallet label
   or API header is not trusted identity. Preserve open per-call x402 access,
   buyer wallet ownership, success-only pricing and free ordinary misses.
   Give already-admitted operations, replay/recovery and health checks protected
   capacity; reject excess new work before economic action with truthful status.
3. Qualify the PG client and Fly service requirements above in isolated staging
   after the quoted resource purchase is approved. Measure lock/transaction
   timings. Refactor serialized access only with global uniqueness, bounded quota
   and uncertain-write tests intact; adding a pool alone cannot remove the module lock.
4. Run the separately approved PG migration: stop/drain all writers, expire private
   windows, verify encrypted off-host backup, verify import/digest, commit source
   fence, then activate destination. Every runnable/rollback image must be
   fence-aware. Never automatically retry an uncertain/partial cutover or restore
   a stale authority. Retain one router during this step.
5. Complete shared catalog/history policy, bounded outbound probe workers and the
   ordered durable PQ writer. Use the same qualified database where appropriate
   to avoid extra services; benchmark interference with replay before combining
   workloads. Durable micro-batching must preserve leaf order, root history,
   required-transparency acknowledgement and exact V4/private evidence.
6. Prove two-router correctness in isolated tests before approving a second
   production router. Verify that one instance can disappear without a duplicate
   settlement, reordered proof or loss of accepted-work recovery. Then exercise
   the approved live smoke at low volume.
7. Qualify 1M logical route attempts/day first, then larger tiers as workload
   evidence justifies. Confirm actual facilitator quotas/fees separately from
   fixture capacity and keep the separate MainNet signer boundary intact.

Each implementation step gets exact-diff security and functional review before
merge. Deployment and spending retain their separate explicit approvals. Adding
resources cannot substitute for removing an unsafe process-local assumption.

### Load and growth evidence

| Logical attempts/day | Average attempts/second | Initial 5x burst test target |
| --- | --- | --- |
| 1,000,000 | 11.57 | 57.87 |
| 20,000,000 | 231.48 | 1,157.41 |
| 50,000,000 | 578.70 | 2,893.52 |

These are arithmetic test targets, not achieved capacity or verified competitor
traffic. Confirm reporting periods and whether a claimed transaction count means
attempts, successful settlements or cumulative ecosystem activity.

A paid success can need both verification and settlement calls plus several
seller probes and durable records. At 1M routes/day, five probes per route means
5M outbound probes/day. Benchmark slow/failed sellers, concentrated single-host
traffic, duplicates, verified free misses, malformed/abusive traffic and realistic
rail mix. Keep load generators and seller/facilitator fixtures separate from the
system under test; no high-volume MainNet payments or uncontrolled seller load.

Record completed attempts, unique admissions, paid successes, p50/p95/p99 latency,
queue/handler saturation, CPU/memory, database lock/WAL/byte growth, PQ append time,
429/503 rates, external-call quotas and measured infrastructure cost. Define the
latency/error SLO before the run. Require a representative 24-hour soak at the
claimed daily tier plus burst/failure/restore cases; a short loop of DB inserts
does not qualify the application.

For storage sensitivity only, 1 KB retained per admitted identity at 1M new
identities/day is 30 GB/month before indexes, WAL, backups or PQ/history data.
At the listed storage unit price that is $8.40/month of additional provisioned
capacity for each such 30 GB increment. Measure actual bytes; 10 GB is a starting
footprint. Implement compact permanent replay identities and bounded/archived
detail retention without weakening uniqueness or private expiry.

Protect service availability by refusing excess new work before payment rather
than admitting unlimited work into an exhausted queue. This sacrifices some
throughput under overload, so a large integration needs a measured quota,
burst allowance and a staged traffic ramp. Hard $100 spending and unlimited
unannounced traffic acceptance cannot both be guaranteed.

Agree a separate growth-budget decision before a major launch if measured demand
needs it. Keep the current $100 limit until explicitly changed; do not silently
enable unbounded autoscaling or provider upgrades. Revenue calculations must count
actual successful paid routes, not all attempts, and subtract variable facilitator
and network COGS.


## Release decision record

Unfilled fields are blockers, not implied approvals:

- Candidate SHA and image digest:
- Exact-diff 402security disposition/evidence:
- 402QA disposition and staging/restore evidence:
- Verified private budget reference and approved limits:
- Actual production identity/one-writer/anchor baseline:
- Operator deployment and buyer execution mechanism:
- Bounded live test count, gas/fee policy and observation window:
- Recovery procedure and stop owner:
- Ross explicit SQLite deployment GO:
- Ross explicit bounded MainNet GO:
- PostgreSQL activation: NO (outside this release).
