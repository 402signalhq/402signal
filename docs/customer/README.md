# Choose a 402Signal task

Start with the task, then select its supported transport and payment profile. Do not infer hosted enablement from a source checkout.

| Task | Guide | Cost and scope |
| --- | --- | --- |
| Run a meaningful offline buyer check | [Buyer checks](../../integration/buyer-checks/README.md) | Free synthetic Base exact-x402 fixtures; not all-protocol certification |
| Exercise a trusted customer callback | [Consumer adapter](../../integration/buyer-checks/example-adapter.mjs) | Fake callback only; caller code is trusted, not sandboxed |
| Find API candidates | [Preview and tools](https://402signal.com/developers#interfaces) | Free; no fresh seller probe |
| Inspect your listing/readiness | [Seller guide](sellers.md) | Free exact catalog-listed endpoint check; not a settlement test |
| Guard an exact purchase | [Guard/client](../../sdk/route-guard/README.md), [reference buyer](../../integration/reference-buyer/README.md) | $0.003 per qualifying hosted observation; buyer-owned payment |
| Open a hosted session | [Hosted session](https://402signal.com/developers/hosted-session), [start guide](start.md) | $0.005 open; hops $0; not the merchant Session Client |
| Select native MPP charges | [Base](../../integration/mpp-client/NATIVE.md), [Algorand](../../integration/mpp-algorand/README.md), [full-offer selection](../../integration/mpp-client/NATIVE_SELECTION.md) | Named profiles only; native MPP is not x402 through mppx |
| Continue a funded session | [Session Client](../../integration/session-client/README.md) | Fixed buyer policy; no automatic new observation, top-up or channel |
| Check a group offer | [Check group offer](../batch-observation-v1.md) | `url` + `buyer_limits` + `require_route_binding`; codec auto-detected; $0.003 per qualifying observation |
| Use an Algorand group/invoice | [Manifest contract](../algorand-manifests-v2.md) | Explicit supported merchant manifest; not arbitrary batching |
| Recover an uncertain route | [Recovery](../route-recovery.md) | Original durable attempt; no new authorization as a retry shortcut |
| Investigate an old decision | [Evidence guide](evidence.md) | Retained record; not current permission or payment confirmation |

The hosted API observes and evaluates supplied requirements. The guard compares supported evidence before the buyer's callback. Optional clients orchestrate their documented lifecycle through buyer-controlled components. Do not describe all client packages as unable to send simply because the offline guard cannot send.

Before a live test, confirm the package archive, digest, runtime, exact request profile and hosted availability. Keep wallet keys, approved policy and durable spending authority outside model-generated content. Seller payment, channel funding, network fees and rent are separate from the checking fee. Completed normal no-match checks are free; a later refusal does not reverse an already-settled observation. Unknown outcomes require reconciliation.

The [optional customer skill](../../skills/402signal-buyer-checks/SKILL.md) follows the same selection guidance. Loading it does not authorize a payment or globally install it in an agent host.

[Human guides](https://402signal.com/developers) · [OpenAPI](https://402signal.com/openapi.json) · [Actual MCP inputs](https://402signal.com/mcp.json)
