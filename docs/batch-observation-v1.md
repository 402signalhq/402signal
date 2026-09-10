# Check group offer

Job `#1` is **Check group offer**. The durable job token is `chk_grp`. The human label is `Check group offer`.

This is a current, unpaid observation of one explicitly requested HTTPS GET API. A valid observation costs the normal 3,000 atomic USDC ($0.003) router fee. The router does not deposit capital, open sessions, issue vouchers, aggregate merchant payments, or decide fulfillment. Misses skip settlement and create no route leaf. The public PQ v5 leaf stays commitment-only (`type`, `ts`, `nonce`, `commitment`).

The feature defaults off. Operators enable codecs through the comma-separated `BATCH_OBSERVATION_PROFILES` setting. Tokens may be codecs (`exact`, `sess`, `mpp`, `atom`, `inv`) or legacy internal profile names, which map to those codecs. Empty enablement keeps the job off.

No discovery or arbitrary request body is supported. A buyer request contains `url`, `buyer_limits`, and `require_route_binding: true`. The URL is the exact HTTPS GET URL including its original query order and encoding. Buyers do not pass `merchant_profile`. The server auto-selects a codec from the live seller challenge. Unknown or ambiguous wires fail closed. Refuse-on-drift is unchanged: detected codec, buyer caps, and optional lab-only profile must agree.

Architecture: [lab profiles vs customer auto-detect](check-group-offer-architecture.md). Live admission accepts `merchant_profile` only with `lab_test`. Offline fixture verify may still carry a historical profile. Unknown keys, repeated JSON keys, unsupported policies, redirects, ambiguous challenge headers, and truncated raw responses fail closed.

## Buyer caps

`buyer_limits` are explicit ceilings. The key set selects the codec before the network call. The live challenge must speak that codec.

| Codec | What the challenge must look like | Required buyer_limits |
|---|---|---|
| `exact` | x402 envelope whose sole `accepts` scheme is `batch-settlement` | `network`, `asset`, `recipient`, `receiver_authorizer`, `withdraw_delay_seconds`, `max_call_amount_atomic`, `max_cumulative_amount_atomic`, `max_capital_atomic` |
| `sess` | `WWW-Authenticate: Payment` with `intent=session` and `method=solana` | `network`, `asset`, `recipient`, `operator`, `program_id`, `max_session_cap_atomic` |
| `mpp` | `WWW-Authenticate: Payment` with `intent=charge` and `method=evm` or `method=algorand` | Base: `network`, `asset`, `recipient`, `max_call_amount_atomic`, `realm`. Algorand: `network`, `asset`, `recipient`, `fee_payer`, `max_amount_atomic`, `max_network_fee_micro_algo`, `realm` |
| `atom` | Algorand atomic-batch extension (two-item, lab two-item, or multi-item) | Two-item / multi: `network`, `asset`, `recipient`, `fee_payer`, `max_item_amount_atomic`, `max_total_amount_atomic`, `max_sponsor_fee_micro_algo`, `job_hashes`. Lab two-item omits `job_hashes` and `max_item_amount_atomic` |
| `inv` | Algorand aggregate-invoice extension | `network`, `asset`, `recipient`, `fee_payer`, `max_total_amount_atomic`, `max_sponsor_fee_micro_algo`, `job_hashes` |

Atomic amounts are canonical positive decimal strings bounded to uint64. An ordinary exact x402 offer (`scheme=exact` with no supported group extension) is not this job; it is refused.

The HTTP result and `compared[]` carry `job`, `codec`, and human `label`. They are not written into the public leaf or the exact v5 binding key set.

## Proof and signing boundary

`402signal.route_decision.v5` commits to evidence version 3: the complete `request_json` and `batch_binding`. The binding includes exact GET context, all buyer limits, original raw challenge channels, their hash, independently parsed typed terms, observation time and expiry. It expires after at most 60 seconds, earlier if a native challenge expires. Raw merchant data and buyer limits remain in the private response/recovery evidence.

Use `verifyBatchRoute` or `withVerifiedBatchRoute` from `@402signal/route-guard/batch` with the original route request JSON, response JSON, independently pinned log verification key, and original challenge `{status, bodyText, paymentRequired, wwwAuthenticate}`. Missing channels are explicit null. The verifier checks the v5 domain, commitment, Merkle inclusion, Ed25519 checkpoint, exact request and raw challenge, all policy pins and expiry before returning the observation or invoking the callback. An observation is not a blanket signing or spending authorization.

The buyer-owned wallet adapter must separately confirm the router payment, enforce durable intent and budgets, explicitly authorize signing, and independently validate current chain state before funding or issuing vouchers. Never automatically resend or sign again after an uncertain result.

The old v4 exact-payment contract is unchanged. Enabling a codec does not certify every merchant using that chain.
