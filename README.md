# netrics

Metrics on every screen — a self-hosted dashboard platform. This repository is
the public monorepo: product app, API, renderer, and shared packages.

## Prerequisites

- **Node.js >= 24** (`.nvmrc` pins 24; `nvm use` or any Node 24+ works)
- **pnpm 10.34.5** — activate with `corepack enable` (the `packageManager`
  field pins the exact version)
- **Docker** with the compose plugin (local PostgreSQL)

## Quick start

```sh
pnpm setup
```

This installs dependencies, starts PostgreSQL in Docker, builds all packages,
and applies database migrations. Then:

```sh
pnpm dev
```

- Web: http://localhost:3000 — shows live API/database health
- API: http://localhost:3001 — `GET /health/live`, `GET /health/ready`

## Common commands

| Command            | What it does                                             |
| ------------------ | -------------------------------------------------------- |
| `pnpm setup`       | Install deps, start Postgres, build, migrate             |
| `pnpm dev`         | Run web + API in watch mode                              |
| `pnpm build`       | Build all packages and apps                              |
| `pnpm lint`        | ESLint (flat config)                                     |
| `pnpm format`      | Prettier write                                           |
| `pnpm typecheck`   | `tsc -b` project references + Next.js type check         |
| `pnpm test`        | Vitest unit tests                                        |
| `pnpm db:up`       | Start local PostgreSQL (waits for healthy)               |
| `pnpm db:down`     | Stop local PostgreSQL (data persists in a named volume)  |
| `pnpm db:migrate`  | Apply Drizzle migrations                                 |
| `pnpm db:generate` | Generate a new migration from `packages/database` schema |

Configuration uses environment variables with zod validation and readable
startup errors; see `.env.example` for the variables and their defaults
(local development works with zero configuration).

## Repository layout

```text
apps/
  web/        Next.js product application
  server/     Fastify API (worker/scheduler roles share this image later)
  renderer/   Playwright snapshot worker (placeholder)
packages/
  domain/     Domain rules (placeholder)
  database/   Drizzle schema, migrations, PostgreSQL access
  contracts/  Shared zod schemas for HTTP contracts
  ui/         Shared product UI (placeholder)
docs/         Architecture, milestones, decision records
deploy/       (reserved for the supported self-hosted compose deployment)
```

## Health checks and failure recovery

- `GET /health/live` — process is up; never touches the database.
- `GET /health/ready` — checks PostgreSQL connectivity; returns `503` with
  `{"status":"not_ready","database":"down",...}` when the database is
  unreachable and recovers automatically once PostgreSQL is back. No restart
  or rebuild of the application is needed.

Try it:

```sh
pnpm db:down                                  # stop PostgreSQL
curl -i http://localhost:3001/health/ready    # 503, database down
pnpm db:up                                    # start PostgreSQL again
curl -i http://localhost:3001/health/ready    # 200, ready
```

## Docker

Production images (multi-stage, `node:24-alpine`, no dev dependencies):

```sh
docker build -f apps/server/Dockerfile -t netrics-server .
docker build -f apps/web/Dockerfile -t netrics-web .
docker build -f apps/renderer/Dockerfile -t netrics-renderer .
```

To run the app images together with PostgreSQL:

```sh
docker compose -f docker-compose.yml -f docker-compose.app.yml up --build
```

(Apply migrations first with `pnpm db:migrate` against the compose database.)

## CI

`.github/workflows/ci.yml` runs format check, lint, type check, unit tests,
build, a migration apply + idempotency check against a PostgreSQL service
container, and Docker image builds for server, web, and renderer.
