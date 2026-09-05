# Operator tests through normal production routing

PR #100 uses the normal probe history, reputation, settlement, replay and PQ paths
for operator-owned test sellers. There is no lab exclusion or alternate database.
Self-test provenance does not suppress persistence, promotion, scoring or log append.
Real successful test purchases count as production activity; they do not establish
independent customer adoption. Catalog enrollment is separate from direct URL tests.

Set `LIVE402_LAB_ORIGINS=https://402signal-lab-ross.fly.dev` on the reviewed router
revision to advertise the exact origin under `lab_testing`:
`protocol=402signal-lab-route-v2`, `processing=production`. The origin list provides
provenance, not permission to bypass SSRF, constraints, price, payTo or payment gates.
The old v1 exclusion contract is no longer advertised or accepted as a request marker.
Unmarked ordinary requests retain their existing production behavior.

The v0.4 lab buyer requires the v2 contract before signing and sends both
`require_transparency=true` and `require_route_binding=true`. Its `lab_test` marker
is accepted by binding validation only for an operator-configured origin, and is
committed in private v4 request evidence. The public leaf remains commitment-only;
no leaf schema or Falcon/anchor behavior changes. The response provenance reports
processing policy, not an invented guarantee that a write or anchor succeeded.

A valid settled winner promotes the actual probe batch and uses the ordinary PQ
receipt path. Free misses do not settle, promote trusted observations or append a
route leaf. Rejected or ambiguous settlement does not append. If transparency fails
after settlement, the normal HTTP 503 preserves settled=true and the payment receipt.
Exact/semantic replay must not settle, promote or append again after restart.

The buyer retains private PQ receipt/reveal material with its local run report.
`receipt_observed_unverified` is not a claim of independent verification or anchoring.
Checkpoint signing is distinct from automatic Falcon authorization, submission and
independently confirmed Algorand anchoring. Verify the receipt against a separately
pinned trusted public key, then check automatic anchoring using read-only evidence.
A routing log receipt does not prove the separately executed seller delivered data.

Rollout: review the exact PR head and CI before merging/deploying. Preserve existing
production replay/history/PQ volumes, identities and anchor state. Recheck current
anchor operations immediately before deployment; do not deploy with an unresolved
AUTHORIZED, SEND_ATTEMPTED, SUBMITTED or HALTED operation. No resets, manual signer
calls or synthetic production leaves are part of this change. Keep buyer keys on
the laptop and the public seller free of buyer spending endpoints.

Use the v0.4 buyer guide for one explicitly bounded purchase at a time. Existing
wallets, cumulative budgets, reservations and ambiguous records remain intact.
No backfill is performed for earlier seller-only tests: they never called the router.

Validation includes all three rails with isolated real history/PQ databases,
ephemeral Ed25519 checkpoint keys, v4 reveal/signature/inclusion verification,
restart replay, normal free misses, and truthful settled transparency failures.
No production payment, Falcon invocation or deployment is performed by the tests.
