# Release verification

Published client downloads are preserved byte for byte. [The release manifest](../releases/manifest.json) records their SHA-256 digests and original publication dates.

Download an archive and its `SHA256SUMS` (or `SHA256SUMS.txt`) file from the same release, then verify it before installing:

```sh
sha256sum --check SHA256SUMS
```

The repository contains public clients and verification code. Historical release tags contain the files from the published client package, or the original Python client source subtree. Their Git commit IDs and GitHub-generated source archives differ from the earlier full-service repository. Use the named package download when you need the original released artifact.

## Original signed attestations

Route-guard releases 0.7.4, 0.7.6 and 0.7.7 include preserved Sigstore bundles named `<archive>.sigstore-1.json`. These are the original signatures, not new attestations of a rebuild. The original signing repository ID was `1351479757`; the public client repository has a different ID. Automatic attestation lookup against this repository therefore cannot retrieve those historical records.

With a recent GitHub CLI, download the archive and its bundle from the release, then verify the supplied bundle:

```sh
gh attestation verify 402signal-route-guard-0.7.7.tgz \
  --repo 402signalhq/402signal \
  --bundle 402signal-route-guard-0.7.7.tgz.sigstore-1.json \
  --signer-workflow 402signalhq/402signal/.github/workflows/attest-release.yml \
  --source-ref refs/tags/route-guard-v0.7.7 \
  --source-digest b3333fc0e8f1211e3a07d258da571c96bb7b157c \
  --deny-self-hosted-runners
```

The source digest above is the original signed release revision, not the replacement repository's historical tag commit.

The historical workflow attested archives attached to a release. Its signature authenticates the archived release workflow evidence; it does not by itself establish a reproducible source-to-binary build. See [GitHub CLI verification options](https://cli.github.com/manual/gh_attestation_verify) for additional identity checks and trusted-root configuration.

The npm and PyPI packages retain their original registry versions and provenance. This repository split does not republish those versions or change licenses already granted. The root license is MIT; the JavaScript route guard and Python SDK retain their Apache-2.0 licenses and notices.
