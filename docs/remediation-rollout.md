# Security remediation rollout

Baseline: PR103, `907332590e4452607df3cdb2be7d315286907f6f`.
This change addresses review findings F1–F10 in source and fixture tests.
Production rollout, account controls, and recovery policy require the
operator steps below. No fresh MainNet transaction is part of these tests.

| Finding | Source remediation | Production completion requirement |
| --- | --- | --- |
| F1 private replay | Separate client-generated Replay-Key, complete request binding, legacy payload removal, finite response retention | Deploy; clients retain private keys for recovery |
| F2 replay storage | Verification precedes durable reservation; bounded memory, payload, database and free-space admission; real write readiness check | Deploy; monitor disk and admission failures |
| F3 slow reads | Absolute deadlines at the underlying receive layer for inbound headers/body and outbound response headers/body | Deploy; confirm healthy ingress with a bounded staging check |
| F4 MCP | Standard envelopes, error results, version negotiation, empty notifications, Origin validation, official SDK regression | Deploy; integrations use supported protocol and metadata endpoint |
| F5 recovery | Replay-first writer locks, complete four-database bundle, hashes/integrity/schema/public identity checks, isolated restore | Schedule protected off-host copies and rehearse current production backup |
| F6 release publisher | Exact release and SHA-256 verified before execution; OIDC scoped to publishing job | Merge workflow; validate the pinned artifact and manifest |
| F7 runtime user | UID/GID 10001, no startup ownership changes, explicit volume migration plan | Stop writer, migrate existing volume, verify non-root deployment |
| F8 independent review | Expanded CODEOWNERS and read-only fixture CI | **Open:** owner has one GitHub account; a second eligible reviewer is needed |
| F9 trust UI | Copy confirmed/current log origin rather than the TestNet constant; accurate historical-observation label | Deploy |
| F10 lab capacity | Lookup before new admission; invalid verification/input creates no durable row; response expiry, capacity readiness | Deploy lab; preserve existing payment and buyer budget records |

## Before deployment

1. Review the exact commit and passing CI results. Keep the previous image
   digest and volume identifiers in the operator's private rollout record.
2. Verify the actual Fly volume snapshot schedule, retention, last successful
   snapshot, and restore access. Store an encrypted complete application bundle
   off-host with restricted access. Backups contain private route results and
   financial records even though they contain no wallet keys.
3. Validate a complete backup with an independently retained public log origin
   and vkey. Rehearse into a **new** isolated directory. Verify replay settled
   and pending/unknown records still block a second economic action. Validate
   tree size, root, checkpoint signature and existing confirmed anchor identity.
4. Stop the single router writer for the ownership migration. Save the JSON
   plan from `scripts/prepare_volume.py --volume /data`. Review its exact paths
   and previous modes/owners; it covers the five known SQLite files and their
   journals, never a recursive directory traversal. After a verified backup,
   the volume administrator applies `--apply --router-stopped`. Keep the plan
   as the ownership rollback record.
5. Start one router using the reviewed image. Verify UID/GID 10001, successful
   SQLite writes, `/health` and `/ready`, public MCP client behavior, private
   cache rejection, and the MainNet origin display. Confirm private files remain
   unavailable over HTTP. A full ledger must stop new admission without
   bypassing economic deduplication. Inspect only coarse operational status.
6. Deploy the lab from the same reviewed commit and its locked dependencies.
   Its `/ready` now reports capacity. Preserve seller payment rows and buyer
   spend/intent records. Do not reset campaign budgets or restart unresolved runs.

## Rollback and recovery

Rollback changes the application image, **not** the replay database or log
epoch. Never restore an older replay ledger over newer payment history just
to make a service start: doing so can reopen authorizations. Pending/unknown
records remain closed until reconciled. The additive replay schema is readable
by PR103, but PR103 lacks private replay authorization; rolling back to it
reintroduces F1, so paid routing must remain unavailable until that exposure is
addressed. Preserve the newer database, latest off-host bundle and rollback plan.

The migration removes old response payloads but preserves all authorization
identities. Do not recreate missing response payloads from public transactions.
Use the original buyer's records and independent chain confirmation for recovery.

## Operator items that source changes cannot attest

- Independent review remains unresolved with one GitHub account. Do not enable
  a rule that makes every PR unmergeable and then rely on permanent bypass.
  Add a trusted second reviewer with repository write permission, confirm
  CODEOWNERS membership, then require at least one approval, owner review,
  dismissal of stale reviews and approval of the most recent push. Preserve
  strict `test`, `analyze (python)` and `analyze (javascript-typescript)` checks
  and verify the effective rules including every bypass actor.
- Inspect Fly/GitHub access, MFA, roles and unused credentials through operator
  administration. No compromise was established; do not rotate transaction keys
  or change signer policy without a concrete custody and rollback plan.
- The private signer and its network isolation, IPC authentication, fee limits,
  rollback protection and key custody require a separate authorized review of
  its source and deployed configuration. This public-router patch does not
  attest those controls.
- Assign an alert owner for disk pressure, readiness failures, stale backups,
  anchor lag and replay admission refusal. Single-machine availability remains
  an architectural limitation; adding another writer requires a shared durable
  economic ledger design first.

The prior PR103 paid matrix is historical evidence, not authorization for new
spending. Any post-deployment paid validation needs its own bounded spending
plan. Public health checks, existing-receipt reconciliation and local fixtures
do not require new transactions.
