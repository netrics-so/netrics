# syntax=docker/dockerfile:1

FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @netrics/server... build
RUN pnpm deploy --legacy --filter @netrics/server --prod /prod/server

FROM node:24-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /prod/server ./
EXPOSE 3001
CMD ["node", "dist/index.js"]
