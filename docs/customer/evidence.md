# Investigate a purchase using retained evidence

A high bill and an agent's summary can disagree. A retained 402Signal observation helps establish what requirements reached the service and which offer it checked. It is not a record of everything the agent did.

## Retain three different records

Keep the operator-approved policy, the original route request and complete response, and the buyer's wallet/execution record. Retain the observation's `pq_trust.transparency.receipt` and private `reveal`. Store them securely outside the agent's writable workspace where practical. The public commitments are not a backup of private evidence.

The submitted requirement is not proof of human approval. If an agent submitted a $0.20 limit, the receipt does not establish that the operator intended $0.20. Compare it with your separately retained approved policy. Transactions that bypassed 402Signal do not appear just because other transactions used it.

A retained paid `/route` response may include slim `compared[]` rows with `selectable`, `payTo_pending` / `payTo_changed`, `risk` and `excluded_reason`, including `binding_unavailable` when an already-probed candidate lost because binding evidence was unavailable. Catalog and seller labels remain untrusted; observed payment options drive selection, and those rows do not prove delivery or settlement. When `require_route_binding` is on, the hosted check may select the next already-probed selectable candidate that can bind if the ranked winner cannot; HTTP 503 with `binding_error: route_binding_unavailable` means none remained bindable. A local guard refusal is a stop even if the hosted response named a winner; do not pay the seller without a matching proof.

## Verify before drawing conclusions

Use the matching historical verifier for the record version. For supported v4 records:

```js
import { verifyReceipt } from '@402signal/route-guard';
const result = verifyReceipt({
  routeResponseJson,
  routeRequestJson,
  trustedLogVkey
});
```

These variables come from retained raw records and independent trusted key configuration. Do not accept the trust key from the same response being verified. Do not parse and reserialize untrusted JSON before verification. This checks signature and inclusion, does not invoke a signer, and does not refresh expiry. The returned scope marks the current quote, payment confirmation, anchor and delivery as not checked.

Run `node integration/buyer-checks/run.mjs` for a synthetic example in which the original historical record verifies and an altered covered policy fails. It is not a test of Falcon anchoring.

## What later anchoring adds

The immediate checkpoint uses Ed25519. Cumulative checkpoints are subsequently anchored on Algorand MainNet using Falcon authorization. For covered records, independently checking the appropriate confirmed anchor supplies a separate history reference against later changes. Pending records are not confirmed anchors.

Post-quantum checkpoint authorization is not a blanket claim that the entire evidence pipeline is quantum secure. Original receipts, payment signatures, hash assumptions, retained data, trusted key history and verification software still matter. The local historical verifier above does not verify the later chain anchor. Preserve the evidence needed for long-term review rather than relying on a permanent-storage promise.

The log cannot reconstruct deleted private records, prove delivery, explain internal model reasoning or reveal bypassed activity. It is not an automatic agent-monitoring dashboard. It makes a specific observed record verifiable, which is useful evidence alongside your own controls and records.

Trust overview: https://402signal.com/how#trust
Checkpoint viewer: https://402signal.com/transparency
