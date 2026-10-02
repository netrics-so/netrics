# netrics

Metrics on every screen — a self-hosted dashboard platform. This repository is
the public monorepo: product app, API, and shared packages.

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

- Web: http://localhost:3000 — sign up / sign in, workspaces, projects,
  connections (live API/database health moved to `/status`)
- API: http://localhost:3001 — `GET /health/live`, `GET /health/ready`

`pnpm dev` runs only web + API. To see connector syncs execute locally, also
run the worker and scheduler roles in two more terminals:

```sh
NETRICS_ROLE=worker pnpm --filter @netrics/server dev
NETRICS_ROLE=scheduler pnpm --filter @netrics/server dev
```

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
tenant-owned tables. The migration itself creates two login roles:

- `netrics_app` — the application role (`DATABASE_URL`). It is not a
  superuser and cannot bypass RLS; queries only see rows for the workspace
  set via `withWorkspace()` / `withUserContext()` from `@netrics/database`.
- `netrics_scheduler` — the scheduler/worker role (`DATABASE_SCHEDULER_URL`,
  used by `NETRICS_ROLE=worker` and `NETRICS_ROLE=scheduler`). It claims and
  advances jobs across all workspaces, enqueues due syncs, writes
  `worker_heartbeats`, and reads the scheduling columns of `connection_state`
  — but has no grant on `connections` at all, so it cannot read credential
  material. Job claiming runs through the SECURITY DEFINER `claim_jobs()`
  function (ADR 0006), which deliberately bypasses tenant context.
- `netrics` — the owner/migration role (`DATABASE_MIGRATION_URL`, used by
  `pnpm db:migrate` and `apps/server` migrations).

Migrations create `netrics_app` and `netrics_scheduler` without credentials.
`migrate` then enables login and sets their passwords from
`NETRICS_APP_DB_PASSWORD` and `NETRICS_SCHEDULER_DB_PASSWORD`. Outside
production these default to the role names. In production they must be real
secrets, and `migrate` exits with an error while a role still accepts its
public development password.

The api, worker and scheduler check their database role at startup and exit
if it is a superuser or has `BYPASSRLS`, because PostgreSQL skips row-level
security for such roles. `NETRICS_ALLOW_PRIVILEGED_DB=true` disables the check
for local debugging only and is rejected in production. Connection queries
also filter by workspace explicitly, so isolation does not rely on RLS alone.

First-run order matters: `pnpm db:up` → `pnpm db:migrate` → `pnpm dev`
(`pnpm setup` does this for you).

### Worker and scheduler processes

`apps/server` runs one of three roles via `NETRICS_ROLE`:

- `api` (default) — the Fastify REST API.
- `worker` — claims durable jobs from the `jobs` table (`FOR UPDATE SKIP
LOCKED` via `claim_jobs()`), executes handlers by job kind
  (`apps/server/src/jobs/handlers.ts`), and completes/retries/dead-letters
  them. Tenant work runs as `netrics_app` inside `withWorkspace()`; the
  executor rejects jobs whose payload workspace/connection identity disagrees
  with the job row (tampering guard). Retries use exponential backoff
  (2^attempts × 15s, capped at 15 min); exhausted or non-retryable jobs go to
  `dead`. Horizontally scalable.
- `scheduler` — every `SCHEDULER_POLL_MS` it plans due syncs from
  `connection_state` (idempotency-keyed per connection per hour), advancing
  `next_due_at` by the connection's `poll_interval_seconds`. Single active
  instance, enforced by a PostgreSQL advisory lock; contenders exit and wait
  for the platform to restart them.

Both send liveness heartbeats to `worker_heartbeats` and never read
credentials: claiming runs as `netrics_scheduler`, which has no grant on
`connections` (ADR 0006).

Relevant environment variables (see `.env.example`):

- `DATABASE_SCHEDULER_URL` — scheduler-role connection. Required in
  production for worker/scheduler roles.
- `SCHEDULER_POLL_MS` (default 5000), `WORKER_POLL_MS` (default 1000),
  `WORKER_CONCURRENCY` (default 4).

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
- `APP_ENCRYPTION_KEY` — instance master key for connection credentials, as
  base64 of exactly 32 bytes (`openssl rand -base64 32`). Required when
  `NODE_ENV=production`; development uses an obviously insecure fixed default.
  Credentials are stored as AES-256-GCM envelopes in
  `connections.credentials_encrypted`. Each envelope names its key by
  fingerprint and is authenticated together with its workspace and connection
  ids, so an envelope copied to another row does not decrypt. Log and error
  paths run values through `redactSecrets()` (`apps/server/src/credentials.ts`).
  **Back up this key.** Without it, stored credentials cannot be recovered.
- `APP_ENCRYPTION_KEYS_PREVIOUS` — retired keys (comma-separated) that can
  still decrypt existing envelopes during a rotation.
- `BETTER_AUTH_URL` — public base URL of the auth endpoints as browsers reach
  them (default `http://localhost:3001`). The api requires an `https://` value
  when `NODE_ENV=production`; better-auth then issues `Secure` cookies.
- `WEB_ORIGIN` — web app origin allowed for credentialed CORS requests
  (default `http://localhost:3000`); same production rule.
- `SMTP_URL` and `MAIL_FROM` — outbound email for verification and password
  reset (`smtps://user:pass@host:465`). In local development, without SMTP,
  the links are logged. Anywhere else, without SMTP, the server refuses to
  send them and never logs them.
- `NETRICS_OAUTH_GOOGLE_CLIENT_ID` and `NETRICS_OAUTH_GOOGLE_CLIENT_SECRET` —
  the instance's Google OAuth app (ADR 0012), both or neither (startup fails
  naming the missing one). Without them Google connectors are listed as
  unavailable and cannot be connected. The redirect URI to register is
  `<WEB_ORIGIN>/oauth/google/callback`; the api logs it at startup, never the
  secret. The api and the worker read them.

- `NETRICS_SIGNUP` — `closed` (default in production) or `open` (default
  otherwise; the hosted service sets it explicitly). With closed sign-up and no
  account yet, the api logs a one-time setup URL (`<WEB_ORIGIN>/setup?token=…`)
  on startup. Only that token can create the first account, and it is consumed
  atomically. Every later account needs an invitation (#27).
  `NETRICS_SETUP_TOKEN` fixes the token instead of logging a generated one.
  `GET /v1/setup-status` (public) tells the web app whether setup is pending.
- `NETRICS_AUTH_RATE_LIMIT` — `on` (default in production) or `off`.
  Sign-in, sign-up, password reset and verification mail are limited per
  client IP (`apps/server/src/auth/rate-limit.ts`). The counters live in
  `auth.rate_limit`, so they hold across api replicas.
- `NETRICS_TRUSTED_PROXIES` — proxy hops whose `X-Forwarded-For` the api
  believes when it resolves the client IP: IPs, CIDR ranges, or `loopback`,
  `linklocal`, `uniquelocal` (default: those three, the private networks the
  web app and platform proxies connect from). `none` trusts no hop. Narrow it
  when untrusted clients share a private network with the api.
- On the web app, `NETRICS_TRUSTED_PROXY_HOPS` (default `1`) is the number of
  proxies in front of it (Caddy, a platform edge). The web forwards only the
  client address that many entries from the right of `X-Forwarded-For` and
  drops every client-supplied forwarding header. Alternatively,
  `NETRICS_CLIENT_IP_HEADER` (for example `x-real-ip`) names one header in
  which the edge states the client address.

In production, the api also rejects the public development values of
`BETTER_AUTH_SECRET` and `APP_ENCRYPTION_KEY`. Session cookies have a 7-day
expiry and are validated against the database on every request, so sign-out
revokes immediately.

#### Rotating the encryption key

1. Generate a new key and set it as `APP_ENCRYPTION_KEY` on api and worker.
   Move the old key into `APP_ENCRYPTION_KEYS_PREVIOUS`.
2. Deploy. New and updated credentials use the new key, and existing ones
   still decrypt with the old key.
3. Run `node dist/admin-cli.js reencrypt-credentials` with the same key
   variables and the owner connection (`DATABASE_MIGRATION_URL`). It moves
   every envelope to the new key, is safe to re-run, and prints counts only.
4. When it reports 0 failed, remove `APP_ENCRYPTION_KEYS_PREVIOUS`.

The API is described by an OpenAPI 3.1 document generated from the zod
contracts: served at `GET /v1/openapi.json` and committed as
`packages/contracts/openapi.json`. `pnpm openapi` regenerates it, and CI fails
when the committed file is stale (`pnpm openapi:check`). Routes validate
bodies and query strings against the same schemas. Path ids are checked in
the handlers, so a malformed id answers 404 like an unknown one.

#### Service accounts and the admin API

`/v1/admin/*` (for example `GET /v1/admin/workspaces`) serves instance
administrators, starting with the account created during first-run setup, and
service accounts holding a matching scope (ADR 0009). The operator CLI in the
server image manages service tokens with the owner connection:

```sh
node dist/admin-cli.js create-service-token --name ops-console \
  --scope installation:workspaces:read --expires-days 90   # prints the token once
node dist/admin-cli.js list-tokens
node dist/admin-cli.js revoke-token --id <token id>
```

Clients send `Authorization: Bearer nt_…`. Tenant routes accept sessions
only.

Session-protected API routes live under `/v1`:

- `GET /v1/me` — current user and workspace memberships.
- `POST /v1/bootstrap` — one-time first-workspace setup (409 afterwards).
- `POST /v1/workspaces`, `GET /v1/workspaces`,
  `GET/PATCH /v1/workspaces/:id` — workspace CRUD (rename: owner/admin).
- `GET /v1/workspaces/:id/members`,
  `PATCH/DELETE /v1/workspaces/:id/members/:userId` — membership management
  (owner/admin; only owners grant or touch the owner role; any member may
  remove themselves; the last owner can never leave).
- `POST/GET /v1/workspaces/:id/invitations`,
  `DELETE /v1/workspaces/:id/invitations/:invitationId` — invitations
  (owner/admin; only owners invite owners). Inviting the same address again
  replaces the open invitation. With SMTP the link is emailed; without it the
  response carries `inviteUrl` for the admin to hand over.
- `GET /v1/invitations/:token` (public preview) and
  `POST /v1/invitations/:token/accept` (signed in). Accepting needs the token
  and an account whose email matches the invitation; it grants the role once.
  While sign-up is closed, the invited address may create its account with
  the token (header `x-netrics-invitation-token`).
- `PATCH /v1/workspaces/:id/active-project` — the caller's active project.
- `POST/GET /v1/workspaces/:id/projects`,
  `PATCH/DELETE /v1/workspaces/:id/projects/:projectId` — projects
  (create/rename: owner/admin/editor; delete: owner/admin).
- `GET /v1/workspaces/:id/audit-events` — workspace audit log (owner/admin,
  newest first, limit 100).
- `GET /v1/connectors` — the deployed connector catalog.
- `POST/GET /v1/workspaces/:id/connections`,
  `GET/PATCH/DELETE /v1/workspaces/:id/connections/:connectionId` —
  connection CRUD (create/update re-check credentials against the connector;
  create enqueues the initial backfill transactionally; delete cancels pending
  jobs).
- `POST /v1/workspaces/:id/connections/preview` — credential check + resource
  discovery without persisting.
- `POST /v1/workspaces/:id/connections/:connectionId/sync` — enqueue a manual
  sync.
- `GET /v1/workspaces/:id/connections/:connectionId/observations` — collected
  observations (any member; filterable by metric and time range).

Non-members always get 404 for workspace routes (existence is never leaked),
and every mutation writes an audit event in the same transaction. Sign-ins
additionally write an installation-level `auth.login` audit row
(`workspace_id` NULL) that tenants cannot see.

### Web app and the API proxy

The web app has email+password UI for the flows above: `/signup` and `/login`
(better-auth, auto sign-in on sign-up since verification is not enforced),
`/` (redirects to your first workspace, or creates one when you have none),
`/workspaces/:id` (projects, connections, workspace switcher),
`/workspaces/:id/connections/new` (connection creation wizard with credential
check and resource selection),
`/workspaces/:id/connections/:connectionId` (sync health, run history, latest
observations),
`/workspaces/:id/settings`
(rename, members, roles — owner/admin manage; editors/viewers read-only), and
`/settings/account` (profile, memberships, change password, sign out).
People join a workspace through invitations: `/workspaces/:id/settings`
invites by email and lists pending invitations, and `/invite/:token` lets the
invitee sign in or create their account and accept.

The browser never talks to the API directly. Route handlers in the web app
(`apps/web/src/lib/api-proxy.ts`) proxy `/api/auth/*` and `/v1/*` to the API
at request time, so
the session cookie is a plain first-party cookie on the web origin — no CORS
or cross-site cookie configuration is needed. Client-side code calls
same-origin relative URLs; server components call the API at
`NETRICS_API_URL` and forward the incoming `cookie` header verbatim (the web
app transports the cookie but never inspects it). better-auth is imported in
exactly one place, `apps/web/src/lib/auth.ts`.

Web environment variables:

- `NETRICS_API_URL` — where the web server reaches the API (default
  `http://localhost:3001`), read at request time by the proxy and by
  server-side fetches. Nothing about the API location is baked into the
  image, so one published web image works against any API.
- No `NEXT_PUBLIC_` API URL exists on purpose: the browser only ever uses
  same-origin relative URLs, so nothing API-related is inlined into the
  client bundle.

## Repository layout

```text
apps/
  web/        Next.js product application
  server/     Fastify API + job worker + scheduler (NETRICS_ROLE)
packages/
  domain/     Domain rules (role/permission matrix, pure functions)
  database/   Drizzle schema, migrations, PostgreSQL access
  contracts/  Shared zod schemas for HTTP contracts
  ui/         Shared product UI (placeholder)
docs/         Architecture, milestones, decision records
deploy/       compose/: the supported self-hosted install (Docker Compose + Caddy)
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

## Self-hosting

Install netrics on your own server with Docker Compose: see
[deploy/compose/README.md](deploy/compose/README.md) (`install.sh`, automatic
HTTPS, backups, upgrades). Releases are published as signed multi-arch
images (`linux/amd64`, `linux/arm64`) at `ghcr.io/netrics-so/{server,web}`,
tagged `X.Y.Z` and `X.Y`; see [docs/release.md](docs/release.md).

## Docker

Production images (multi-stage, `node:24-alpine`, no dev dependencies):

```sh
docker build -f apps/server/Dockerfile -t netrics-server .
docker build -f apps/web/Dockerfile -t netrics-web .
```

To run the app images together with PostgreSQL:

```sh
docker compose -f docker-compose.yml -f docker-compose.app.yml up --build
```

(Apply migrations first with `pnpm db:migrate` against the compose database.)

## CI

`.github/workflows/ci.yml` runs format check, lint, type check, unit tests,
build, a migration apply + idempotency check against a PostgreSQL service
container, and Docker image builds for server and web (amd64 and arm64).

## License

netrics is licensed under the [GNU Affero General Public License v3.0](LICENSE).
The connector SDK (`packages/connector-sdk`) is licensed under the
[Apache License 2.0](packages/connector-sdk/LICENSE). See
[CONTRIBUTING.md](CONTRIBUTING.md) for contribution status and
[SECURITY.md](SECURITY.md) for reporting vulnerabilities.
