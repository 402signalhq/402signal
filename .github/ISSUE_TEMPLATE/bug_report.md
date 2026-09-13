---
name: Bug report
about: Something in the hosted API, the SDK or the MCP server behaved wrongly
title: ""
labels: bug
assignees: ""
---

**What happened**

**What you expected**

**How to reproduce**

Request shape (redact payment headers, keys and any `Replay-Key`):

```json
{"need": "...", "url": "..."}
```

Response status and the `billing` and `route_outcome` objects if present:

**Versions**

- Client package and version (for example `@402signal/route-guard` 0.7.2):
- Runtime (Node or Python version, framework):
- Date and approximate time (UTC):

**Do not include** payment headers, wallet material, `Replay-Key` values or
private receipts. A synthetic example is more useful than a production dump.
