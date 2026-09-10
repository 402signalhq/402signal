# Build or test a 402Signal integration

Choose a task in the [customer guide index](README.md) or the [developer page](https://402signal.com/developers). Start with the [offline buyer checks](../../integration/buyer-checks/README.md), which use a real verifier and synthetic inputs. The [optional customer skill](../../skills/402signal-buyer-checks/SKILL.md) follows the same guidance.

A check, a wallet authorization, a merchant acknowledgment and a confirmed payment are different events. Use the specific profile and current released package, preserve raw evidence and keep signing authority and approved policy in trusted buyer code. For the exact authorize path, install the published route-guard 0.7.2 GitHub archive with `node scripts/install_route_guard.mjs` (writes `exact-authorize.mjs`), then wrap existing sign with `wrapExactAuthorize`. See [Check one purchase](https://402signal.com/developers/check-offer).

Sellers can [inspect their listing and unpaid readiness](sellers.md). This is not a payment certification, receiving-account simulation, uptime-monitoring service or ranking guarantee. Operators can [review retained observation evidence](evidence.md) alongside approved policies and wallet records. The public log is not a full record of agent actions or a backup of private evidence.
