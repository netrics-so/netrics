# syntax=docker/dockerfile:1

# Base pinned by digest; bump deliberately (Dependabot proposes updates).
FROM node:26-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS base
RUN npm install -g pnpm@10.34.5
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @netrics/server... build
RUN pnpm deploy --legacy --filter @netrics/server --prod /prod/server
# Keep only what the server runs. Type declarations, source maps (the server
# runs without --enable-source-maps), docs and package tests are never loaded,
# and Node refuses to strip types under node_modules, so TypeScript sources
# shipped by dependencies are dead weight too. License, notice and copyright
# files always stay: their licenses require them to ship with the code. The
# image size budget is checked in CI.
RUN cd /prod/server \
 && find . -type f \( -name '*.map' -o -name '*.ts' -o -name '*.mts' -o -name '*.cts' \
      -o -name '*.md' -o -name '*.markdown' \) \
      ! -iname 'licen[cs]e*' ! -iname 'copying*' ! -iname 'notice*' \
      ! -iname 'copyright*' ! -iname 'authors*' ! -iname 'patents*' -delete \
 && find node_modules/.pnpm -mindepth 3 -maxdepth 4 -type d \
      \( -name test -o -name tests -o -name __tests__ -o -name examples -o -name example \
      -o -name docs -o -name bench -o -name benchmark -o -name benchmarks \) \
      -path '*/node_modules/*' -prune -exec rm -rf {} +

FROM node:26-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS runner
ARG APP_VERSION=0.0.0-dev
ARG GIT_SHA=dev
ENV NODE_ENV=production \
    APP_VERSION=$APP_VERSION \
    GIT_SHA=$GIT_SHA
WORKDIR /app
COPY --from=build /prod/server ./
# Never run as root; the application writes nothing to its filesystem.
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/index.js"]
