# Owner-operated batch qualification runtime

These explicit stage APIs run on an owner-controlled Linux/WSL host using Node24. Wallet signing capabilities and provider authentication are supplied by the owner. They are never loaded by the merchant server. This is a bounded live qualification tool, with one campaign and channel, not a production scheduler.

Install the existing pinned lab and native-session lockfiles and build the lab before copying the qualified runtime. Preserve the lab directory layout, compiled `dist`, synchronized `sdk`, `owner-runtime`, and `solana-session-contracts` with its own locked dependencies. No new packages or services are required. Local journals use owner-only directories,0600 SQLite files and full synchronous commits. Never copy a live journal to the merchant server or a public repository.

## Base

`createLocalBaseCampaign({directory,campaignId,plan,rpc})` returns the qualified `BaseBatchController` with local SQLite stage and operation journals. The public plan is the existing `BaseBatchPlan`: payer/payerAuthorizer, isolated receiver, receiverAuthorizer, BaseUSDC token, fresh salt, withdrawal delay900, HTTPS resource, per-call amount, deposit, maxCalls, expiration, zero buyer gas and reviewed contract/collector code hashes.

Use `createCdpBatchProvider({authorization})`. The owner callback receives only `{url,method}` for the pinned `https://api.cdp.coinbase.com/platform/v2/x402/{supported,verify,settle}` endpoints and returns `{Authorization:'Bearer ...'}` using the existing private CDP auth mechanism. Credentials stay on the owner host and are sent only to that provider. Each API call is single attempt, no redirects, bounded timeout/body and no automatic retry.

Sequence: initialize; prepareDeposit(ownerSigner); sendDeposit(provider); independently confirm('deposit'); deliver exact bounded vouchers using `createMerchantSender(url)` (unwraps the merchant `billing` fields); close(sequence); sendCloseOperation('claim') then independent confirm; sendCloseOperation('settle') then confirm; sendRefund then confirm, or closeEmpty if no remainder. Do not advance an unknown state. Provider acknowledgement alone never establishes settlement.

Before any funded campaign quote the deposit, expected merchant cumulative spend, refundable remainder,402Signal fee, and authenticated provider charges/minimums. The controller requires zero native buyer gas. Provider cooperation for refund must be checked before funding. Before any delivery is attempted, `sendUnspentRefund(provider)` can cooperatively return the entire independently confirmed deposit. The SDK deposit already issued one known initial voucher; the refund reuses that voucher without another signature. It requires no delivery stage/sign intent/send, unchanged finalized balance/refund nonce and zero claimed/settled watermarks. Independently confirm the refund before closing the reservation. A concurrent claim or unknown merchant delivery remains fenced and requires explicit operator reconciliation. This runtime does not add a unilateral withdrawal executor.

## Native Solana

The cloud merchant factory `createNativeSessionMerchant({ledger,rpc,url,policy,perCallAtomic,maxCalls})` contains no signer or broadcaster. It issues an empty-body402 with one `WWW-Authenticate` on the first unsigned GET to `/solana/session/sha256`. The fixed challenge is bound to one campaign and expires within60seconds; replacement requires a new explicit campaign. It accepts only the complete locally co-signed, already confirmed open transaction and at most two fixed-increment push vouchers. It independently checks the finalized transaction/channel and verifies vouchers with the pinned SDK. It has no close, top-up, pull, or commit endpoint. `Replay-Only:1` returns an exact stored response or unavailable, without chain reads or new work.

Public policy fields: `payer`, `operator`, `recipient` (initial operator equals recipient), `programDataAddress`, `programDataSha256`, `maximumOperatorOpenLamports`, `depositAtomic`, `maxSessionAtomic`, `gracePeriod:900`, `voucherExpiresAt` (Unix seconds,900..86400seconds ahead), and nonzero u64 `salt`. The session cap is a maximum, not a unit price; the live lab separately configures a fixed delivery increment and maximum two calls. The owner also explicitly supplies `maximumCloseFeeLamports` for cooperative close.

Prepare from the exact observed original native challenge with `prepareSolanaSession`; retain the plan in a `LocalBatchLedger` through `OwnerSessionController.initialize()`. Verify the402Signal batch proof before invoking any owner signer. Do not rediscover a different blockhash/slot challenge and substitute it into an already approved plan.

1. Call `verifySolanaSessionDeployment(rpc,plan)` and retain its live quote before funding/signing. It checks program deployment pin, fresh channel, payer USDC balance, operator balance, current fee and PDA+escrow rent against the operator cap. Static synthetic fee/rent numbers are not a live quote.
2. `controller.signOpen(buyer,rpc)` persists the buyer signing intent before its one partial signature.
3. `controller.sendOpen(credential => openSessionLocally({ledger,plan,credential,operator,rpc}))` adds the operator signature locally, durably retains the full transaction and consumes a one-shot broadcast permit. RPC broadcast uses `maxRetries:0`, preflight enabled. Independent `confirmOpen` remains mandatory.
4. `registerOpenedSession({ledger,send:createMerchantSender(url,{native:true})})` registers the complete already-confirmed open proof once. Then invoke `controller.voucher` with the same native merchant sender for each explicit increment.
5. Use `prepareSessionClose` for the read-only close quote. Existing payer, merchant, escrow and treasury token accounts must match the mint/owners, so no hidden rent-funded account creation is bundled. The program pin is rechecked. Call `controller.close(sequence, credential => closeSessionLocally(...))` once and independently confirmClose using the retained signature. Merchant USDC, buyer refund and rent status are separate evidence.
6. If no voucher has ever been signed, `closeUnspentSessionLocally` can cooperatively refund the complete unused deposit. It requires a durable confirmed open and no first-voucher sign intent. An unknown signed-voucher result cannot use this escape path.

Owner RPC needs the read methods used above, plus `getMultipleAccounts`, `getTokenAccountBalance`, and the explicit `sendTransaction` capability passed only to local operator methods. The cloud merchant RPC remains read-only. No callback tunnel or cloud key custody is required.

## Uncertainty and limits

A lost signature result, broadcast acknowledgement, database acknowledgement or merchant response never grants another send/sign permit. Existing transaction signatures can be independently observed again. Cached merchant results can be explicitly recovered. Source/payment intent must remain immutable across restarts. Do not release an unused budget reservation merely because an HTTP response was lost.

No real wallet, public-chain funding or live provider payment was used in qualification. Focused tests cover actual pinned SDK signatures/transactions, Base lifecycle with SQLite restart, native HTTP open/two vouchers/close, full unused-deposit refund, lost broadcast, unavailable recovery, independent connections and no-retry provider transport. Live chain tests, current provider prices, current rent/fee quotes and delayed rent reclamation remain separate operator steps.
