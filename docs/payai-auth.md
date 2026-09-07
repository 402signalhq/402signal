# PayAI merchant authentication

Use `PAYAI_API_KEY_ID` and `PAYAI_API_KEY_SECRET` for the paid-tier merchant integration. The secret is an Ed25519 API-authentication key encoded as base64 PKCS#8 DER; a `payai_sk_` prefix is accepted. It is not a buyer or seller wallet key.

The adapter caches one 120-second JWT per process and renews it 30 seconds before expiry. Credential changes invalidate cached reuse; both wall and monotonic clocks bound its lifetime. Tokens are sent only to the fixed PayAI verify/settle endpoints (and the optional supported-capability endpoint), never across redirects.

`PAYAI_ACCESS_TOKEN` deliberately overrides key-pair generation. Without that override, a configured ID/secret pair takes priority over the legacy `PAYAI_API_KEY` bearer. A partial or invalid pair fails closed. If no credentials are configured, anonymous free-tier behavior remains available. Static bearer values do not receive automatic renewal: their issuer/operator controls replacement.

Authentication errors do not retry a verify or settlement call. In particular, an uncertain settlement must follow the existing replay/reconciliation path before any further payment action. JWT reuse is authentication caching, not economic replay authorization.

The implementation follows the [PayAI authentication protocol](https://docs.payai.network/x402/facilitators/authentication). Synthetic tests validate encoding, signatures, renewal, rotation and failure behavior; they do not establish account entitlement or live provider acceptance. Keep API secrets and JWTs out of logs, public files and issue reports.
