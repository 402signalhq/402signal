# Build or test a 402Signal integration

Choose a task in the [customer guide index](README.md) or the [developer page](https://402signal.com/developers). Start with the [offline buyer checks](../../integration/buyer-checks/README.md), which use a real verifier and synthetic inputs. The [optional customer skill](../../skills/402signal-buyer-checks/SKILL.md) follows the same guidance.

A check, a wallet authorization, a merchant acknowledgment and a confirmed payment are different events. Use the specific profile and current released package, preserve raw evidence and keep signing authority and approved policy in trusted buyer code. For the exact authorize path, install the published route-guard 0.7.2 GitHub archive with `node scripts/install_route_guard.mjs` (writes `exact-authorize.mjs`), then wrap existing sign with `wrapExactAuthorize`. The same wrap covers a hosted `session=open` when `require_route_binding` is true. Hops do not go through the wrap. On HTTP 503 with `binding_error=route_binding_unavailable`, the wrap returns `state=binding_unavailable` and `keep_calling_route: true` so the next `/route` call can proceed. That is policy working, not a crash. See [Check one purchase](https://402signal.com/developers/check-offer).

Sellers can [inspect their listing and unpaid readiness](sellers.md). This is not a payment certification, receiving-account simulation, uptime-monitoring service or ranking guarantee. Operators can [review retained observation evidence](evidence.md) alongside approved policies and wallet records. The public log is not a full record of agent actions or a backup of private evidence.

## Hosted session

A hosted session is a paid `/route` product, not the merchant [session client](../../integration/session-client/README.md).

- Open: **$0.005 USDC** (`session=open`). No tiers. `require_route_binding` is allowed on open and can emit a v4 receipt. `wrapExactAuthorize` is the default MIT guard on that open. Hops do not call `route_binding.build` and do not use the wrap.
- Window: **20 hops or 10 minutes** on the bound snapshot from open, then open again. The 20s observation cache applies to new listed-URL probes, not hops.
- Hop: `session=hop` plus `session_id`. A raw session id (or any other value) in `session` is `invalid_session_shape`: HTTP 200, no probe, no routing fee. Hops do **not** run a new 7-URL probe and do **not** call facilitator `/verify` or `/settle`. Optional `scheme`, `amount_atomic`, and `payTo` are checked against the ceiling and channel shape stored at open; a break misses and does not settle. A hop that restores the bound winner reports `route_outcome.code=session_hop` and `next_action=none`, not `free_miss`.
- The merchant session-client contract is unchanged.

## Check credits (API key, v0)

A check credit is an operator-issued hashed token sent as `X-402Signal-Trial`. It lets you run checks against catalog-listed URLs without a funded wallet, so you can try the hosted check in minutes. There is no public mint endpoint; ask for one at ross@402signal.com with the subject "check credits", your intended use and the endpoints you want to check.

- Default scope: **5 listed-URL checks**, **48-hour TTL**. Operators can issue up to 1,000 checks and 30 days. A listed-URL probe that is not live still consumes a credit.
- Listed URLs only: unlisted hosts return `miss_reason=unlisted` without a probe. Paid checks with a wallet cover any public HTTPS URL.
- No facilitator settlement on the credit path. `billing.settlement_state` is `not_attempted`.
- Rows are labeled `traffic_class=sponsored` and never move public reliability data (`last_success_402`, `n_7d`).
- Once credits are spent, the same request returns the real $0.003 / $0.005 payment challenge. `search_depth=thorough` is rejected on credits.
- Check your own balance any time: `GET /keys/usage` with the same `X-402Signal-Trial` header returns `credits.remaining`, `used`, `ceiling` and `expires_at`. Send `X-402Signal-Key` on the same request to see whether an admission key is recognized and the ingress and unpaid capacities it carries. The answer covers only the credentials you present; there is no listing.

## Change alerts (admission key)

With an admission key you can subscribe a webhook to the sellers you depend on: `POST /alerts` with your `url`, up to 20 `hosts` and the `events` you want (`price`, `recipient`, `liveness`). Deliveries are signed, at least once, and fire on the same public observations the endpoint pages count. See [Change alerts](alerts.md).
