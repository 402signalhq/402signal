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

For a local buyer container (lab-only context), first run the build above to
synchronize sdk/, then:

```sh
podman build --build-arg NODE_IMAGE=YOUR_REVIEWED_NODE_24_IMAGE -t localhost/402signal-lab:reviewed integration/lab
```

Fly lab publishes use `integration/lab/Dockerfile.fly` with the `integration/`
context. The machine command is `node /app/start-seller.mjs`. The locked
`integration/mpp-algorand` package is copied to `/app/native-mpp/algorand` with
`/mpp-algorand` pointing at that directory so compiled seller registration can
load `lab-merchant.mjs`. `index.mjs` repository-relative `../../sdk/route-guard`
imports resolve through `/app/sdk`.

```sh
podman build --build-arg NODE_IMAGE=$(cat integration/lab/node-image.pin) \
  -f integration/lab/Dockerfile.fly -t localhost/402signal-lab:reviewed integration
```

Qualified Fly image builds use the digest in `node-image.pin`. Keep the
approved seller-deploy file on the `/labdata` volume and set
`LAB_SELLER_DEPLOY=/labdata/seller-deploy.json`. Image-layer leftovers are not
the delivery mechanism. See [Fly image startup](FLY_IMAGE.md). Do not commit
production seller-deploy contents. Paid runs retain all explicit policy,
wallet, recipient, fee, budget and network gates. Recovery needs public policy,
the ledger and RPC access, but no private wallet environment.

See [recovery and observability](../../docs/route-recovery-observability.md).
