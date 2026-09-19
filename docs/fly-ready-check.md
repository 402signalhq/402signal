# Public liveness and readiness contract

The [status page](https://402signal.com/status) displays two separate checks:

| Endpoint | Meaning |
|---|---|
| [`GET /health`](https://402signal.com/health) | The service process is responding. |
| [`GET /ready`](https://402signal.com/ready) | Required storage, admission, replay-authority and transparency checks have passed. |

`/ready` returns HTTP 200 when its required checks pass and HTTP 503 when they
do not. A readiness failure can pause paid admission while the website,
documentation, catalog and unpaid payment challenges remain reachable.
Liveness alone does not establish readiness for a paid check.

The response contains `ok`, individual `checks` and a separate `writer` flag:

```json
{
  "ok": true,
  "checks": {
    "admission": true,
    "storage": true,
    "catalog": true,
    "history": true,
    "pq_log": true,
    "replay_ledger": true
  },
  "writer": true
}
```

`writer` reports whether the responding process holds the active writer lease.
It is not part of `checks` and does not itself determine the HTTP status: a
ready standby can return HTTP 200 with `writer: false`. Bound checks and
sessions also require an active writer. Inspect the actual check's response
and billing outcome; do not infer permission to spend from a readiness flag.

Failed paid admission can return `service_not_ready`; an unavailable required
writer can return `writer_unavailable`. Neither is permission to create a new
payment after an uncertain attempt. Use the [recovery contract](route-recovery.md)
to retrieve an existing response and reconcile uncertain payment outcomes.

Readiness describes 402Signal infrastructure. It does not establish seller
availability, successful payment, delivery, or confirmed later chain anchoring.
