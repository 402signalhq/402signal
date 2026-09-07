# Two-item Algorand live qualification operator

This repository-only operator composes the tested public buyer adapter with a private durable campaign journal and the offline v5 observation guard. It is a controlled lab qualification, not proof that every Algorand seller accepts groups. No escrow, customer wallet collection, or fulfillment guarantee is introduced.

## Cost and activation

Maximum buyer spend for one new campaign: **5000 atomic USDC ($0.005)**, consisting of one 3000 atomic router fee plus two 1000 atomic merchant transfers. The buyer must pay zero native ALGO. The merchant group carries a 3000 microALGO sponsor fee (0.003 ALGO), bounded by the explicit manifest cap of 15000 microALGO (0.015 ALGO). The separate router sponsor fee must be independently recorded; it is not included in the merchant group fee. Provider sponsorship of the three-transaction group remains unqualified until the actual live test succeeds.

Deploy the existing shared lab image with all new rails disabled. Only after code/proof review, activate this one lab profile using `LAB_ALGORAND_ATOMIC_BATCH=reviewed-two-item-profile-v1`, the existing mainnet seller at unit price 1000, its existing durable volume, and existing facilitator configuration. The application also requires `BATCH_OBSERVATION_PROFILES=algorand-atomic-batch-v1` for the reviewed v5 observation path. Do not enable other profiles implicitly or register this self-test endpoint in the catalog. Existing HTTP admission limits still apply.

## Owner-side execution

Use an existing WSL buyer account. Keep wallet secrets and the hook module in WSL; only public source and synthetic tests belong on the cloud development worker. Build the lab once in the cloud, transfer the reviewed artifact, and retain private journal files in a fresh owner-only directory. Do not reopen a previous closed campaign or increase its immutable cap.

```
node integration/batch-buyer/algorand/campaign-cli.mjs plan /private/policy.json
```

The plan command does not import the owner hook module or create a journal. After the operator has explicitly reviewed the quote and runtime targets:

```
ALGORAND_BATCH_CAMPAIGN_ACK=reviewed-mainnet-5000-atomic-v1 node integration/batch-buyer/algorand/campaign-cli.mjs run /private/policy.json /private/new-campaign one /private/owner-hooks.mjs
node integration/batch-buyer/algorand/campaign-cli.mjs recover /private/policy.json /private/new-campaign one /private/owner-hooks.mjs
```

The CLI requires an owner-written hook module exporting `createRunHooks(policy)` and a separate `createReadOnlyRecoveryHooks(policy)`. No default wallet or HTTP implementation is selected. The owner runtime is part of the trusted signing boundary, not untrusted seller data. Reuse the already qualified lab signer, payment policy, RouteClient and independent confirmation code.

`createRunHooks` supplies:

- `routeOnce(exactRequestJson, routerPins)`: one durable paid request to the pinned router. Enforce exact 3000 atomic mainnet USDC, pinned router recipient/sponsor, buyer native fee zero, current validity, exact request binding and no redirect. Return `{routeResponseJson, ...private recovery evidence}`. Retain the exact authorization in the existing RouteClient store before sending. The campaign calls this hook at most once after reserving the entire 5000 atomic budget.
- `confirmRouter(routeResult, routerPins)`: use independent readonly chain confirmation of that exact buyer authorization, returning `{state:'confirmed',network,asset,buyer,recipient,feePayer,amountAtomic:'3000',buyerNativeFeeAtomic:'0'}` only after it passes. Record actual sponsor fee separately. Provider acknowledgement alone is insufficient.
- `readSellerChallenge(url)`: bounded no-redirect HTTPS GET returning exact `{status,bodyText,paymentRequired,wwwAuthenticate}` channels. The actual fresh challenge and actual router receipt are checked by the pinned v5 guard before the merchant signer is invoked.
- `suggestedParams()`: independently read pinned MainNet RPC and return `{genesisHash,genesisId,minimumFee:'1000',feePerByte:'0',firstValid,lastValid}` with decimal-string rounds and a positive validity window no larger than 1000 rounds.
- `signGroup(raw, indexes)`: existing buyer-owned signer, exactly indexes `[1,2]`. It must not sign the sponsor transaction. The adapter independently checks exact bytes and both signatures afterward.
- `sendSeller(url,payment)`: exactly one bounded HTTPS GET with canonical base64 `Payment-Signature`, no redirects and no retries. Return `{status,body}`. Never retry on transport uncertainty.
- `readAlgod(url,'GET')`: bounded readonly HTTP transport. The adapter verifies every exact transaction, including sponsor, in the same confirmed round.

Recovery hooks expose only `recoverSeller(url,payment,{'Replay-Only':'1'})` and `readAlgod`. The merchant's explicit recovery header returns an existing outcome or unavailable; it never reserves a new group or calls the facilitator. Recovery cannot import a signer through the prescribed separate factory, create a missing campaign stage, or advance from a router-only outcome into a new merchant payment. An uncertain router authorization is reconciled using the existing RouteClient's read-only recovery separately. It never resumes the campaign automatically.

The policy JSON is an exact-key object with `version:1`, `campaignMaximumAtomic:'5000'`, `buyer`, `url`, `buyerLimits`, `trustedLogVkey`, `rpcUrl`, and `router`. Buyer limits are the six explicit v5 Algorand pins/caps (`network`, `asset`, `recipient`, `fee_payer`, `max_total_amount_atomic:'2000'`, `max_sponsor_fee_micro_algo:'15000'`). Router is `{url,network,asset,recipient,feePayer,maximumAtomic:'3000',maximumBuyerNativeFeeAtomic:'0'}`. All live addresses and the PQ verification key must come from independently reviewed deployment configuration, never be inferred from an untrusted challenge. The whole policy is hashed into the journal and cannot change on reopen.

A complete result requires independent confirmation of all three group transactions plus exact indexed SHA256 results. Preserve private evidence, reconcile total USDC and ALGO balance deltas, and keep unused headroom closed. An unresolved result never authorizes another payment; reservations remain consumed even after failure.
