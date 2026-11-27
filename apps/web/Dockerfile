# syntax=docker/dockerfile:1@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183

# Base pinned by digest; bump deliberately (Renovate proposes updates).
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS base
RUN npm install -g pnpm@10.34.5
# Node's license for the runtime stage; see apps/server/Dockerfile.
RUN mkdir -p /usr/local/share/licenses/node \
 && wget -qO /usr/local/share/licenses/node/LICENSE \
      "https://raw.githubusercontent.com/nodejs/node/$(node -p process.version)/LICENSE" \
 && test -s /usr/local/share/licenses/node/LICENSE
WORKDIR /app

FROM base AS build
ARG NEXT_PUBLIC_APP_VERSION=0.0.0-dev
ARG NEXT_PUBLIC_GIT_SHA=dev
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_APP_VERSION=$NEXT_PUBLIC_APP_VERSION \
    NEXT_PUBLIC_GIT_SHA=$NEXT_PUBLIC_GIT_SHA
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @netrics/web... build

# Runtime: plain Alpine plus the Node binary, without npm (#906). Same pair of
# base digests and reasons as apps/server/Dockerfile; keep them in step.
FROM alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS runner
RUN apk upgrade --no-cache \
 && apk add --no-cache libstdc++ libgcc libatomic \
 && addgroup -g 1000 node \
 && adduser -u 1000 -G node -s /bin/sh -D node
COPY --from=base /usr/local/bin/node /usr/local/bin/node
COPY --from=base /usr/local/share/licenses/node /usr/local/share/licenses/node
# NETRICS_API_URL (where the web server reaches the API) is read at request
# time; set it per deployment, e.g. http://api:3001 in Compose. Nothing about
# the API location is baked into the image.
ARG NEXT_PUBLIC_APP_VERSION=0.0.0-dev
ARG NEXT_PUBLIC_GIT_SHA=dev
# KEEP_ALIVE_TIMEOUT (ms, read by the standalone server.js): the proxy in
# front keeps idle connections to this server open and reuses them (Railway's
# edge for 60 s, Caddy's reverse_proxy for 2 min). Node closes them after 5 s
# by default, so a request the proxy sends on a connection being closed fails
# and reaches the browser as a 502/503: sporadic failed prefetches, or a page
# that never hydrates when a script chunk is hit (#195). Outlast both.
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    KEEP_ALIVE_TIMEOUT=125000 \
    NEXT_PUBLIC_APP_VERSION=$NEXT_PUBLIC_APP_VERSION \
    NEXT_PUBLIC_GIT_SHA=$NEXT_PUBLIC_GIT_SHA \
    NETRICS_API_URL=http://localhost:3001
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
