# route-guard 0.7.2 release checklist

For 402QA after security GO. No Fly secret, no `BATCH_OBSERVATION_PROFILES` enablement, no spend, Glama unchanged.

The pending capabilities row records PR169's merge SHA and a portable `npm pack` digest. Those fields stay `state=pending` until the local artifact is qualified, the tag is uploaded, and the downloaded GitHub bytes match the reviewed pair.

## Release order

Qualify local bytes first. Do not treat a GitHub download as a precondition for the tag.

1. Qualify the **local** artifact (pack + reviewed digests + archive-checker on those local bytes).
2. Approve the tag and release **upload**.
3. Download those **exact released** bytes from GitHub.
4. Verify the download matches the reviewed digests and the archive-checker.
5. Then mark capabilities `state=published`.
6. Record the actual tag target as `source_revision`.

## Pack (reproducible)

`sdk/route-guard` bytes are unchanged after `1a9da77`. Pack from that tree, from PR169 merge `fdbcff3bc9b31826567b8cb456d4a883009eb9ff`, or from this branch tip. Do not edit `sdk/route-guard` before tagging.

Exact command:

```sh
npm --version    # 10.9.7 (portable tar mtimes)
python3 --version
node scripts/pack_route_guard.mjs --destination=/tmp/route-guard-072
```

`npm pack ./sdk/route-guard --ignore-scripts` writes a portable tar (gzip mtime 0; every member mtime `499162500`). Raw npm gzip bytes still vary by Node/zlib of the same tar. The helper then rewrites the gzip stream with `scripts/portable_npm_tgz.py` (zlib level 9, mtime 0, XFL 2, OS 255) so the tgz matches 402security.

Expected (two consecutive helper packs on the tip must match):

- `402signal-route-guard-0.7.2.tgz` SHA-256 `f23d534537a847d592770aea2bbdbbce493f668645d6dcf95985b21d2a70195a`
- `SHA256SUMS` SHA-256 `5fae35204f6c309b4f30384cf6cd66958e6bf09edfe8fea3d6859094d4754639`

A raw `npm pack` on some Node builds still emits `f09b4e03…` for the same tar. That is a gzip-stream difference, not a source-tree difference. Do not record `f09b4e03…` as a second published digest.

## 1. Qualify the local artifact

Security must reproduce `f23d5345…` / `5fae3520…` on this tip via `node scripts/pack_route_guard.mjs`, then run the archive checker on those **local** bytes. The checker digest-checks the candidate tarball and `SHA256SUMS` against that reviewed pair before install or import.

```sh
node scripts/check_route_guard_archive.mjs /tmp/route-guard-072/402signal-route-guard-0.7.2.tgz \
  --checksum-file /tmp/route-guard-072/SHA256SUMS \
  --historical-verifier https://github.com/402signalhq/402signal/releases/download/route-guard-v0.7.1/402signal-route-guard-0.7.1.tgz
```

This must show:

- candidate `sha256` `f23d5345…` and `checksum_file_sha256` `5fae3520…`
- 0.7.2 verifies current chk_grp leaves without buyer `merchant_profile`
- 0.7.2 still verifies historical leaves that name `merchant_profile`
- refuse-on-drift still fails closed
- published 0.7.1 (historical_verifier) still verifies those historical leaves and refuses current chk_grp requests that omit `merchant_profile`

Do not copy any digest into published `sha256` / `archive` / `checksum_file` fields at this step. Pending plus `provisional_*` (no published URLs) is the honest state until step 5.

## 2. Approve tag and release upload

Tag `route-guard-v0.7.2` at `fdbcff3bc9b31826567b8cb456d4a883009eb9ff` (or a later commit that does not change `sdk/route-guard`). Attach `402signal-route-guard-0.7.2.tgz` and `SHA256SUMS` from the local pack. Digests must match the reviewed pair.

## 3–4. Download and verify the released bytes

```sh
node scripts/check_route_guard_archive.mjs \
  https://github.com/402signalhq/402signal/releases/download/route-guard-v0.7.2/402signal-route-guard-0.7.2.tgz \
  --checksum-file https://github.com/402signalhq/402signal/releases/download/route-guard-v0.7.2/SHA256SUMS \
  --historical-verifier https://github.com/402signalhq/402signal/releases/download/route-guard-v0.7.1/402signal-route-guard-0.7.1.tgz
```

The downloaded tarball and `SHA256SUMS` must match the same reviewed pair. Mismatch fails closed; leave the row pending.

## 5–6. Publish the capabilities row

Only after the download matches, flip the capabilities row from `state=pending` to `state=published` with `published_at`, `archive`, `sha256`, `checksum_file`, and `checksum_file_sha256` matching that **downloadable** artifact. Set `source_revision` to the commit the tag actually points at. Remove `digest_status` and the `provisional_*` fields. If the downloadable tgz is not `f23d5345…`, leave the row pending with no published digest fields.

Do not set a Fly secret. Do not enable hosted Check group offer. Do not change Glama.
