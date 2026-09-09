# Fly image build file for the controlled lab seller.
# There is no separate Dockerfile.fly; build this file from the integration/
# context so the locked native Algorand MPP package can be copied to
# /mpp-algorand (compiled /app/dist/src imports resolve there).
#
#   podman build --build-arg NODE_IMAGE=YOUR_REVIEWED_NODE_24_IMAGE \
#     -f lab/Dockerfile -t localhost/402signal-lab:reviewed .
# (cwd = integration/)
#
# Keep /app/dist + /app/sdk runtime paths. Pin NODE_IMAGE to the reviewed
# digest when publishing. Full repository and PostgreSQL integration tests
# run in cloud CI before build.
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY lab/package.json lab/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY lab/solana-session-contracts/package.json lab/solana-session-contracts/package-lock.json ./solana-session-contracts/
RUN npm ci --prefix solana-session-contracts --omit=dev --ignore-scripts --no-audit --no-fund
COPY lab/tsconfig.json lab/tsconfig.image.json ./
COPY lab/src ./src
COPY lab/config/offline.json ./config/offline.json
COPY lab/config/*.example.json ./config/
COPY lab/sdk ./sdk
COPY lab/solana-session-contracts/src ./solana-session-contracts/src
RUN npm exec tsc -- --project tsconfig.image.json && node dist/src/cli.js demo && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE} AS mpp
WORKDIR /mpp-algorand
COPY mpp-algorand/package.json mpp-algorand/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY mpp-algorand/index.mjs mpp-algorand/lab-merchant.mjs mpp-algorand/lab-sdk-worker.mjs ./

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/solana-session-contracts ./solana-session-contracts
COPY --from=mpp --chown=node:node /mpp-algorand /mpp-algorand
COPY --chown=node:node lab/package.json ./
COPY --chown=node:node lab/sdk ./sdk
COPY --chown=node:node lab/sdk /sdk
COPY --chown=node:node lab/config/offline.json ./config/offline.json
COPY --chown=node:node lab/config/*.example.json ./config/
RUN mkdir -p /labdata /app/data && chown node:node /labdata /app/data /mpp-algorand /sdk
USER node
ENV NODE_ENV=production
# Fail the image build if compiled seller resolution or package deps are missing.
RUN node --input-type=module -e "import { resolve } from 'node:path'; import { accessSync, constants, lstatSync } from 'node:fs'; const merchant = resolve('/app/dist/src','../../../mpp-algorand/lab-merchant.mjs'); if (merchant !== '/mpp-algorand/lab-merchant.mjs') process.exit(1); if (lstatSync('/mpp-algorand').isSymbolicLink()) process.exit(1); accessSync(merchant, constants.R_OK); accessSync('/mpp-algorand/lab-sdk-worker.mjs', constants.R_OK); accessSync('/sdk/route-guard/batch.mjs', constants.R_OK); const m = await import(merchant); if (typeof m.createNativeAlgorandLabMerchant !== 'function' || typeof m.validateNativeAlgorandLabConfig !== 'function') process.exit(1);"
EXPOSE 4021
CMD ["node", "dist/src/cli.js", "demo"]
