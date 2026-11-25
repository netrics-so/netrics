# syntax=docker/dockerfile:1

# Base pinned by digest; bump deliberately (Renovate proposes updates).
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS base
RUN npm install -g pnpm@10.34.5
# The runtime stage copies only the Node binary, so ship its license (with
# the notices of everything Node bundles) next to it. The upstream arm64
# image builds Node from source and has no LICENSE file, so fetch the one of
# this exact release on every platform.
RUN mkdir -p /usr/local/share/licenses/node \
 && wget -qO /usr/local/share/licenses/node/LICENSE \
      "https://raw.githubusercontent.com/nodejs/node/$(node -p process.version)/LICENSE" \
 && test -s /usr/local/share/licenses/node/LICENSE
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

# Runtime: plain Alpine plus the Node binary, nothing else. The node image
# also ships npm and its bundled dependencies, which this container never runs
# and which carried every high-severity finding in the image scan (#906).
# Node bundles its own OpenSSL and zlib and links only musl, libstdc++, libgcc
# and libatomic. Keep this Alpine release the one the node image above is
# built on (/etc/alpine-release in it) when bumping either digest; the web
# Dockerfile uses the same pair.
FROM alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS runner
# apk upgrade ships fixed Alpine packages (OpenSSL, zlib for apk and busybox)
# without waiting for a new base digest; CI fails on fixable high findings.
RUN apk upgrade --no-cache \
 && apk add --no-cache libstdc++ libgcc libatomic \
 && addgroup -g 1000 node \
 && adduser -u 1000 -G node -s /bin/sh -D node
COPY --from=base /usr/local/bin/node /usr/local/bin/node
COPY --from=base /usr/local/share/licenses/node /usr/local/share/licenses/node
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
