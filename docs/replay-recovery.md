# Private response recovery

Send `Replay-Key` with the first paid `POST /route` or MCP route call if you need
to retrieve that response after a connection failure. Generate 32 random bytes
on the client and encode them as 64 lowercase hexadecimal characters. Keep the
key private alongside the exact request. Never put it in a URL, payment payload,
public receipt, telemetry, issue, or shared report.

```javascript
const replayKey = Array.from(crypto.getRandomValues(new Uint8Array(32)),
  byte => byte.toString(16).padStart(2, "0")).join("");
const response = await fetch("https://402signal.com/route", {
  method: "POST",
  headers: {"Content-Type": "application/json", "PAYMENT-SIGNATURE": signature,
            "Replay-Key": replayKey},
  body: JSON.stringify(request)
});
```

Recovery requires the same key, resource, payment authorization, and request
values. Object-key ordering may differ. Changing the need, target, policy,
privacy requirements, or binding flags does not reuse the private response.
The server stores only a keyed request digest; it never stores or returns the
key. A signature or public blockchain transaction is not a recovery credential.

Responses expire 120 seconds after the original request begins. A recovered
quote keeps its original observation and expiry times. Always validate the
quote's expiry before seller execution. Expiry, a missing key, a conflicting
request, and an older cache entry return a coarse unavailable/unknown outcome;
they never grant permission for a second settlement. Clients without a key can
execute once but cannot retrieve the response through the cache.

Do not automatically create a new payment after an uncertain result. Reconcile
the existing authorization first. The lab buyer continues to stop after an
uncertain payment and does not persist recovery keys in its public reports.

The migration preserves every existing economic identity and pending/unknown
state. Old response payloads are removed because they have no private retrieval
credential. New invalid authorizations consume only a bounded memory cache;
durable admission occurs after successful verification. Permanent identities
do not expire. New admission fails closed at 100,000 rows, a 256 MiB database
budget, or less than 64 MiB free disk space. Individual stored responses are
capped at 256 KiB; excess content does not reopen the authorization. Readiness
checks exercise a write and remove expired stored response payloads.

Back up the replay database as part of the complete recovery bundle. Never
delete it to clear an error, migrate between hosts without it, or restore a
subset of the application's databases.
