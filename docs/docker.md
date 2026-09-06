# Docker image notes

Base image is the official `python:3.12.14-slim` tag pinned to the
multi-arch index digest.

Chosen release: **Python 3.12.14**. Why: it is the 3.12 security
release that includes **gh-150743** (GHSA-w4q2-g22w-6fr4). Outbound
`http.client` now limits chunked-response trailer lines and interim
(1xx) responses to 100 each and raises `HTTPException` past either
limit. A malicious seller can no longer stream `100 Continue` or
trailers forever and hang a probe even when a socket timeout is set.

`python:3.12.11-slim` does **not** contain that fix. Pinning 3.12.11
and bounding inbound `http_body` reads does not close this P1.

```
docker buildx imagetools inspect python:3.12.14-slim
```

This cloud environment had no docker CLI (`docker buildx imagetools
inspect` is the intended pin command). The same official index
digest was read from the registry APIs that imagetools uses:

1. Docker Hub `library/python` tag `3.12.14-slim` (`digest` field)
2. `registry-1.docker.io` `Docker-Content-Digest` for
   `manifests/3.12.14-slim` (OCI image index)

Reconfirmed 2026-09-01. Both returned:

`sha256:e5c9fa26ffb76e11e0f054f30dc2523a2f9693f0c36c0cf1e39b27e152d899fc`

Dockerfile:

`FROM python:3.12.14-slim@sha256:e5c9fa26ffb76e11e0f054f30dc2523a2f9693f0c36c0cf1e39b27e152d899fc`

linux/amd64 platform manifest under that index:
`sha256:2fe5997d249a808b8eeea52c58a1dbffbba28754dc11699ef5c029f2d818ce79`

Do not invent a digest. Do not roll back to 3.12.11.

## Hash-locked requirements

`requirements.in` owns the direct `cryptography==50.0.1` policy pin.
`requirements.txt` is the universal, transitive lock generated with:

```
uv pip compile requirements.in --universal --python-version 3.12 --generate-hashes --no-emit-index-url -o requirements.txt
```

The lock includes hashes for every published wheel needed across the
supported developer platforms, plus `cffi` and `pycparser`. CI and the
Docker image both install with `--require-hashes`; an unpinned package or
unapproved artifact fails the build. Review both the version change and
the regenerated hashes whenever the direct dependency is updated.

## Non-root runtime

The image runs as UID/GID `10001:10001`. A fresh image-owned `/data` directory
belongs to that user. Mounted volumes preserve their existing ownership;
they require the explicit migration described in `docs/remediation-rollout.md`.

`scripts/prepare_volume.py --volume /data` prints a plan. It never recursively
changes files and refuses symlinks and hard-linked database files. After the
single writer is stopped and a complete backup is verified, the volume
administrator may apply that exact plan with `--apply --router-stopped`.
Save the previous owners/modes as the rollback record. Startup performs no
privileged ownership change. The image must not be deployed onto an unmigrated
root-owned volume: fail-closed readiness would make the service unavailable.

Validate the built image against a synthetic volume first: run with the normal
USER, a read-only root filesystem, writable `/tmp` and `/data`, and no network.
Confirm catalog/history/PQ/replay writes and complete backup/restore work as
10001. Test an unmigrated volume fails safely, then migrate it and confirm
existing pending/settled replay records are preserved. Production still needs
its operator migration and health/readiness checks; a local rehearsal does not
attest deployed ownership.
