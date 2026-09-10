# Keep the existing lab-only context and /app/dist + /app/sdk runtime paths.
# Fly lab publishes use Dockerfile.fly (integration/ context, start-seller
# entrypoint, /app/native-mpp/algorand). Full repository and PostgreSQL
# integration tests run in cloud CI before build. Pin NODE_IMAGE to the
# reviewed digest when publishing.
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY solana-session-contracts/package.json solana-session-contracts/package-lock.json ./solana-session-contracts/
RUN npm ci --prefix solana-session-contracts --omit=dev --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.image.json ./
COPY src ./src
COPY config/offline.json ./config/offline.json
COPY config/*.example.json ./config/
COPY sdk ./sdk
COPY solana-session-contracts/src ./solana-session-contracts/src
RUN npm exec tsc -- --project tsconfig.image.json && node dist/src/cli.js demo && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/solana-session-contracts ./solana-session-contracts
COPY --chown=node:node package.json ./
COPY --chown=node:node sdk ./sdk
COPY --chown=node:node config/offline.json ./config/offline.json
COPY --chown=node:node config/*.example.json ./config/
RUN mkdir -p /labdata /app/data && chown node:node /labdata /app/data
USER node
ENV NODE_ENV=production
EXPOSE 4021
CMD ["node", "dist/src/cli.js", "demo"]
