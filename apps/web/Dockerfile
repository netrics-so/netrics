# syntax=docker/dockerfile:1

FROM node:24-alpine AS base
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

FROM node:24-alpine AS runner
ARG NEXT_PUBLIC_APP_VERSION=0.0.0-dev
ARG NEXT_PUBLIC_GIT_SHA=dev
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    NEXT_PUBLIC_APP_VERSION=$NEXT_PUBLIC_APP_VERSION \
    NEXT_PUBLIC_GIT_SHA=$NEXT_PUBLIC_GIT_SHA
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
