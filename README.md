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
| `pnpm test`        | Vitest unit + DB integration tests (needs `pnpm db:up`)  |
| `pnpm db:up`       | Start local PostgreSQL (waits for healthy)               |
| `pnpm db:down`     | Stop local PostgreSQL (data persists in a named volume)  |
| `pnpm db:migrate`  | Apply Drizzle migrations                                 |
| `pnpm db:generate` | Generate a new migration from `packages/database` schema |

Configuration uses environment variables with zod validation and readable
startup errors; see `.env.example` for the variables and their defaults
(local development works with zero configuration).

### Database roles and tenancy

PostgreSQL enforces tenant isolation with row-level security (RLS) on all
tenant-owned tables. Two roles are created by the migration itself:

- `netrics_app` — the application role (`DATABASE_URL`). It is not a
  superuser and cannot bypass RLS; queries only see rows for the workspace
  set via `withWorkspace()` / `withUserContext()` from `@netrics/database`.
- `netrics` — the owner/migration role (`DATABASE_MIGRATION_URL`, used by
  `pnpm db:migrate` and `apps/server` migrations). In production, provision
  it (and the app role's password) with real secrets before migrating.

Because the roles are created by the migration, first-run order matters:
`pnpm db:up` → `pnpm db:migrate` → `pnpm dev` (`pnpm setup` does this for
you).

### Authentication

Sign-up, sign-in, and sessions are handled by
[better-auth](https://better-auth.com), mounted on the API under
`/api/auth/*`. Its tables live in the dedicated PostgreSQL schema `auth`
(installation-level, no tenant RLS) and only the server touches them — the
rest of the app sees a narrow `AuthService` interface
(`apps/server/src/auth/`). Each auth user is mirrored into the
installation-level `users` table on sign-up.

Relevant environment variables (see `.env.example`):

- `BETTER_AUTH_SECRET` — session signing secret, >= 32 chars. Required when
  `NODE_ENV=production`; an obviously insecure fixed default is used in
  development.
- `BETTER_AUTH_URL` — public base URL of the API (default
  `http://localhost:3001`).
- `WEB_ORIGIN` — web app origin allowed for credentialed CORS requests
  (default `http://localhost:3000`).

Email verification and password-reset emails are only logged by the server in
this milestone (no SMTP yet); session cookies are `better-auth.session_token`
with a 7-day expiry, validated against the database on every request so
sign-out revokes immediately.

Session-protected API routes live under `/v1` (currently `GET /v1/me` and
`POST /v1/bootstrap`, the one-time first-workspace setup).

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
