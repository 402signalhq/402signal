# Fly liveness and readiness checks

`/health` is the production liveness check. `/ready` is the independent
integrity endpoint (503 when the PQ log is smaller than `last_confirmed`,
or when storage/catalog/history/pq_log/replay-ledger checks fail).

Fly config keeps both checks. This preserves process liveness visibility
while preventing paid traffic from reaching a Machine whose durable
economic replay ledger or other required state is unavailable:

```toml
[[http_service.checks]]
  grace_period = "10s"
  interval = "15s"
  method = "GET"
  path = "/health"
  timeout = "5s"
```

```toml
[[http_service.checks]]
  grace_period = "10s"
  interval = "15s"
  method = "GET"
  path = "/ready"
  timeout = "5s"
```

Changing this file does not itself deploy. Deployment remains a separate
reviewed action.

## Update (September 2026)

`/health` is the only proxy routing check. `/ready` moved to a Fly Machine
check (`[checks.ready]`): it stays visible and gates deploys, but a readiness
failure no longer removes the site, docs, catalog and unpaid challenges.

Paid work is refused in-process instead: `POST /route` with a payment header,
paid MCP `route` calls and recovery return HTTP 503 `service_not_ready` (or
`writer_unavailable` without the writer lease) before any verification or
reservation. The readiness result is cached for `LIVE402_READY_CACHE_S`
seconds so public `/ready` traffic cannot multiply its storage probe.

## The `writer` field

`/ready` carries a top-level boolean `writer` beside `ok` and `checks`:

```json
{"ok": true, "checks": {"admission": true, "storage": true, "catalog": true,
 "history": true, "pq_log": true, "replay_ledger": true}, "writer": true}
```

`writer` is true only while this process holds the writer lease (the one
process that publishes to the transparency log, crawls the catalog and runs
housekeeping). It is deliberately not part of `checks` and never changes the
status code: a standby machine without the lease answers 200 with
`"writer": false`, stays healthy for the proxy and the deploy gate, and still
completes plain paid checks through the transparency-leaf outbox. The value is
read live on every request, not from the readiness cache.
