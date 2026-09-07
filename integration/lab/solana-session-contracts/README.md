# Solana session SDK contract fixture

This isolated lab package pins the published `@solana/mpp` 0.7.0 API and its
Solana Kit 6.10.0 peer without changing the existing exact-payment lab dependencies.
Run `npm ci --ignore-scripts` then `npm test` in the approved cloud environment.

Tests use an explicitly public deterministic seed and synthetic channel identifiers.
They do not connect to RPC, fund accounts, open channels, submit transactions or
prove facilitator support. Never fund the test key. No live mode is provided.

The fixture qualifies voucher wire compatibility, signed fields and reference-store
concurrency. A mutable nonce is not signed payment identity. A local sealed flag
does not establish confirmed settlement. The reference memory store loses state on
restart; production session operation would require separate durable accounting,
recovery and on-chain qualification. Customer signing remains with the customer's
wallet. This fixture does not enable 402Signal to hold or adjudicate customer funds.
