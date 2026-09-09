# Reference buyer and seller

Source-only fixtures adopted from the operator-tested v0.4.0 lab, including the
strict seller challenge and bound-GET fixes. Only offline/example configurations
are versioned. There are no production credentials, wallet files or ledgers here.
The repository SDK is copied into an ignored local sdk/ directory during build,
so buyer and contract tests use the reviewed guard rather than a registry name.

From the repository root, using Node 24 and the locked Python dependencies:

```sh
npm --prefix integration/lab ci --ignore-scripts --no-audit --no-fund
npm --prefix integration/lab test
PYTHONPATH=.:tests LIVE402_FIXTURE=1 python -m unittest discover -s integration/tests -v
```

For a buyer container, first run the build above to synchronize sdk/, then
build the Fly image from the `integration/` context. `integration/lab/Dockerfile`
is the Fly image build file; there is no separate `Dockerfile.fly`.

```sh
podman build --build-arg NODE_IMAGE=YOUR_REVIEWED_NODE_24_IMAGE \
  -f integration/lab/Dockerfile -t localhost/402signal-lab:reviewed integration
```

The runtime image copies the locked `integration/mpp-algorand` package to
`/mpp-algorand` (sources plus production `node_modules`) so compiled seller
registration can load `lab-merchant.mjs` without a post-build symlink. The
package's repository-relative `../../sdk/route-guard` imports use a second
copy of the already-required lab SDK at `/sdk`.

Pin NODE_IMAGE to a reviewed digest before publishing. The default image command
runs an offline demo. Existing live configurations, public verification-key pins
and ledgers must be mounted separately; paid runs retain all explicit policy,
wallet, recipient, fee, budget and network gates. Recovery needs public policy,
the ledger and RPC access, but no private wallet environment.

See [recovery and observability](../../docs/route-recovery-observability.md).
