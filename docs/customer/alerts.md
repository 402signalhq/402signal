# Change alerts (webhooks)

Get a signed webhook when a seller you depend on changes its price, its receiving address, or stops answering with a valid challenge. Alerts fire on the same public observations the [endpoint pages](https://402signal.com/endpoints) count: a change is reported when a check observed it, not when a catalog feed claims it. Nothing a seller pays for and nothing from the lab moves an alert.

Alerts need an admission key (`X-402Signal-Key`). Ask at ross@402signal.com with the subject "admission key". Check the key any time with [`GET /keys/usage`](start.md#check-credits-api-key-v0).

## Subscribe

```bash
curl -sS -X POST https://402signal.com/alerts \
  -H "X-402Signal-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://hooks.example.com/402signal","hosts":["api.example.com"],"events":["price","recipient","liveness"]}'
```

The answer (HTTP 201) carries the subscription `id`, the echoed `hosts` and `events`, `hosts_known` (whether each host has listings in the catalog today) and `signing_secret`. The secret is shown once; store it beside the webhook. `events` defaults to all three.

- `url`: public HTTPS only. Private, loopback and link-local addresses, plain HTTP, credentials in the URL and 402signal.com itself are refused, at creation and again on every delivery.
- `hosts`: 1 to 20 seller hostnames as they appear on `/endpoints/<host>`.
- Up to 10 subscriptions per key.

## What you receive

One `POST` per scan (about every two minutes) when something changed, JSON body, with these headers:

| Header | Value |
| --- | --- |
| `X-402Signal-Event` | `402signal.alerts`, or `402signal.ping` for a test |
| `X-402Signal-Delivery` | delivery id, also in the body |
| `X-402Signal-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256>` |
| `User-Agent` | `402Signal-alerts/1` |

```json
{
  "type": "402signal.alerts",
  "delivery_id": "9f1c2d3e4a5b6c7d",
  "subscription_id": "0123456789abcdef",
  "generated_at": "2026-09-13T18:20:00Z",
  "events": [
    {"event": "price_changed", "host": "api.example.com", "url": "https://api.example.com/v1/quote",
     "amount_atomic": "20000", "changed_at": "2026-09-13T18:19:41Z",
     "endpoint_page": "https://402signal.com/endpoints/api.example.com"},
    {"event": "recipient_changed", "host": "api.example.com", "url": "https://api.example.com/v1/quote",
     "payTo": "0xabc…", "observed_payTo": "0xdef…", "changed_at": "2026-09-13T18:19:41Z",
     "endpoint_page": "https://402signal.com/endpoints/api.example.com"},
    {"event": "liveness_changed", "host": "api.example.com", "url": "https://api.example.com/v1/quote",
     "live": false, "miss_reason": "timeout", "observed_at": "2026-09-13T18:19:52Z",
     "endpoint_page": "https://402signal.com/endpoints/api.example.com"}
  ]
}
```

- `price_changed`: the observed atomic amount for the URL differs from the last observed amount on the same asset. `amount_atomic` is the new observed amount.
- `recipient_changed`: a check observed a receiving address that differs from the established one. `payTo` is the address on record, `observed_payTo` the new one. It stays pending until a second observation confirms it; there is no second alert for the confirmation.
- `liveness_changed`: the latest observation flipped between answering with a valid challenge and not. `miss_reason` is set when `live` is false.

Delivery is at least once. If you see the same `event`, `url` and `changed_at` twice, you have seen the same change twice. Answer with any 2xx within five seconds; a 3xx is not followed and counts as a failure.

## Verify the signature

Compute HMAC-SHA256 over `<t>.<raw body>` with the signing secret and compare in constant time. Reject a `t` more than five minutes from your clock.

```python
import hmac, hashlib, time

def verify(secret: str, header: str, body: bytes, tolerance_s: int = 300) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    ts = int(parts.get("t", "0"))
    if abs(int(time.time()) - ts) > tolerance_s:
        return False
    expected = hmac.new(secret.encode(), b"%d." % ts + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))
```

The Python package exposes the same routine as `live402.alerts.verify_signature` in this repository.

## Failures

A delivery that raises, times out or answers outside 2xx counts as a failure. Retries back off from one minute to one hour; the undelivered changes stay owed, so the next successful delivery carries them. After 20 consecutive failures the subscription is disabled and `GET /alerts/<id>` shows `active: false` with the reason. A successful test ping re-enables it.

## Manage

| Call | Result |
| --- | --- |
| `GET /alerts` | your subscriptions (no secrets) and the limits |
| `GET /alerts/<id>` | one subscription with its last 20 deliveries: time, kind, HTTP status, event count, error class |
| `POST /alerts/<id>/test` | send a signed `402signal.ping` now; `delivered: true` on a 2xx |
| `DELETE /alerts/<id>` | remove it (HTTP 204) |

Every call answers only for the key that created the subscription. There is no listing across keys and no way to read another key's subscriptions. The signing secret is stored on the private writer volume beside the session store; to rotate it, delete and recreate the subscription.

## What alerts are not

Not uptime monitoring: an alert needs a check to observe the change, and public checks happen when buyers ask. A host nobody checks stays silent. Not a payment certification and not a ranking signal. For your own continuous cadence, run [checks](start.md) on a schedule and let the alerts confirm what the public record sees.
