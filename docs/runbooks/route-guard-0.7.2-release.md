# route-guard 0.7.2 release checklist

For 402QA after security GO. No Fly secret, no `BATCH_OBSERVATION_PROFILES` enablement, no spend, Glama unchanged.

The pending capabilities row records PR169's merge SHA and a portable `npm pack` digest. Those fields stay `state=pending` until the GitHub release exists.

## Pack (reproducible)

From the merge commit that carries the 0.7.2 package bytes (`fdbcff3bc9b31826567b8cb456d4a883009eb9ff`; `sdk/route-guard` is unchanged after `1a9da77`):

```sh
node scripts/pack_route_guard.mjs --destination=/tmp/route-guard-072
```

Expected:

- `402signal-route-guard-0.7.2.tgz` SHA-256 `f09b4e038b6bde9670afe725af4170b4f52c7323ca775bcb1b2fcbc8ab200497`
- `SHA256SUMS` SHA-256 `be043932144d010a8c9d0e0542f8d6b396f72c27d94bc5cac05aa2befa9fefe8`

npm 10+ portable pack already stabilizes the archive: gzip mtime is 0 and every tar member mtime is `499162500` (1985-10-26 08:15:00 UTC). File-system timestamps and `SOURCE_DATE_EPOCH` do not change the digest. Do not edit `sdk/route-guard` before tagging; the packaged README already points at this tag.

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

4. Only then flip the capabilities row from `state=pending` to `state=published` with `published_at`, `archive`, `sha256`, `checksum_file`, and `checksum_file_sha256` matching that downloadable artifact. Remove `digest_status` and the `provisional_*` fields.

Do not set a Fly secret. Do not enable hosted Check group offer. Do not change Glama.
