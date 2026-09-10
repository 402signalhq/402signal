# route-guard 0.7.2 release checklist

For 402QA after security GO. No Fly secret, no `BATCH_OBSERVATION_PROFILES` enablement, no spend, Glama unchanged.

The pending capabilities row records PR169's merge SHA and a portable `npm pack` digest. Those fields stay `state=pending` until the local artifact is qualified, the tag is uploaded, and the downloaded GitHub bytes match the reviewed pair.

Step 1 is complete on `e648ff9` (PR173). 402QA owns the tag upload. Do not flip `state=published` until the downloadable GitHub bytes match.

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

### Local qualification record (PR173 tip)

Executed on `main` tip `e648ff9a3eda0ce5a07ce856482e260918dc7fb3` (merge of PR173). `sdk/route-guard` tree `8c90067b2d6f0e2e1759c430d88eb8e67d1d592e` is identical at `1a9da77`, PR169 merge `fdbcff3bc9b31826567b8cb456d4a883009eb9ff`, and this tip. Toolchain: npm 10.9.7, Node v22.14.0, Python 3.12.3.

Two consecutive `node scripts/pack_route_guard.mjs --destination=/tmp/route-guard-072` packs matched:

- pack SHA-256 `f23d534537a847d592770aea2bbdbbce493f668645d6dcf95985b21d2a70195a`
- `SHA256SUMS` SHA-256 `5fae35204f6c309b4f30384cf6cd66958e6bf09edfe8fea3d6859094d4754639`

Archive-checker on those **local** bytes (pre-install digest/SUMS, plus published 0.7.1 historical verifier) **PASS**:

- candidate `sha256` / `checksum_file_sha256` matched the reviewed pair
- 0.7.2 verified 6 chk_grp leaves (`atom`, `exact`, `inv`, `mpp`, `sess`) without buyer `merchant_profile`
- 0.7.2 verified 3 historical leaves that name `merchant_profile`
- refuse-on-drift failed closed
- published 0.7.1 still verified those historical leaves and refused all 6 current chk_grp requests

Capabilities stay `state=pending`. No published digest fields in this step.

## 2. Approve tag and release upload

Tag `route-guard-v0.7.2` at `fdbcff3bc9b31826567b8cb456d4a883009eb9ff` so `source_revision` equals the tag target. A later commit is also valid only if `sdk/route-guard` is still tree `8c90067b2d6f0e2e1759c430d88eb8e67d1d592e` (true of `e648ff9`). Attach the local-qualified `402signal-route-guard-0.7.2.tgz` and `SHA256SUMS`. Digests must match the reviewed pair.

This environment cannot create GitHub releases. 402QA should run the following after confirming the local files still hash to the reviewed pair:

```sh
# From a checkout of e648ff9a3eda0ce5a07ce856482e260918dc7fb3 or newer main
# that does not change sdk/route-guard:
npm --version    # 10.9.7
node scripts/pack_route_guard.mjs --destination=/tmp/route-guard-072
sha256sum /tmp/route-guard-072/402signal-route-guard-0.7.2.tgz /tmp/route-guard-072/SHA256SUMS
# expect f23d5345… and 5fae3520…

cat > /tmp/route-guard-072/RELEASE_NOTES.md <<'EOF'
Customer chk_grp requests omit merchant_profile. Historical leaves that still name merchant_profile continue to verify.

GitHub release tarball only — not an npm registry publication. Server image deploys do not update already-installed clients.

## Install
1. Download `402signal-route-guard-0.7.2.tgz`
2. Verify SHA-256 against `SHA256SUMS` / this release body
3. `npm install ./402signal-route-guard-0.7.2.tgz`

## Digest
- `402signal-route-guard-0.7.2.tgz` SHA-256 `f23d534537a847d592770aea2bbdbbce493f668645d6dcf95985b21d2a70195a`
- `SHA256SUMS` SHA-256 `5fae35204f6c309b4f30384cf6cd66958e6bf09edfe8fea3d6859094d4754639`

See attached SHA256SUMS.
EOF

gh release create route-guard-v0.7.2 \
  --repo 402signalhq/402signal \
  --target fdbcff3bc9b31826567b8cb456d4a883009eb9ff \
  --title "@402signal/route-guard 0.7.2" \
  --notes-file /tmp/route-guard-072/RELEASE_NOTES.md \
  /tmp/route-guard-072/402signal-route-guard-0.7.2.tgz \
  /tmp/route-guard-072/SHA256SUMS
```

Expected release URL: `https://github.com/402signalhq/402signal/releases/tag/route-guard-v0.7.2`

## 3–4. Download and verify the released bytes

```sh
node scripts/check_route_guard_archive.mjs \
  https://github.com/402signalhq/402signal/releases/download/route-guard-v0.7.2/402signal-route-guard-0.7.2.tgz \
  --checksum-file https://github.com/402signalhq/402signal/releases/download/route-guard-v0.7.2/SHA256SUMS \
  --historical-verifier https://github.com/402signalhq/402signal/releases/download/route-guard-v0.7.1/402signal-route-guard-0.7.1.tgz
```

The downloaded tarball and `SHA256SUMS` must match the same reviewed pair. Mismatch fails closed; leave the row pending.

Also confirm the downloaded bytes themselves:

```sh
curl -fsSL -o /tmp/rg-072-dl.tgz \
  https://github.com/402signalhq/402signal/releases/download/route-guard-v0.7.2/402signal-route-guard-0.7.2.tgz
curl -fsSL -o /tmp/rg-072-dl.SUMS \
  https://github.com/402signalhq/402signal/releases/download/route-guard-v0.7.2/SHA256SUMS
sha256sum /tmp/rg-072-dl.tgz /tmp/rg-072-dl.SUMS
# expect f23d5345… and 5fae3520…
```

## 5–6. Publish the capabilities row

Only after the download matches, flip the capabilities row from `state=pending` to `state=published` in a **follow-up PR**. Do not land that flip in the same change as local qualification.

Fill these fields from the **downloadable** artifact (not the local pack alone). `published_at` is the GitHub release timestamp. `source_revision` is the commit the tag actually points at (`fdbcff3bc9b31826567b8cb456d4a883009eb9ff` if the command above was used unchanged).

```json
{
  "tag": "route-guard-v0.7.2",
  "published_at": "FILL_AFTER_DOWNLOAD_VERIFY",
  "source_revision": "fdbcff3bc9b31826567b8cb456d4a883009eb9ff",
  "archive": "https://github.com/402signalhq/402signal/releases/download/route-guard-v0.7.2/402signal-route-guard-0.7.2.tgz",
  "sha256": "f23d534537a847d592770aea2bbdbbce493f668645d6dcf95985b21d2a70195a",
  "checksum_file": "https://github.com/402signalhq/402signal/releases/download/route-guard-v0.7.2/SHA256SUMS",
  "checksum_file_sha256": "5fae35204f6c309b4f30384cf6cd66958e6bf09edfe8fea3d6859094d4754639",
  "distribution": "GitHub release archive; not npm registry",
  "state": "published",
  "recipe": "/developers/check-group-offer"
}
```

Remove `digest_status` and the `provisional_*` fields. If the downloadable tgz is not `f23d5345…`, leave the row pending with no published digest fields.

Do not set a Fly secret. Do not enable hosted Check group offer. Do not change Glama.
