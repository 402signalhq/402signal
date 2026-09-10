# Check group offer architecture

Named `merchant_profile` values are a **lab/testing** contract. They are not the customer product.

## Customer path

`POST /route` for this job is:

```json
{
  "url": "https://merchant.example/batch",
  "buyer_limits": { "network": "...", "asset": "...", "recipient": "..." },
  "require_route_binding": true
}
```

`buyer_limits` must be a real cap object for one supported codec. Buyers do not pick `merchant_profile`. The public schema uses `anyOf` over those cap shapes because two-item and multi-item atom key sets overlap at two hashes. Runtime still admits exactly one codec and refuses drift. The server auto-detects that codec from the live 402 challenge (`status`, `WWW-Authenticate`, body / `PAYMENT-REQUIRED`). If the wire is unknown or ambiguous, the request fails closed. If the detected codec drifts from the cap key set, the request fails closed.

Returned identity is the short codes `job=chk_grp` and `codec` in `exact|sess|mpp|atom|inv`. Those codes appear on the HTTP result and `compared[]`. The public v5 leaf stays `{type, ts, nonce, commitment}`. The commitment hashes `request_json` plus the binding; the binding’s internal `profile` determines the codec. `label` is an optional HTTP debug field (`Check group offer`) and is not part of the public leaf or the exact binding key set. Internal wire profile names stay inside the binding validators.

## Internal codecs

| Codec | Validator family | Buyer does not name |
|---|---|---|
| `exact` | Base x402 `batch-settlement` | `base-x402-batch-v1` |
| `sess` | Solana MPP session | `solana-mpp-session-v1` |
| `mpp` | Native Base or Algorand charge | `base-mpp-charge-v1`, `algorand-mpp-charge-v1` |
| `atom` | Algorand atomic group | `algorand-atomic-*-v1` |
| `inv` | Algorand aggregate invoice | `algorand-aggregate-invoice-v1` |

Any merchant speaking a supported challenge shape works. There is no per-merchant profile registry.

Ordinary exact x402 (`scheme=exact`, no group extension) is a different job and is refused here.

## Operator allowlist

`BATCH_OBSERVATION_PROFILES` is a rollout gate. Tokens are codecs, or legacy lab profile names mapped to codecs. Empty keeps the job off. Do not advertise those tokens as the buyer API.

## Lab

`merchant_profile` is accepted only with `lab_test` on live admission, and offline for signed fixtures. Lab stays internal for codec qualification.

## Later / parked

- `fill_cap` (“Fill the budget”) is job #2 — not this path
- `prop_set` assemble and one-order multi-rail outbound stay parked

## What we will not do

- Invent unsupported kinds from free-form `kind/network/asset`
- Weaken refuse-on-drift or the exact v5 binding key set
- Put Assemble / `fill_cap` on this path
