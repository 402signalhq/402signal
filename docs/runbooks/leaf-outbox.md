# Transparency-leaf outbox

The append-only log has one tree and one writer: the router process that holds
the writer lease. Every other router process refuses paid work before
verification (`writer_unavailable`). The outbox lets such a process complete a
paid check whose evidence does not have to be signed at response time: it
queues the public leaf bytes in the shared replay authority (PostgreSQL), and
the writer drains the queue in order into the log.

## What a buyer sees

A queued leaf is not a signed receipt. The paid response carries

```
pq_trust.transparency.status = "queued"
pq_trust.transparency.state  = "outbox_queued"
pq_trust.transparency.receipt.leaf_hash
pq_trust.transparency.outbox_id
pq_trust.transparency.reveal
```

and no checkpoint. `require_transparency` and `require_route_binding` requests
are never queued: without the writer lease they keep getting
`writer_unavailable` before verification, exactly as before. Hosted sessions
and hops keep per-machine state and are refused without the lease too. The
Check group offer (batch binding) is refused as well.

Once drained, the leaf sits in the log like any other; the next signed
checkpoint covers it and a buyer can find it by `leaf_hash` through the
public tiles.

## Requirements

- Replay authority on PostgreSQL with `LIVE402_REPLAY_POSTGRES_API=functions-v1`.
- Owner migration `ops/replay-postgres-leaf-outbox.sql` installed. It is
  additive: no writer stop, no existing function changes. Every entry point
  runs the same guard as paid admission (`signal_replay.api_authority`), so a
  fenced database refuses queued leaves too.
- `LIVE402_PQ_OUTBOX=1` on every router process. Without it, or before the
  migration, nothing changes.

## Operating it

- The writer drains up to 500 queued leaves every maintenance tick (30 s) and
  logs `leaf_outbox_drained count=N`. The append is idempotent by leaf hash, so
  a crash between the append and the acknowledgement repeats no leaf.
- A row whose bytes no longer hash to its recorded leaf hash is left pending
  and logged as `leaf_outbox corrupt id=N`; it never enters the log. Inspect
  it as the owner and delete it by hand.
- Acknowledged rows older than 14 days are pruned hourly.
- Depth for alerts: `SELECT * FROM signal_replay.api_outbox_depth('<authority id>')`
  from the runtime login, or `live402.pq.outbox.depth()`.

## What it does not do

It does not make a second machine a full router: the catalog crawler and
public history stay with the writer, and `LIVE402_ROUTER_WRITERS` remains 1.
Its immediate use is the lease handoff during a deploy, when the new process
serves plain paid checks before the old one has released the lease. Standby
machines that serve paid traffic on their own come after shared catalog and
history storage.
