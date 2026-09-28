# syntax=docker/dockerfile:1

# Base pinned by digest; bump deliberately (Dependabot proposes updates).
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS base
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
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

FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS runner
# NETRICS_API_URL (where the web server reaches the API) is read at request
# time; set it per deployment, e.g. http://api:3001 in Compose. Nothing about
# the API location is baked into the image.
ARG NEXT_PUBLIC_APP_VERSION=0.0.0-dev
ARG NEXT_PUBLIC_GIT_SHA=dev
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
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
