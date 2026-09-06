# Offline/testing template. Pin NODE_IMAGE to a reviewed digest before publishing.
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
COPY config/offline.json ./config/offline.json
COPY config/*.example.json ./config/
COPY sdk ./sdk
RUN npm exec tsc && node --test dist/test/*.test.js && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node sdk ./sdk
COPY --chown=node:node config/offline.json ./config/offline.json
COPY --chown=node:node config/*.example.json ./config/
RUN mkdir -p /labdata /app/data && chown node:node /labdata /app/data
USER node
ENV NODE_ENV=production
EXPOSE 4021
CMD ["node", "dist/src/cli.js", "demo"]
