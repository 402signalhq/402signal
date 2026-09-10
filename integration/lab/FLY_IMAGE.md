# Lab Fly image startup

The machine command is `node /app/start-seller.mjs`. It refuses unless
`FLY_APP_NAME` is exactly `402signal-lab-ross`, `/labdata` is a real directory,
and the seller-deploy file is readable. If the process starts as root it owns
`/labdata` as uid/gid 1000 mode 0700 and drops privileges before serve.

## Durable seller-deploy

The image does not bake production `seller-deploy.json`. Leftover files from a
previous image rootfs are not the delivery mechanism.

Keep the approved config on the `/labdata` volume and set
`LAB_SELLER_DEPLOY=/labdata/seller-deploy.json`. That path must be a real file
on the mounted volume, not a symlink and not a file from the image layer.
Alternatively, a Fly file or secret mount may place the same approved file at
`/app/config/seller-deploy.json` (the default path when `LAB_SELLER_DEPLOY` is
unset). Do not commit production seller-deploy contents.

Cloud smoke mounts a synthetic offline fixture at
`/labdata/seller-deploy.json` and sets `FLY_APP_NAME=402signal-lab-ross`.

## Pinned Node image

Qualified builds pass `NODE_IMAGE` from `node-image.pin` into
`Dockerfile.fly`. Do not use a floating `node:24-bookworm-slim` tag for
release or CI image smoke.
