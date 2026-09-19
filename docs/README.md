# Documentation

Start with the [developer guides](https://402signal.com/developers) for installation, supported profiles and complete requests. This index covers the public clients, protocol contracts and verification boundaries.

## Choose how to start

- [Choose a service for a task](https://402signal.com/developers/choose-service): submit what you need, your budget, allowed networks and selection priority. Selection considers eligible candidates within the request's search bounds.
- [Check a known endpoint](https://402signal.com/developers/check-offer): submit its exact URL and purchase rules, then verify the evidence in your payment path before signing.
- [Find a guide by task](customer/README.md) or run the [offline buyer checks](../integration/buyer-checks/README.md).

A qualifying request combines discovery when needed, current-offer comparison and selection for one $0.003 USDC fee. Request bound evidence on a supported profile and retain the original request and signed response. Seller payment remains separate.

## Integrate a buyer

- [JavaScript guard and client hook](../sdk/route-guard/README.md)
- [Python HTTP client and offline verifier](../sdk/python/README.md)
- [Exact x402 request binding and the v4 guard contract](proof-carrying-route-v1.md)
- [Check group offer: v5 observation and codec detection](batch-observation-v1.md)
- [Algorand group and invoice manifest contract](algorand-manifests-v2.md)
- [MCP HTTP and stdio clients](mcp.md), including [Glama configuration](glama-release.md)
- [Check credits, admission keys and usage](customer/start.md)
- [Observed price, recipient and liveness alerts](customer/alerts.md)
- [Seller listing and readiness](customer/sellers.md)

## Evidence and recovery

- [Offer Evidence Record](evidence-record.md)
- [Historical v3 receipt format](route-decision-v3.md)
- [Investigate a purchase using retained evidence](customer/evidence.md)
- [Recover an existing routing response](route-recovery.md)
- [Private recovery credentials and retention](replay-recovery.md)
- [Completed unpaid misses and operational failures](route-miss-http-status.md)
- [Read-only reconciliation, receipt verification and diagnostics](route-recovery-observability.md)

## Integration packages

- [Offline buyer checks](../integration/buyer-checks/README.md)
- [Reference buyer](../integration/reference-buyer/README.md)
- [Native Base MPP charge](../integration/mpp-client/NATIVE.md) and [full-response selection](../integration/mpp-client/NATIVE_SELECTION.md)
- [Native Algorand MPP charge](../integration/mpp-algorand/README.md)
- [x402 mppx gateway adapter](../integration/mpp-client/README.md)
- [Base and Solana continuation clients](../integration/session-client/README.md)
- [Buyer-owned Algorand group and invoice adapters](../integration/batch-buyer/algorand/README.md)

Use [current hosted capabilities](https://402signal.com/capabilities.json) and [supported profiles](https://402signal.com/developers/supported-profiles) for current availability. A profile's wire support, client verification and live payment qualification are distinct claims.

Report security-sensitive issues through the [security policy](../SECURITY.md). The [license](../LICENSE) governs the public source.
