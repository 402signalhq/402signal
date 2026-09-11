# Build or test a 402Signal integration

Choose a task in the [customer guide index](README.md) or the [developer page](https://402signal.com/developers). Start with the [offline buyer checks](../../integration/buyer-checks/README.md), which use a real verifier and synthetic inputs. The [optional customer skill](../../skills/402signal-buyer-checks/SKILL.md) follows the same guidance.

A check, a wallet authorization, a merchant acknowledgment and a confirmed payment are different events. Use the specific profile and current released package, preserve raw evidence and keep signing authority and approved policy in trusted buyer code. For the exact authorize path, install the published route-guard 0.7.2 GitHub archive with `node scripts/install_route_guard.mjs` (writes `exact-authorize.mjs`), then wrap existing sign with `wrapExactAuthorize`. On HTTP 503 with `binding_error=route_binding_unavailable`, the wrap returns `state=binding_unavailable` and `keep_calling_route: true` so the next `/route` call can proceed. That is policy working, not a crash. See [Check one purchase](https://402signal.com/developers/check-offer).

Sellers can [inspect their listing and unpaid readiness](sellers.md). This is not a payment certification, receiving-account simulation, uptime-monitoring service or ranking guarantee. Operators can [review retained observation evidence](evidence.md) alongside approved policies and wallet records. The public log is not a full record of agent actions or a backup of private evidence.

## Hosted session

A hosted session is a paid `/route` product, not the merchant [session client](../../integration/session-client/README.md).

- Open: **$0.005 USDC** (`session=open`). No tiers. `require_route_binding` is allowed on open and can emit a v4 receipt. Hops do not call `route_binding.build`.
- Window: **20 hops or 10 minutes** on the bound snapshot from open, then open again. The 20s observation cache applies to new listed-URL probes, not hops.
- Hop: `session=hop` plus `session_id`. Hops do **not** run a new 7-URL probe and do **not** call facilitator `/verify` or `/settle`.
- The merchant session-client contract is unchanged.

## Trial

A trial is a hand-issued hashed token (`X-402Signal-Trial`). It is not a public faucet and has no mint endpoint.

- Scope: **5 listed-URL opens**, **48-hour TTL**. A listed-URL probe that is not live still consumes a credit.
- No facilitator settlement on the trial path. `billing.settlement_state` is not USDC settled.
- Rows are labeled `traffic_class=sponsored` and do not move public `last_success_402` or public `n_7d`.
- A sixth open returns the real $0.003 / $0.005 payment challenge. `search_depth=thorough` is rejected.
