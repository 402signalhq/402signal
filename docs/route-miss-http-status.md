# Completed route misses return HTTP 200

A completed check that finds no eligible paid route returns HTTP 200 with
`live:false`, `payable:false`, `selected_payment:null`, and explicit billing:
`settlement_attempted:false`, `settled:false`, `settlement_state:not_attempted`.
There is no PAYMENT-RESPONSE receipt, trusted history promotion, or PQ route leaf.
The $0.003 success-only fee and independent winner-validation gate are unchanged.

| Outcome | HTTP | Settlement |
| --- | --- | --- |
| Valid live eligible winner | 200 | Settled |
| Completed normal miss | 200 | Not attempted |
| Timeout, unavailable discovery, incomplete search, unsafe destination, binding failure, or malformed result | 503 | Not attempted |
| Required transparency fails after settlement | 503 | Settled; preserve receipt |
| Settlement outcome uncertain | 503 | Unknown; do not reuse authorization |
| Invalid request or payment authorization | 400 / 402 | Existing rejection behavior |

Normal miss reasons are `no_candidates`, `no_402_envelope`, `no_payto`,
`reachable_200`, `quote_expired`, `no_input_schema`, `constraints_unmet`, and
`unsafe_to_probe`. They qualify only without an operational error or explicit
incomplete/budget-exhausted evaluation. `unsafe_to_probe` means the endpoint lacks
a safe probe contract; a blocked destination (`ssrf`) remains an error. A miss
describes this request's evaluated candidate set, not every service on the internet.
`constraints_unmet` includes the named unmet bounds in `unresolved_constraints`.
Missing input schema on an otherwise live payable route is `invocable:false`, not
a top-level `miss_reason`; `no_input_schema` is used only when schema is required
and unmet. An explicit empty-object `inputSchema` (type object, empty or omitted
properties/required) advertises no required inputs and is invocable when the
route is payable. A bazaar HTTP GET that advertises empty `queryParams` (or an
empty-object `queryParams` schema) and no required body is the same signal.
That is not a guarantee the seller call succeeds. Bare `{}` and missing schema
stay `invocable:false`.

Buyers should treat a completed miss as an answer, not a broken router. Inspect
`miss_reason` and `route_outcome.next_action` (usually `change_constraints`).
HTTP 503 `binding_error: route_binding_unavailable` means no remaining bindable
candidate after fall-through; `next_action` is `fix_request_or_compatibility`.
Neither outcome authorizes an unguarded seller payment.

Clients must inspect both decision fields and billing. HTTP 200 alone grants no
seller-payment authority. The route-guard SDK's `isUnsettledRouteMiss` recognizes
new 200 and legacy 503 unpaid outcomes, requires the receipt header to be absent,
and rejects malformed JSON and contradictory billing. It does not prove an
on-chain outcome, authorize a new payment, release reserved budget, or replace
`withVerifiedRoute` for seller execution.

Within the private recovery window, eligible durable replay entries preserve
their original response, including a retained 503 response. Older payloads without
private retrieval credentials are removed by the privacy migration; economic
identities remain permanent. See [private recovery](replay-recovery.md).
New 200 misses are terminal `not_settled`; an identical private replay performs
no second verification, probe, settlement, or proof append. Existing authorization
uniqueness, request binding, expiration, and unknown-state handling are unchanged.
No database migration or reset is required. The lab buyer accepts both versions
and retains its spend reservation after a miss.

MCP returns a correlated successful tool result (`isError:false`) for a normal
miss. Operational failures remain tool errors. Public OpenAPI and agent guidance
describe both HTTP 200 outcomes.
