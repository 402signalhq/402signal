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

## Separate future PostgreSQL decision

PostgreSQL remains off. A later proposal must independently satisfy all
[scale-production-gates](../scale-production-gates.md), including provider failover
durability and connection limits, full cost inventory, exact-SHA reviews, staged
failure/restore evidence, and confirmation that every runnable/rollback image is
fence-aware. Migration sequencing remains: stop/drain all writers, expire private
windows, verify off-host backup, verify import/digest, commit source fence, then
activate destination. An uncertain or partial cutover is never automatically retried.

Catalog, observed history and ordered PQ writes remain process-local. Shared replay
does not authorize multiple routers. Async serving, shared state, ordered batched
PQ, archival retention, load/failure tests and a representative soak remain future
work and require measurements before capacity/cost claims.

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
