# Batch and session observations

Batch observations use a separate v5 proof. They are current, unpaid observations of one explicitly requested API. A valid observation costs the normal 3,000 atomic USDC ($0.003) router fee. The router does not deposit capital, open sessions, issue vouchers, aggregate merchant payments, or decide fulfillment. Misses skip settlement and create no route leaf.

The feature defaults off. Operators enable only qualified profiles through the comma-separated `BATCH_OBSERVATION_PROFILES` setting. No discovery or arbitrary request body is supported. A request must contain `url`, `merchant_profile`, `buyer_limits`, and `require_route_binding: true`. The URL is the exact HTTPS GET URL including its original query order and encoding. Only the existing controlled-lab `lab_test` marker is additionally accepted. Unknown keys, repeated JSON keys, unsupported policies, redirects, ambiguous challenge headers, and truncated raw responses fail closed.

## Explicit buyer limits

| merchant_profile | Required buyer_limits |
|---|---|
| `base-x402-batch-v1` | `network`, `asset`, `recipient`, `receiver_authorizer`, `withdraw_delay_seconds`, `max_call_amount_atomic`, `max_cumulative_amount_atomic`, `max_capital_atomic` |
| `solana-mpp-session-v1` | `network`, `asset`, `recipient`, `operator`, `program_id`, `max_session_cap_atomic` |
| `algorand-atomic-two-item-v1` | `network`, `asset`, `recipient`, `fee_payer`, `max_item_amount_atomic`, `max_total_amount_atomic`, `max_sponsor_fee_micro_algo`, `job_hashes` (two independent SHA256 pins) |
| `algorand-atomic-batch-v1` | `network`, `asset`, `recipient`, `fee_payer`, `max_total_amount_atomic`, `max_sponsor_fee_micro_algo` |

Atomic amounts are canonical positive decimal strings bounded to uint64. Base currently pins Base USDC, the reviewed CDP receiver authorizer and a 900-second withdrawal delay. Its observed per-call price is distinct from the buyer's cumulative and capital limits; call cap must not exceed cumulative cap, which must not exceed the capital cap. This initial profile does not authorize top-ups.

Native Solana sessions pin mainnet USDC, the reviewed channel program, operator, and recipient. Only push sessions without split recipients are accepted. The offered `cap` is a session ceiling, and `minVoucherDelta` is a voucher increment. Neither supplies a per-call price. The returned `per_call_amount_atomic` is explicitly null. Buyers must establish their service economics separately before funding.

The controlled-lab Algorand profile requires the complete version-1 two-item manifest, the exact request hash, both job hashes, total amount 2,000, payment indices 1 and 2, sponsor index 0, and the pinned fee payer. Its two jobs and sponsor are an on-chain atomic group; this does not promise atomic HTTP fulfillment.

The generic `algorand-atomic-two-item-v1` profile accepts other exact HTTPS GET APIs implementing the same reviewed version-1 manifest. Its positive item amount comes from the observed challenge, and the manifest total must equal exactly twice that amount. Both per-item and total buyer caps are mandatory, along with both independently supplied job hashes. Payment indices, same recipient, sponsor index and sponsor fee ceiling remain fixed. This supports a defined two-item group, not arbitrary transactions or a claim of service quality.

## Proof and signing boundary

`402signal.route_decision.v5` commits to evidence version 3: the complete `request_json` and `batch_binding`. The binding includes exact GET context, all buyer limits, original raw challenge channels, their hash, independently parsed typed terms, observation time and expiry. It expires after at most 60 seconds, earlier if a native challenge expires. Public PQ leaves contain only type, minute-rounded timestamp, nonce and commitment. Raw merchant data and buyer limits remain in the private response/recovery evidence and are not written to observation history or public leaves.

Use `verifyBatchRoute` or `withVerifiedBatchRoute` from `@402signal/route-guard/batch` with the original route request JSON, response JSON, independently pinned log verification key, and original challenge `{status, bodyText, paymentRequired, wwwAuthenticate}`. Missing channels are explicit null. The verifier checks the v5 domain, commitment, Merkle inclusion, Ed25519 checkpoint, exact request and raw challenge, all policy pins and expiry before returning the observation or invoking the callback. An observation is not a blanket signing or spending authorization.

The buyer-owned wallet adapter must separately confirm the router payment, enforce durable intent and budgets, explicitly authorize signing, and independently validate current chain state before funding or issuing vouchers. For Solana, retain the original signed observation challenge; a fresh HTTP challenge can legitimately contain a different recent blockhash. Independently verify chain freshness and authorities before funding. Never automatically resend or sign again after an uncertain result. Existing private route recovery retrieves the same stored response and preserves the original expiry.

The old v4 exact-payment contract is unchanged. Batch/session lifecycle support and live qualifications must be stated separately from observation support; enabling a profile does not certify every merchant using that chain.
