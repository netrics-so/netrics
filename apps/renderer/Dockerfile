# syntax=docker/dockerfile:1

# Base pinned by digest; bump deliberately (Dependabot proposes updates).
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS base
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @netrics/renderer... build
RUN pnpm deploy --legacy --filter @netrics/renderer --prod /prod/renderer

FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS runner
ARG APP_VERSION=0.0.0-dev
ARG GIT_SHA=dev
ENV NODE_ENV=production \
    APP_VERSION=$APP_VERSION \
    GIT_SHA=$GIT_SHA
WORKDIR /app
COPY --from=build /prod/renderer ./
CMD ["node", "dist/index.js"]
