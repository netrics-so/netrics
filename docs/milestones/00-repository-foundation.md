# Milestone 00 — Repository foundation

## Outcome

A new contributor can clone the public repository, run one documented command,
and see a web page communicating with a healthy API backed by PostgreSQL.

## Why this comes first

Every later milestone needs the same module boundaries, tooling, configuration,
database migration path, and local development experience. This milestone proves
those foundations without mixing in product behavior.

## In scope

- pnpm workspace with the agreed public monorepo layout
- `apps/web`, `apps/server`, and `apps/renderer` skeletons
- `packages/domain`, `database`, `contracts`, and `ui`
- TypeScript project references and shared compiler configuration
- Formatting, linting, type checking, and test runners
- Fastify API with `/health/live` and `/health/ready`
- Next.js page that displays API readiness
- PostgreSQL in local Docker Compose
- Database migration command and an initial metadata migration
- Runtime environment validation with useful startup errors
- Structured logs with request IDs and process role
- Dockerfiles for web, server, and renderer
- Public contributor setup documentation

## Out of scope

- Authentication and workspace data
- Railway or production deployment
- Connector, metric, dashboard, or device tables
- Design-system polish
- Redis, TimescaleDB, and Kubernetes

## Implementation slices

1. Create the workspace, package boundaries, and shared configuration.
2. Add server startup, environment validation, and health endpoints.
3. Add PostgreSQL, migration tooling, and readiness checking.
4. Add the web shell and a generated or typed API client for the health call.
5. Add production Docker builds and local Compose wiring.
6. Add CI for format, lint, type check, tests, migrations, and image builds.
7. Document local setup, common commands, and failure recovery.

## Required decisions

- Select the SQL query and migration tooling.
- Choose the runtime schema library used by HTTP and connector contracts.
- Define the supported local Node.js and pnpm versions.

Record these choices before product tables depend on them.

## Verification

- A clean clone starts successfully using the documented command.
- Readiness fails when PostgreSQL is unavailable and recovers when it returns.
- Migrations apply to an empty database and are idempotent on a second run.
- Production images start without development dependencies.
- CI passes on macOS development output and Linux containers.

## Exit gate

Open the local web application, see a healthy API/database status, stop
PostgreSQL and observe readiness fail, restore it, and observe recovery without
rebuilding the application.
