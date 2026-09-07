# Recovering a routing response

If a routing response is lost or delayed, a buyer can ask for the existing response without authorizing another payment attempt. This is a bounded retrieval operation, not a new route check.

Before the original `POST /route`, generate 32 cryptographically random bytes and encode them as 64 lowercase hexadecimal characters. Send this secret in exactly one `Replay-Key` header and retain it with the original JSON request and payment authorization. Keep it private; it is not a customer admission credential and does not belong in URLs, logs, public receipts or merchant requests.

For retrieval, resend the same JSON request to the same `POST /route` resource, with the same payment authorization and `Replay-Key`, and add exactly one `Replay-Only: 1` header. Keep the original payment header; do not create a new authorization. Multiple payment headers, duplicate recovery headers, missing keys and malformed values fail closed. `Replay-Only` is currently unsupported on MCP and other endpoints and returns HTTP 400 without executing a tool.

The recovery lane has a separate global and caller budget, independent of normal routing ingress. A recognized customer credential can affect capacity; it never grants access to someone else's result. Shared HTTP workers and database availability still bound recovery, so this is not an availability guarantee.

A matching, unexpired persisted response is returned with its original status, billing outcome and sanitized payment receipt. It is historical evidence: observation times, decision-binding expiry and any uncertainty remain unchanged. Retrieval does not verify or settle payment, probe a merchant, create a replay reservation, write history or append a PQ receipt. It does not refresh the original 120-second response retention period. Durable authorization replay protection continues after response retention expires. An in-memory copy cannot override a missing, expired or fenced durable record; responses rejected before durable admission may therefore be unavailable for recovery.

Missing, unfinished, expired or inaccessible responses all return the same HTTP 503 `recovery_unavailable` result with `new_payment_allowed: false`. A stored uncertain settlement response can itself be returned as the original HTTP 503; it remains uncertain. Neither result establishes that the payment failed or grants permission to pay again. Reconcile the original authorization and any available receipt with the payment provider before deciding whether another economic attempt is appropriate.

HTTP 429 includes `Retry-After` and `Cache-Control: no-store`. Back off and retry the same retrieval request within the retention window. Do not blindly sign a fresh authorization because a request was rate limited, timed out or returned an unknown result. A normal request without `Replay-Only` retains its usual route execution semantics; clients seeking retrieval only must set the header explicitly.

SQLite retrieval opens an existing database read-only and respects a migrated source's authority fence. PostgreSQL retrieval uses the selected authoritative ledger's bounded lookup. Recovery cannot initialize or migrate a missing database, fall back from PostgreSQL to SQLite, or extend storage retention.
