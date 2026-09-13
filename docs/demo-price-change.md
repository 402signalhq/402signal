# Sixty-second demo: a price change caught before the wallet signs

A reproducible walkthrough for a screen recording, a README hero or the first outreach email. Every step runs against fixtures or the unpaid public endpoints; nothing here pays anyone. Total on-screen time is about a minute; the narration is written to be read aloud.

## What the viewer sees

1. A seller's real September price change, from the public report.
2. The offline guard refusing to sign when the challenge no longer matches the receipt.
3. The unpaid readiness check showing what that seller answers right now.

## Step 1, ten seconds: the real change

Open https://402signal.com/insights/state-of-x402-endpoints-2026-09 and point at the first row of "What changed, named".

Narration: "On September 4, api.kadec0.xyz asked three cents for a search. On September 10 the same URL asked five. Nothing in the listing changed. An agent that planned ten thousand searches at the old price was two hundred dollars short."

## Step 2, thirty seconds: the guard refuses

From a checkout with Node 22 or newer:

```sh
node integration/buyer-checks/run.mjs
```

The report is JSON. Read the `scenarios` list on screen:

- `matching-offer`: `calls: 1`, the callback ran, `callbackTermsMatch: true`.
- `price-changed`: `calls: 0`, `rejected: true`, the reason code names the mismatch. The fixture changes the challenge's `amount` after the receipt was issued, which is exactly what api.kadec0.xyz did between September 4 and September 10.
- `recipient-changed`, `evidence-expired`, `original-request-changed`: the same refusal for a moved recipient, a stale receipt and an edited request.

Narration: "The receipt binds the whole challenge the seller returned when the check ran. Before the wallet signs, the guard compares the live challenge with that receipt. Different price, different recipient, expired receipt or an edited request: the signing callback is never called. The earlier check cost three tenths of a cent; the refused payment cost nothing."

Optional, for the hook rather than the wrap: show the two lines from the homepage.

```js
import { signalGuard } from "@402signal/route-guard/x402";
client.onBeforePaymentCreation(signalGuard({ fetchWithPayment, trustedLogVkey }));
```

## Step 3, twenty seconds: what the seller answers right now

```sh
curl -sS "https://402signal.com/validate?url=https://api.kadec0.xyz/v1/serp" | python3 -m json.tool | head -40
```

Point at `observed.payTo`, the accepted amount in the challenge, and `verified_at`. Or open https://402signal.com/try?endpoint=https%3A%2F%2Fapi.kadec0.xyz%2Fv1%2Fserp and press the button.

Narration: "This is the unpaid check, from a browser, no wallet. The paid check does the same at the moment of payment and hands back the signed receipt. With an admission key you can also subscribe a webhook and get a signed event the next time this host changes its price."

## Closing line

"Signed proof of what your agent was offered before it paid. 402signal.com."

## Recording notes

- Terminal at 100 columns, dark background; the JSON report is the only long output, and `head -40` keeps the curl output on one screen.
- No wallet, key or private file appears on screen at any point.
- If api.kadec0.xyz has changed again by the time you record, the narration in step 1 should quote the report page as it stands; the report is the record.
