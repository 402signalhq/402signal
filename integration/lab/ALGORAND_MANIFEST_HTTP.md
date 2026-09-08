# Optional Algorand job-manifest lab endpoints

These endpoints are operator-owned test merchants. They are disabled by default and separate from the existing exact-payment, two-item Algorand, Base and Solana endpoints. Their responses do not demonstrate organic customer traffic or independently verify fulfillment.

Enable only with `LAB_ALGORAND_MANIFESTS=reviewed-explicit-job-manifests-v2` and `LAB_ALGORAND_MANIFEST_CONFIG=/path/to/reviewed-public-config.json`. The existing seller must already be initialized in mainnet mode. No new master credential, wallet or sponsor signer is loaded: verification and settlement use the initialized Algorand server/facilitator. The provider must independently agree to its sponsor policy and complete group support before a paid qualification.

The config is a regular, non-symlink UTF-8 JSON file of at most16KiB, with exactly `version:1`, `algodUrl`, `facilitatorUrl` and `campaigns`. The facilitator URL must equal the existing Algorand seller configuration. `algodUrl` is an explicitly pinned HTTPS origin; only `GET /v2/transactions/params` is used, without credentials, redirects or retries.

Exactly two independent campaign objects are required:

| profile | exact GET path | payments |
| --- | --- | --- |
| `algorand-atomic-multi-item-v1` | `/algorand/manifests/group` |2–15 ordered USDC transfers plus sponsor |
| `algorand-aggregate-invoice-v1` | `/algorand/manifests/invoice` |one USDC transfer for2–64 explicit ordered jobs plus sponsor |

Every campaign has exactly these fields: `campaignId`, `profile`, `url`, `network`, `asset`, `recipient`, `buyer`, `feePayer`, `amountAtomic`, `maxTotalAmountAtomic`, `maxSponsorFeeMicroAlgo`, `jobHashes`, `createdAt`, `expiresAt`. IDs are distinct8–64-character ASCII letters/digits/underscore/hyphen strings. URL is the configured public seller origin plus the matching path, with no query or alternative encoding. Mainnet network is `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=` and USDC asset is `31566704`. Recipient must be the existing seller's configured payee. Buyer is a nonzero valid Algorand address distinct from merchant and sponsor. Decimal amount/fee caps are canonical positive uint64 strings. The actual initialized SDK must return the exact amount, network, asset, recipient and sponsor before any offer can be published; conversion to its dollar-price input uses integer/string arithmetic.

`createdAt`/`expiresAt` are immutable millisecond timestamps, with at most24hours between them. That campaign deadline is not the price/fee observation lifetime: the first successful independent suggested-params read creates one immutable45-second quote. Repeated GETs return the same offer until it expires; expiry never creates a new quote. A new campaign ID, separately reviewed config and budget are required for another offer. No signing or settlement is triggered by an unsigned GET.

Each campaign stores its fixed config and stages in `<existing seller ledger directory>/algorand-manifests/<campaignId>.sqlite`. The directory is separate from the seller ledger, must not be a symlink, and is created with mode0700; files use mode0600. Existing foreign database schemas or changed config under the same ID are refused. Preserve these files across restart, and include them in the lab's approved recovery procedures. This bounded lab SQLite journal is not the production routing throughput design. An Algorand-only registration does not require PostgreSQL or change the Base/Solana database settings.

Ordinary paid requests use `Payment-Signature` once. Recovery sends no executable credential: use `Replay-Only:1`, `Manifest-Group-Id`, `Manifest-Request-Digest` (the complete prepared scope) and `Manifest-Authorization-Digest`. The endpoint rejects `Payment-Signature` in recovery mode and returns `Replay-Only:1` on a recognized lookup path. A caller must check that explicit marker and the exact saved receipt accounting. Missing/mismatched/unknown results grant no retry permission. Recovery remains available after quote/campaign expiry, while ordinary submission is refused. Chain confirmation remains an independent buyer-owned read.

A small proposed qualification uses3×1000-atomic payments and a separate3000-atomic invoice for3 jobs. Each fresh supported observation costs3000 atomic USDC separately from its merchant payment: at most6000 per campaign/12000 total for those two proposed attempts. Network fee examples with a fresh1000-microALGO minimum and zero per-byte fee are4000 and2000 respectively; facilitator commercial charges are unverified and must be quoted separately. These are preparation figures, not a completed live test or an automatic sponsorship commitment.

Focused cloud tests exercise actual SDK requirements, unsigned HTTP offers, both group and invoice signing/settlement, lost acknowledgment, restart, expiry and digest-only recovery. No live payment or production activation is performed by this integration.
