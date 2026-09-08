# Fresh owner-operated manifest qualification

This repository-only runner is for two explicit, separately reserved examples: three equal USDC payments in an atomic group, or one merchant-declared invoice payment for three jobs. It does not load service keys, custody customer funds, activate the lab or sponsor production fees. It requires a separately reviewed release capsule and owner campaign configuration. Native MPP charge is a separate adapter.

Each immutable campaign reserves6000atomicUSDC before any wallet callback: exactly3000for one402Signal observation and3000for the merchant. A group has three1000payments plus one sponsor; an invoice has one3000payment plus one sponsor. The two examples together cap gross outboundUSDC at12000($0.012). Provider-sponsored native fees are capped at2000microALGO per router group,4000for the merchant group and2000for the invoice; buyer native fees are zero. These limits require a fresh1000minimum/zero-per-byte quote and do not establish commercial facilitator pricing. The campaign deadline is at most4hours; its original quote/proof remains45seconds and never renews.

## Owner commands

From the reviewed repository-layout capsule, using Node24 and existing pinned lab/package dependencies:

```
node integration/batch-buyer/algorand/manifest-owner-cli.mjs plan /private/group-owner.json /private/release-pins.json /private/group-journal
node integration/batch-buyer/algorand/manifest-owner-cli.mjs run /private/group-owner.json /private/release-pins.json /private/group-journal
node integration/batch-buyer/algorand/manifest-owner-cli.mjs recover /private/group-owner.json /private/release-pins.json /private/group-journal
```

`run` reserves and submits one router authorization, independently checks both router transactions, verifies the signedv5 proof against its retained original merchant challenge, signs the exact manifest once, submits it once, and independently checks every group transaction and a common confirmed round. It does not request a replacement merchant offer. The actual pinnedx402 SDK client receives a bounded, independently validated suggested-params snapshot; it cannot introduce its own RPC fetch. All ordinary HTTP is exact-target, bounded and redirect-free.

`route` and `deliver` are explicit separated stages for operator-supervised work. If a lost router acknowledgment is recovered while the original proof is still fresh, the operator may explicitly choose `deliver`; recovery itself never advances to signing. Any existing merchant plan blocks another delivery call, including after signing or transport failure. Re-running `run` never creates another route authorization. A successful resource acknowledgment remains distinct from independently confirmed chain effects.

`recover` and `status` do not load the owner factory or access wallet environment values. Merchant recovery sends only Replay-Only1 plus Manifest-Group-Id, Manifest-Request-Digest and Manifest-Authorization-Digest. No signed credential is sent to the merchant in recovery. A missing/mismatched receipt, unknown transaction or conflicting round remains unresolved. Recovery may reconcile retained work after campaign/quote expiry without granting new authority.

Only explicit economic commands accept `LAB_MANIFEST_OWNER_ACK=reviewed-fresh-group3-or-invoice3-6000` and the existing owner variable `LAB_BUYER_ALGORAND_KEY_B64`. The guarded signer reads that key only after validating the transaction bytes and signer indexes. No other wallet key is needed. Keep the capsule read-only and the exact configured journal directory private; the owner deployment wrapper must prevent changing to a new journal directory to repeat a campaign.

Every command verifies the source file hashes in the reviewed release-pins document and its digest in the immutable configuration. Root prepares final merged source/capsule identity after release; placeholder pins must not be used in a live campaign. Existing historical two-item campaign directories and owner factories are not used by this runner.

## Qualification

`node --test integration/batch-buyer/algorand/manifest-owner.test.mjs` uses deterministic public test keys, a synthetic signed router log and actual pinned SDK clients/facilitators. It covers both complete payment shapes, source-pinned CLI execution, restart, competing workers, lost acknowledgments, expiry during signing, no-wallet recovery, contradictory receipts and mismatched confirmation rounds. It performs no live payment. Regenerate its synthetic proof fixture from the repository root with `PYTHONPATH=.:tests python integration/batch-buyer/algorand/test/generate-manifest-owner.py`.

Hosted facilitator multi-transaction acceptance still requires separate live qualification. Public exact/mainnet support and advertised sponsorship alone do not prove a hosted group's commercial policy. No automatic network-fee funding or unlimited-price promise is made.
