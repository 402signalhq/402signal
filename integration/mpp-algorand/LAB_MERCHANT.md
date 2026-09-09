# Native Algorand charge lab

This optional lab hook qualifies one buyer-paid native MPP charge using
@goplausible/algorand-mpp-sdk 0.9.4. It is off by default and has only synthetic
qualification so far. It is independent of the Algorand atomic-group and invoice
examples.

Enable only for an owner-reviewed campaign with
LAB_ALGORAND_MPP_CHARGE=reviewed-owner-native-charge-v1 and
LAB_ALGORAND_MPP_CHARGE_CONFIG pointing to a private configuration file.
The existing lab must be ready in MainNet mode. The resource is exactly
GET /algorand/mpp/sha256, with an empty request body and Authorization credential.

The configuration has exactly these fields: version (1), campaignId, url,
rpcUrl, buyer, recipient, network, asset, amountAtomic, maxNetworkFeeMicroAlgo,
createdAt and expiresAt. Amount is exactly 1000 atomic USDC; asset is 31566704;
network is Algorand MainNet. Buyer and recipient are distinct pinned addresses.
The configured recipient must equal the existing lab recipient, and the URL
must use the existing lab origin. Algod is an owner-reviewed HTTPS origin with
no embedded credentials. The explicitly reviewed buyer network-fee ceiling is
1000–20000 microALGO. Campaign timestamps are milliseconds and span at most one
hour. The actual offer lasts at most 60 seconds and is never refreshed.

There is no fee payer or merchant wallet signer. The SDK produces the original
challenge request and successful Payment-Receipt. Mppx.create normally requires
a secretKey to authenticate stateless challenge contents. This hook instead
uses the SDK's lower-level charge method and durably retains the complete issued
challenge, exact request, campaign and buyer. Every submitted credential must
match that record and the precise expected signed transaction. This stateful
check replaces the HMAC gate; no HMAC secret is configured.

A separate private SQLite file under algorand-native-charge/ binds the campaign
configuration and records issuance and send permits before external work.
The no-key SDK worker receives no inherited environment credentials. It permits
only bounded reads of the configured Algod origin and one exact transaction
broadcast; redirects and alternative send bodies are refused. No on-chain
payment is retried, even after restart or an unknown result.

HTTP 200 requires the original SDK receipt plus independent MainNet transaction
readback matching every expected transaction byte, transaction ID and valid
confirmed round. The fixed utility returns SHA256 of the exact resource URL.
An SDK acknowledgement alone does not establish fulfillment. Uncertain outcomes
return coarse HTTP 409 with new_payment_allowed:false. Cached successful
responses preserve the original Payment-Receipt. Replay-Only:1 without a
credential only reads the cached response; it cannot send or generate a quote.
The module's administrative reconcile method performs read-only confirmation.
If the original SDK receipt was lost, even confirmed payment stays HTTP 409:
the module does not fabricate a receipt or claim fulfillment.

## Image layout

Registration loads `../../../mpp-algorand/lab-merchant.mjs` from compiled
`/app/dist/src`, which is `/mpp-algorand/lab-merchant.mjs`. The lab Fly image
(`integration/lab/Dockerfile.fly`, built from the `integration/` context) copies
the locked package sources and production `node_modules` to
`/app/native-mpp/algorand` and links `/mpp-algorand` there. `index.mjs`
repository-relative `../../sdk/route-guard` imports resolve through `/app/sdk`.
The machine command is `node /app/start-seller.mjs`. Existing opt-in flags,
recipient, origin, RPC and credential gates are unchanged.

## Qualification

The cloud tests use the actual client and server SDK with synthetic buyer keys
and a local synthetic Algod HTTP server. They exercise one-shot broadcast,
full transaction confirmation, concurrent durable handles, restart, unknown
acknowledgements, read-only recovery, tampered effects, expiry and configuration
substitution. They do not demonstrate live RPC latency, actual settlement,
production availability or general MPP merchant compatibility.
