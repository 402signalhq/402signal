# Documentation

Start with the [developer guide](https://402signal.com/developers) or [repository overview](../README.md). This index separates buyer contracts, operating procedures and historical release evidence. Source availability, a passing fixture and a deployed live qualification are different states.

Current published client and guard: [route-guard v0.7.0](https://github.com/402signalhq/402signal/releases/tag/route-guard-v0.7.0). Separate published archives: [session-client v0.1.1](https://github.com/402signalhq/402signal/releases/tag/session-client-v0.1.1), [Algorand batch buyer v0.2.0](https://github.com/402signalhq/402signal/releases/tag/algorand-batch-buyer-v0.2.0), and [native Base MPP client v0.1.0](https://github.com/402signalhq/402signal/releases/tag/mpp-client-v0.1.0). The [dated lab results](../integration/lab/BATCH_QUALIFICATION.md) distinguish earlier two-call/two-item tests from three-call Solana continuation, three-payment Algorand groups, three-job invoices, a native Algorand lab charge and one external native Base MPP UUID purchase. A separate Base v2 continuation campaign also completed three accepted calls and independently finalized settlement and refund. Qualification covers these specific endpoints and explicit limits; it is not a high-count or universal merchant claim. Keep buyer wallets and private operator policy outside the public repository.

Start free with the [offline buyer checks](../integration/buyer-checks/README.md), then use the [customer task guides](https://402signal.com/developers). Pilot teams can use the [adapter evaluation kit](adoption-pilot.md).

## Integrate a buyer

- [Exact x402 request binding and the v4 guard contract](proof-carrying-route-v1.md)
- [v5 batch and session observation contracts](batch-observation-v1.md)
- [Explicit continuation budgets and recovery for Base and Solana](../integration/session-client/README.md)
- [Larger Algorand groups and aggregate invoices](algorand-manifests-v2.md)
- [HTTP recovery-only request contract](route-recovery.md)
- [Private recovery scope, retention and permanent economic identity](replay-recovery.md)
- [Completed unpaid misses versus operational failures](route-miss-http-status.md)
- [Client recovery, safe diagnostics and controlled test history](route-recovery-observability.md)
- [Dated protocol and provider compatibility reference](x402-compatibility-2026-09.md)

## Protocol and evidence

- [Historical v3 evidence format; retained records remain verifiable](route-decision-v3.md)
- [Authorization identity and settlement replay boundaries](settle-idempotency.md)
- [What settlement evidence establishes](settlement-provenance.md)
- [Settlement versus required signed evidence](route-transparency-atomicity.md)
- [Independent MainNet signer wire and validation contract](signer-mainnet-spec.md)

## Operate and recover

- [Private admission configuration and customer access revocation](admission-operations.md)
- [Managed PostgreSQL authority, runtime privileges and instance fence](runbooks/managed-postgres-functions.md)
- [Liveness and readiness](fly-ready-check.md)
- [Complete SQLite recovery component and restore procedure](backup.md)
- [Incremental transparency publication and explicit repair](transparency-storage.md)
- [Dependency locks, runtime identity and volume migration](docker.md)
- [Facilitator API authentication](payai-auth.md)
- [Durable automatic MainNet anchoring, kill switch and recovery](pq-automatic-anchoring.md)
- [Private signing-key generation and custody boundaries](pq-key-ceremony.md)
- [Isolated recovery scenarios and invariants](pq-recovery.md)
- [Historical fee assumptions; obtain a current quote before funding](pq-funding.md)
- [Read-only preservation of the historical TestNet log](pq-testnet-archive.md)
- [Controlled production routing tests and traffic provenance](runbooks/lab-route-testing.md)
- [Repository branch protections](github-protection.md)
- [Role boundaries and explicit operator authorization](automation-security-boundaries.md)

## Scaling plans and historical release evidence

These documents preserve decisions and safety requirements from specific releases. Their candidate statuses, account assumptions, dollar budgets and one-time commands are not a current production inventory or authorization to act. Never replay a prelaunch reset against retained live history.

- [Architecture target and gaps, not a throughput promise or live inventory](scale-20m.md)
- [Original migration candidate gates; historical budget/status assumptions](scale-production-gates.md)
- [Dated incremental Merkle measurements, not end-to-end capacity](merkle-bench.md)
- [Historical SQLite release gates and rollback context](runbooks/pr109-sqlite-release.md)
- [Historical security rollout requirements and retained recovery constraints](remediation-rollout.md)
- [Historical MainNet preparation and gate reasoning](pq-mainnet-prep.md)
- [Historical first-event procedure](pq-first-production-event.md)
- [Historical pre-key review; its original NO status is not current deployment status](pq-prekey-closeout.md)
- [Historical empty prelaunch reset; not a live reset procedure](runbooks/mainnet-prelaunch-reset.md)

## Integration packages

- [Native MPP charge offer selection and full-response binding](../integration/mpp-client/NATIVE_SELECTION.md)
- [Explicit native Algorand MPP charge adapter](../integration/mpp-algorand/README.md)
- [Node/TypeScript client and offline guard](../sdk/route-guard/README.md)
- [Reference buyer](../integration/reference-buyer/README.md)
- [x402 mppx gateway adapter](../integration/mpp-client/README.md)
- [MCP adapter](../integration/mcp/README.md), [Glama release procedure](glama-release.md), and [tool-description contributor guidance](mcp-tool-descriptions.md)
- [Controlled lab](../integration/lab/README.md), [batch qualification](../integration/lab/BATCH_QUALIFICATION.md), and [independently gated HTTP profiles](../integration/lab/BATCH_HTTP.md)
- [Buyer-owned Algorand payment adapters](../integration/batch-buyer/algorand/README.md)
- [Installable Base and Solana continuation clients](../integration/session-client/README.md)
- [Owner-operated session and batch campaigns](../integration/lab/owner-runtime/README.md)

## Scope and privacy

Operating runbooks describe mechanisms, not live secrets or private customer policy. Retain recovery contracts, independent signer specifications and historical proof formats even when simplifying the public entry points. The public observation model is distinct from private hosted admission policy. Removing prose does not make previously public code or git history confidential.

Report security-sensitive issues through the [private security contact](https://402signal.com/contact#security). The [license](../LICENSE) governs the source.

- [Native Base MPP charge client](../integration/mpp-client/NATIVE.md): signed observation, buyer-owned authorization, durable attempt and separate transport.
