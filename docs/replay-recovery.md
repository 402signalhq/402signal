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
quote's expiry before seller execution. Expiry, a missing or wrong key, a
conflicting request, and an older cache entry never return the response and
never grant permission for a second settlement. Clients without a key can
execute once but cannot retrieve the response through the cache.

Repeating a payment authorization whose identity already reached a final state
(settled, not settled, or rejected) returns HTTP 409
`authorization_already_used` with `replay.state`, the matching `billing`
outcome and `new_payment_allowed: false`, whether the key is missing, wrong,
or the request differs. It carries no response contents. Pending or uncertain
identities return the coarse unknown outcome instead.

Do not automatically create a new payment after an uncertain result. Reconcile
the existing authorization first. Recovery keys belong only in private buyer storage.

Permanent authorization identities do not expire with the private response. Individual stored responses are capped at 256 KiB; excess content does not reopen an authorization. Keep your own response and private evidence securely.

For bounded retrieval without executing another check, use the [recovery-only HTTP contract](route-recovery.md). MCP does not support the Replay-Only retrieval lane.
