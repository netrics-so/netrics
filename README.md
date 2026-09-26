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

- Web: http://localhost:3000 — sign up / sign in, workspaces, projects
  (live API/database health moved to `/status`)
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

Session-protected API routes live under `/v1`:

- `GET /v1/me` — current user and workspace memberships.
- `POST /v1/bootstrap` — one-time first-workspace setup (409 afterwards).
- `POST /v1/workspaces`, `GET /v1/workspaces`,
  `GET/PATCH /v1/workspaces/:id` — workspace CRUD (rename: owner/admin).
- `GET/POST /v1/workspaces/:id/members`,
  `PATCH/DELETE /v1/workspaces/:id/members/:userId` — membership management
  (owner/admin; only owners grant or touch the owner role; any member may
  remove themselves; the last owner can never leave).
- `PATCH /v1/workspaces/:id/active-project` — the caller's active project.
- `POST/GET /v1/workspaces/:id/projects`,
  `PATCH/DELETE /v1/workspaces/:id/projects/:projectId` — projects
  (create/rename: owner/admin/editor; delete: owner/admin).
- `GET /v1/workspaces/:id/audit-events` — workspace audit log (owner/admin,
  newest first, limit 100).

Non-members always get 404 for workspace routes (existence is never leaked),
and every mutation writes an audit event in the same transaction. Sign-ins
additionally write an installation-level `auth.login` audit row
(`workspace_id` NULL) that tenants cannot see.

### Web app and the API proxy

The web app has email+password UI for the flows above: `/signup` and `/login`
(better-auth, auto sign-in on sign-up since verification is not enforced),
`/` (redirects to your first workspace, or creates one when you have none),
`/workspaces/:id` (projects + workspace switcher), `/workspaces/:id/settings`
(rename, members, roles — owner/admin manage; editors/viewers read-only), and
`/settings/account` (profile, memberships, change password, sign out).
Members are added directly by email — the person must already have an
account; email invitations arrive in a later milestone.

The browser never talks to the API directly. Next.js rewrites
(`apps/web/next.config.ts`) proxy `/api/auth/*` and `/v1/*` to the API, so
the session cookie is a plain first-party cookie on the web origin — no CORS
or cross-site cookie configuration is needed. Client-side code calls
same-origin relative URLs; server components call the API at
`NETRICS_API_URL` and forward the incoming `cookie` header verbatim (the web
app transports the cookie but never inspects it). better-auth is imported in
exactly one place, `apps/web/src/lib/auth.ts`.

Web environment variables:

- `NETRICS_API_URL` — where the web server reaches the API (default
  `http://localhost:3001`). Used for server-side fetches **and** baked into
  the rewrite destinations at build time, so when it differs from the default
  it must be set for both `next build` and `next start`.
- No `NEXT_PUBLIC_` API URL exists on purpose: the browser only ever uses
  same-origin relative URLs, so nothing API-related is inlined into the
  client bundle.

## Repository layout

```text
apps/
  web/        Next.js product application
  server/     Fastify API (worker/scheduler roles share this image later)
  renderer/   Playwright snapshot worker (placeholder)
packages/
  domain/     Domain rules (role/permission matrix, pure functions)
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
