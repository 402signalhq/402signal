# Owner-operated staged batch campaigns

This CLI composes the qualified controllers with `RouteClient`, a durable Base fee journal, and the offline v5 batch guard. It runs in the owner's existing Node24 WSL environment. It creates no service, buys no funds, and never installs a payment-aware Fetch wrapper. All wallet signing and chain broadcasts stay in WSL. The generic cloud merchant has no wallet keys.

The CLI is a controlled lab operator, not an unattended integration or a throughput benchmark. A current route observation proves the advertised terms at that moment; it does not prove future availability, delivery quality, solvency or settlement.

## Capsule layout

Preserve the reviewed repository layout when transporting the cloud-qualified capsule:

```text
/capsule/sdk/route-guard/
/capsule/integration/reference-buyer/       # source + pinned installed dependencies
/capsule/integration/lab/owner-runtime/
/capsule/integration/lab/dist/src/          # qualified cloud build
/capsule/integration/lab/sdk/route-guard/    # synchronized strict parser
/capsule/integration/lab/node_modules/      # installed pinned lab dependencies
/capsule/integration/lab/solana-session-contracts/{src,node_modules,package-lock.json}
```

Resolve dependency symlinks into the capsule; do not carry cloud absolute symlinks. Root verifies the transported capsule hash and mounts source/dependencies read-only. Place the configuration, optional CDP callback and private journal outside that mount. No installation, compilation, development or testing is needed in WSL.

`config.sources` maps every exported `requiredSources` filename from `campaign-cli.mjs` to its reviewed SHA256. Include additional source pins when applicable. `factorySha256` pins the selected factory. Installed dependency bytes are covered by the externally verified capsule hash; checking lockfiles alone is not a verification of installed package bytes. `sourceCommit` records the reviewed 40-hex source commit. All configuration is immutable once the private campaign directory is initialized, including campaign ID, exact request, wallets, budgets, code/program pins and source hashes.

## Public configuration

Common fields: `version:1`, unique `campaignId` (8–64 alphanumeric/underscore/hyphen characters), absolute `directory`, `profile`, exact HTTPS `url`, millisecond `expiresAt`, `maxCalls`, `perCallAtomic`, `depositAtomic`, `trustedLogVkey`, `buyerLimits`, `sourceCommit`, `sources`, `factorySha256`, and:

```json
{
  "router": {
    "url": "https://402signal.com/route",
    "rpcUrl": "https://YOUR_REVIEWED_BASE_RPC/",
    "buyerAddress": "YOUR_BASE_BUYER_ADDRESS",
    "payTo": "YOUR_PINNED_ROUTER_RECIPIENT",
    "feeAtomic": "3000",
    "recoveryProfile": "http-route-v1"
  },
  "budget": {
    "maximumUSDCAtomic": "7000",
    "maximumOperatorLamports": "5010000"
  },
  "maximumCloseFeeLamports": "10000"
}
```

These example ceilings are not an instruction to spend or a current fee quote. Quote/approve the actual campaign before `route`. The USDC ceiling covers the full refundable deposit plus exactly3000 routing atomic units. Native operator capital/rent and close-fee ceilings are separate, and must fit their aggregate lamport cap. The journal reserves the entire authorized campaign; it never silently releases capacity for a replacement attempt. Separate manually created campaign directories are separate operator approvals, not a wallet-wide spending governor.

Native profile `solana-mpp-session-v1` also needs `nativeRpcUrl` and the exact `nativePolicy` shared with the configured merchant: payer, operator, recipient, programDataAddress, programDataSha256, maximumOperatorOpenLamports, depositAtomic, maxSessionAtomic, gracePeriod900, voucherExpiresAt in seconds, and nonzero salt. Operator must equal recipient for this initial close implementation. The native lab permits exactly2deliveries. `buyerLimits` uses `network`, `asset`, `recipient`, `operator`, `program_id`, `max_session_cap_atomic`. A session cap is not a per-call price; this operator's fixed increment is explicit local policy.

Base profile `base-x402-batch-v1` needs `basePlan` exactly as documented in README.md, with the same URL, deposit, per-call amount, maxCalls and expiresAt. Its `buyerLimits` has network,asset,recipient,receiver_authorizer,withdraw_delay_seconds,max_call_amount_atomic,max_cumulative_amount_atomic,max_capital_atomic. Base operator lamport and close-fee caps are both"0". The actual `/base/batch/sha256` lab allows2calls at1000atomic each; the underlying controller can separately qualify3calls against a compatible merchant.

## Local signer factory

Use the included `owner-factory.mjs` and pin its hash. A fresh process captures the native unwrapped Fetch implementation. It accepts existing WSL environment names:

- `LAB_BUYER_BASE_PRIVATE_KEY`:0x-prefixed32-byte Base key; loaded only for route/deposit/Base voucher stages.
- `LAB_BUYER_SOLANA_KEY_B64`:canonicalbase64 of64-byte Solana secret-key representation (seed + corresponding public key); loaded only for native open/voucher stages.
- `LAB_SELLER_SOLANA_KEY_B64`:same64-byte format; loaded only for native open/close/refund stages.
- `REFERENCE_BUYER_CUSTOMER_KEY`:optional router admission credential, sent only to the router.
- `BATCH_CDP_AUTH_MODULE`:owner-local module exporting `authorization({url,method}) -> {Authorization:'Bearer '+jwt}` for explicit Base provider stages. Set `cdpAuthModuleSha256` in config. The callback must create a fresh method/path-scoped CDP JWT for each call and must never retry a provider mutation. Master API credentials stay in that local callback environment.

Read-only stages ignore wallet variables and expose no wallet signers. No key, credential, raw provider error or raw response is printed. Errors preserve journal/evidence and report `newPaymentAllowed:false`. Do not include private configuration, journals, signatures or credentials in public commits.

## Exact invocation

```sh
node /capsule/integration/lab/owner-runtime/campaign-cli.mjs plan /private/campaign.json
```

The `plan` command does not import the signer factory, open the journal or make network calls. After explicit campaign approval, each separate operation uses:

```sh
BATCH_OWNER_ACK=reviewed-once-no-retry node /capsule/integration/lab/owner-runtime/campaign-cli.mjs STAGE /private/campaign.json /capsule/integration/lab/owner-runtime/owner-factory.mjs
```

Do not put keys in command arguments or shell history. Root supplies the existing owner environment privately to the process.

Native sequence: `route`, `preflight`, `open`, `confirm-open`, `register`, `deliver-1`, `deliver-2`, `close`, `confirm-close`. Each command is explicit; inspect its state before the next. `preflight` is the funding preflight after the paid observation; it checks public program/code pins, current balances, rent and fees without signing. `open` creates one buyer signature, one operator signature and one broadcast. Registration sends only the already-confirmed full transaction. Voucher stages each create one capped credential. Close uses the highest known accepted voucher, and independent confirmation checks merchant/buyer token deltas.

Base sequence: `route`, `preflight`, `deposit`, `confirm-deposit`, `deliver-1`, `deliver-2`, `close`, `claim`, `confirm-claim`, `settle`, `confirm-settle`, `refund`, `confirm-refund`. Deposit, claim, payout and refund are distinct provider operations. The router fee remains exactly3000. Provider acknowledgement is never chain confirmation. If the deposited Base amount was fully consumed, use `close-empty` after independently confirmed payout instead of attempting a zero refund. It performs no provider call and requires zero remaining balance above the claimed amount. The owner controller signs an initial deposit voucher; a funded-but-unused Base refund still depends on provider cooperation and zero onchain claimed/settled amounts.

The signed observation expires within60seconds (or sooner for the native offer). Funding and new voucher signatures reverify the original saved response, never fetch a replacement challenge or extend its expiry. Native uses the original router-observed recent blockhash/slot. If chain finality is slow, stop new authority rather than extending the offer. Close/refund and read-only reconciliation can run after offer expiry.

## Uncertain outcomes

Use `recover-route` for the client's bounded `Replay-Only` recovery; it never creates another authorization or ordinary payment POST. `confirm-route` only reads retained responses plus the chain, including after HTTP recovery expiry. A paid fee with unusable/expired merchant observation does not authorize a new merchant payment.

`confirm-open` and `confirm-close` recover from the exact locally persisted native signed transaction, even if the original broadcast acknowledgement was lost. They do not broadcast. The Base `confirm-deposit`, `confirm-claim`, `confirm-settle` and `confirm-refund` commands optionally accept a fourth argument containing an independently discovered existing0xtransactionhash. The observer must still prove exact expected effects; this argument authorizes no send.

`refund-unused` is an explicit one-shot cooperative recovery after an independently confirmed deposit/open and before any delivery authority/intent. Native returns the full deposit without issuing a payable voucher. Base uses its already-issued initial deposit voucher and refuses if delivery intent or changed onchain claimed/refund state exists. For a lost merchant response, `recover-delivery-1`, `recover-delivery-2` (and a separately supported Base third delivery) retrieve only the exact saved authorization with `Replay-Only:1`. Native `recover-register` similarly reconciles the already-confirmed opening registration. Each has at most6explicit read-only attempts. A cache miss, different accounting/receipt, non200response, or lost recovery response leaves the original fence intact; no new signature, ordinary delivery, provider verify/settle, or broadcast is allowed. Recovery works after offer expiry and records exact receipt identity before repairing progress. Unknown signed-voucher outcomes without matching cache evidence remain fenced; the CLI cannot classify them as unused.

Never rerun an uncertain signing/payment stage, change campaign ID or erase the journal. `status` is local only. This CLI intentionally leaves unresolved permits consumed. Native channel PDA rent reclamation after the anti-replay interval remains a separate unimplemented operator step; returned token capital and retained rent are distinct records.

## Qualification

Cloud-only:

```sh
node --test integration/lab/owner-runtime/campaign-cli.test.mjs integration/lab/owner-runtime/owner-factory.test.mjs
```

The tests exercise the real pinned SDKs, actual CLI argument parsing, loopback HTTP, durable owner journals and synthetic independently decoded chain effects. They cover lost router/native acknowledgements, two simultaneous opens, changed proof/source/budget, expired original evidence, no-delivery full refunds, and generic redacted process errors. They also reproduce process interruptions between durable receipt/confirmation records and progress transitions, including the Base operation journal boundary. Repeating confirmation repairs only the matching interrupted transition and never submits another transaction. No production keys, live payments or new provider charges are used.


## Base finalized deposit and a second observation

Base's finalized block follows Ethereum finality and normally cannot confirm a new deposit inside a60-second observation window. Keep finalized receipt/state checks. For this controlled two-call lab campaign, configure `maxRouteObservations:2`, `depositAtomic:"4000"`, `perCallAtomic:"1000"`, `maxCalls:2`, and `budget.maximumUSDCAtomic:"10000"`. The ceiling is two distinct3000-atomic observations plus4000-atomic channel capital. Set the immutable campaign `expiresAt` sufficiently ahead (for example one hour) before starting; this does not lengthen either signed observation.

Explicit sequence: `route`, `preflight`, `deposit`, then read-only `confirm-deposit` until finalized. The initial deposit includes the already-reviewed initial voucher authority; it therefore still requires the original fresh proof. After finalization, `route-after-deposit` purchases one new observation of the same URL and terms under a new durable routing identity. It requires a confirmed, unused deposit and does not retry or replace the original route payment. `recover-route-after-deposit` and `confirm-route-after-deposit` only retrieve/confirm that existing second payment.

The second signed observation must postdate the recorded finalized deposit confirmation. A separate immutable delivery permit binds its full response/proof digest, exact channel, complete campaign terms, deposit transaction and at-most60-second expiry. Original funding plan/expiry remains unchanged. Delivery checks the permit before signing and immediately before sending. Run `deliver-1`, `deliver-2`, then the existing claim/payout/refund closure stages. There is no third observation, automatic refresh, new deposit, top-up or payment retry. If the second result is unavailable, mismatched or expires, only read-only reconciliation and a safe supported close/refund remain; a signed but unacknowledged voucher stays fenced.

Omitting `maxRouteObservations` preserves the original single-observation behavior. Solana remains single-observation. These are explicit lab bounds, not a general claim that every batch funding/finality lifecycle fits one observation fee.
