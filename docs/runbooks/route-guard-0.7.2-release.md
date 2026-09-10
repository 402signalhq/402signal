# route-guard 0.7.2 release checklist

For 402QA after security GO. No Fly secret, no `BATCH_OBSERVATION_PROFILES` enablement, no spend, Glama unchanged.

The pending capabilities row records PR169's merge SHA and a portable `npm pack` digest. Those fields stay `state=pending` until the GitHub release exists.

## Pack (reproducible)

`sdk/route-guard` bytes are unchanged after `1a9da77`. Pack from that tree, from PR169 merge `fdbcff3bc9b31826567b8cb456d4a883009eb9ff`, or from this branch tip. Do not edit `sdk/route-guard` before tagging.

Exact toolchain and command that produced the pending digest (two consecutive packs on the tip were identical):

```sh
npm --version    # 10.9.7
node --version   # helper only; the archive is created by npm pack
npm pack ./sdk/route-guard --ignore-scripts
# equivalent helper that also writes SHA256SUMS and checks portable timestamps:
node scripts/pack_route_guard.mjs --destination=/tmp/route-guard-072
```

Expected from **npm 10.9.7** portable pack (gzip mtime 0; every tar member mtime `499162500` / 1985-10-26 08:15:00 UTC):

- `402signal-route-guard-0.7.2.tgz` SHA-256 `f09b4e038b6bde9670afe725af4170b4f52c7323ca775bcb1b2fcbc8ab200497`
- `SHA256SUMS` SHA-256 `be043932144d010a8c9d0e0542f8d6b396f72c27d94bc5cac05aa2befa9fefe8`

File-system timestamps and `SOURCE_DATE_EPOCH` do not change that digest under npm 10. An older npm that embeds checkout mtimes can produce a different archive (402security previously reproduced `f23d534537a847d592770aea2bbdbbce493f668645d6dcf95985b21d2a70195a`). Treat that as a toolchain mismatch, not a second published digest.

**Before tag:** security must reproduce `f09b4e03…` on this tip with `npm 10.9.7` and `npm pack ./sdk/route-guard --ignore-scripts`. Do not copy any digest into published `sha256` / `archive` / `checksum_file` fields until that reproduction succeeds and the downloadable GitHub release artifact matches. Pending plus `provisional_*` (no published URLs) is the honest state until then.

## Qualify from the packed archive

Not from the source tree:

```sh
node scripts/check_route_guard_archive.mjs /tmp/route-guard-072/402signal-route-guard-0.7.2.tgz \
  --historical-verifier https://github.com/402signalhq/402signal/releases/download/route-guard-v0.7.1/402signal-route-guard-0.7.1.tgz
```

This must show:

- 0.7.2 verifies current chk_grp leaves without buyer `merchant_profile`
- 0.7.2 still verifies historical leaves that name `merchant_profile`
- refuse-on-drift still fails closed
- published 0.7.1 (historical_verifier) still verifies those historical leaves and refuses current chk_grp requests that omit `merchant_profile`

## After security GO

1. Tag `route-guard-v0.7.2` at `fdbcff3bc9b31826567b8cb456d4a883009eb9ff` (or a later commit that does not change `sdk/route-guard`).
2. Attach `402signal-route-guard-0.7.2.tgz` and `SHA256SUMS` from the pack step. Digests must match the pending row.
3. Confirm the downloadable artifact:

```sh
node scripts/check_route_guard_archive.mjs \
  https://github.com/402signalhq/402signal/releases/download/route-guard-v0.7.2/402signal-route-guard-0.7.2.tgz \
  --historical-verifier https://github.com/402signalhq/402signal/releases/download/route-guard-v0.7.1/402signal-route-guard-0.7.1.tgz
```

4. Only then flip the capabilities row from `state=pending` to `state=published` with `published_at`, `archive`, `sha256`, `checksum_file`, and `checksum_file_sha256` matching that **downloadable** artifact. Remove `digest_status` and the `provisional_*` fields. If security cannot reproduce `f09b4e03…` on the tip, leave the row pending with no published digest fields. Do not publish `f23d5345…` or any other unagreed hash.

Do not set a Fly secret. Do not enable hosted Check group offer. Do not change Glama.
