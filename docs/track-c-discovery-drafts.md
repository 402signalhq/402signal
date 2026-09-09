# Track C discovery drafts

**DRAFT / NO EXTERNAL WRITE.** Operator copy and a per-channel checklist only.
This file is not permission to publish. Adding it sends nothing.

**Each channel needs Ross per-channel GO before any write.**

PayAPI Market docs are already live on `main` (PR #148). These remaining
channels are discovery locations, not endorsements or service guarantees.
Buyers must verify any returned `base_url` or MCP endpoint resolves to
`https://402signal.com` (or `https://402signal.com/mcp`) before paying.
Paid checks still `POST https://402signal.com/route` at **$0.003 USDC** on
Base, Solana, and Algorand when a qualifying live route is found. Completed
normal misses are not settled. Seller payment remains separate.

Do not use stale `confirmation_ready` or PQ-marketing claims. Do not publish
credentials, private scoring, admission policy, or competitive internals.
Do not `POST` to MCP Registry, Glama, x402-list `/submit`, or
`/request-update` from this revision.

Read-only snapshot taken 2026-09-09 against current `main` (`bdad0a8`).

## Shared buyer note (every listing)

```
Discovery location only — not an endorsement.
Confirm any catalogue base_url or MCP URL resolves to https://402signal.com
(or https://402signal.com/mcp) before paying.
Paid checks still POST https://402signal.com/route @ $0.003 USDC on
Base / Solana / Algorand when a qualifying live route is found.
```

---

## 1. MCP Registry metadata

**Needs Ross per-channel GO before any write.**

### Current version / preflight

| Fact | Value |
| --- | --- |
| Local `server.json` version | `0.3.1` |
| Local description | `Find paid APIs and check buyer rules. Qualifying routes cost $0.003 USDC; normal misses cost $0.` |
| Published `io.github.402signalhq/402signal` `0.3.1` | **active**, `isLatest=true`, published 2026-09-04T20:52:52Z |
| Published `0.3.1` description | `Fail-closed x402 router. Authorize $0.003 USDC; live eligible routes settle, normal misses cost $0.` |
| Published remotes | `[{"type":"streamable-http","url":"https://402signal.com/mcp/v0.3.1"}]` (matches local) |
| Schema | `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json` |
| `0.3.2` | **404 Not Found** — not published |
| Preflight | `python3 scripts/mcp_registry_preflight.py server.json` → **failed**: existing immutable version differs (description only) |

**`0.3.2` is applicable.** Registry versions are immutable. Local `server.json`
already changed the `0.3.1` description without bumping the version, so
preflight will keep failing until Ross GOs a new version.

Stale sibling still **active** (do not treat as current):
`io.github.402signal/402signal` `0.3.0` — `$0.01 USDC`, remote
`https://402signal.com/mcp`. Deprecation, if the registry supports it, is a
separate Ross GO.

Hosted transport check (read-only): `GET https://402signal.com/mcp` and
`GET https://402signal.com/mcp/v0.3.1` return HTTP 405 with `Allow: POST, OPTIONS`
(SSE not offered). Do not change `MCP_REGISTRY_PATH` or add `/mcp/v0.3.2`
without a separate deploy GO.

Merging an edited `server.json` to `main` triggers
`.github/workflows/publish-mcp.yml`. **Do not bump `server.json` in this
draft.** After GO, publish `0.3.2` only; leave published `0.3.1` untouched.

### Draft `0.3.2` payload (hold)

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.402signalhq/402signal",
  "description": "Find paid APIs and check buyer rules. Qualifying routes cost $0.003 USDC; normal misses cost $0.",
  "title": "402Signal",
  "version": "0.3.2",
  "websiteUrl": "https://402signal.com",
  "remotes": [{"type":"streamable-http","url":"https://402signal.com/mcp/v0.3.1"}]
}
```

Keep remotes on the live `/mcp/v0.3.1` path unless Ross also GOs a hosted
path change. After GO: validate with `mcp-publisher validate`, then
`python3 scripts/mcp_registry_preflight.py server.json` must print
`publish=true` for the new version.

---

## 2. Glama connector

**Needs Ross per-channel GO before any write.**

### Current adapter / listing notes

| Fact | Value |
| --- | --- |
| Public listing | https://glama.ai/mcp/servers/402signalhq/402signal |
| Repo adapter | `scripts/glama_stdio.py` — `User-Agent: 402Signal-Glama-stdio/0.1.0` |
| Adapter endpoint | `https://402signal.com/mcp/v0.3.1` |
| Repo `glama.json` | maintainers: `ross402signal` (GitHub-side; not served at `/.well-known/glama.json`) |
| `GET https://402signal.com/.well-known/glama.json` | HTTP 404 |
| Procedure | `docs/glama-release.md` (initial adapter release documented as `0.1.0`) |
| Observed Glama releases | `v0.1.0` (2026-09-08), `v0.1.1` (2026-09-09, tool-definition refresh) |

The listing already mirrors the public README and forwards hosted
`preview` / `validate` / `route`. The stdio adapter cannot sign or submit
payment. A paid `route` call returns a tool error with the HTTP 402
challenge. Buyers still `POST https://402signal.com/route`.

Glama releases are separate from GitHub releases and from hosted MCP
`0.3.1` / draft `0.3.2`. Do not invent a new adapter version here.

### Draft listing / build copy (hold)

**Short directory blurb**

```
402Signal — find paid APIs and check buyer rules.
Discovery location only. Confirm the MCP URL resolves to
https://402signal.com/mcp (or /mcp/v0.3.1) before paying.
Paid checks still POST https://402signal.com/route @ $0.003 USDC
on Base, Solana, and Algorand when a qualifying live route is found.
Credential-free stdio cannot complete paid route calls.
```

**Build configuration (unchanged; from `docs/glama-release.md`)**

- Python: `3.12`
- Build steps: `[]`
- CMD: `["python", "scripts/glama_stdio.py"]`
- Environment schema: `{"type":"object","properties":{},"additionalProperties":false}`
- Placeholder parameters: `{}`
- Pinned commit: the reviewed commit Ross GOs

**Validation before any Glama write**

1. `python -m unittest discover -s tests -p test_glama_stdio.py`
2. Live smoke (no payment credentials): initialize, list three tools,
   free `preview` and `validate`, unpaid `route` returns a 402 challenge,
   a later free call still succeeds.

After GO: create a Glama release from the pinned commit. Do not treat a
README change as proof the Glama index refreshed.

---

## 3. x402-list listing template

**Needs Ross per-channel GO before any write.**

### Current listing (already live)

Read-only `GET https://x402-list.com/api/v1/services/402signal`:

| Field | Live value |
| --- | --- |
| slug | `402signal` |
| name | `402Signal` |
| base_url | `https://402signal.com/` |
| website_url | `https://402signal.com/` |
| category | `Data` |
| source | `submitted` |
| description | Fail-closed x402 router… (pre-task-first wording) |
| endpoint | `POST /route` at $0.003 |
| directory `networks[]` | `BSE`, `SOL` (Algorand appears in endpoint pricing, not that filter list) |

Domain proof file is already public at
`https://402signal.com/.well-known/x402list.txt`. An owner-update issues a
**new one-time token** that must be published as an additional line on that
path, then verified within 72 hours. That is a Fly/content deploy plus two
external POSTs. **Do not `POST /api/v1/submit`** (already listed). **Do not
`POST /request-update` or `verify-ownership` from this draft.**

### Draft owner-update body (hold)

Use only after Ross GO. Empty fields mean unchanged.

```json
{
  "email": "ross@402signal.com",
  "description": "Find paid APIs and check buyer rules across Base, Solana, and Algorand. Discovery location only — confirm base_url resolves to https://402signal.com before paying. Paid checks still POST https://402signal.com/route @ $0.003 USDC when a qualifying live route is found; normal misses cost $0. Seller payment is separate.",
  "website_url": "https://402signal.com/",
  "category": "Data"
}
```

Do not change `base_url` (identity change, always manual review). Do not add
MCP or preview paths as paid endpoints; the listed paid resource is
`POST /route`. Directory network filters may omit Algorand even though
`POST /route` accepts it — say so in the description, do not invent a
network code.

Human form after GO: `https://x402-list.com/services/402signal/update`.

---

## Blocked pending Ross GO

| Channel | Remaining write | Blocked until |
| --- | --- | --- |
| MCP Registry | Publish new immutable `0.3.2` from the draft payload (workflow on `main`) | **Ross per-channel GO** |
| MCP Registry (stale) | Optional deprecate `io.github.402signal/402signal` `0.3.0` ($0.01) | **Ross per-channel GO** |
| Glama | Any new connector release / listing edit | **Ross per-channel GO** |
| x402-list | Owner-update (not a new submit); possible well-known token line + deploy | **Ross per-channel GO** |

No fly.toml, payment, or signer changes are part of Track C discovery copy.
