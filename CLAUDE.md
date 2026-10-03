# Working on netrics

Orientation for contributors and coding agents. Product and architecture live
in `docs/`; this file is how to work in the repository.

## Where things are

- Plan: `docs/milestones/README.md` (sequence and current status), and GitHub
  milestones and issues, which are the source of truth for open work. The
  project board is "netrics roadmap".
- Decisions: `docs/decisions/` (ADRs). Record a new one when a choice is
  hard to reverse (schema identity, auth model, SDK contract).
- API contract: `packages/contracts` (zod) and the generated
  `packages/contracts/openapi.json`.
- Self-hosting: `deploy/compose/` (install, upgrade, backup).
- Releases: `docs/release.md`. Every `main` commit is built, signed and
  deployed; a `vX.Y.Z` tag on a `main` commit promotes those images to a
  version for self-hosters (no rebuild). Actions are pinned by SHA.
- Hosted-service infrastructure lives in private repositories (release and env
  as code, DNS as code). Never put production details in this public repo.

## Local setup

```sh
pnpm setup          # install, start Postgres (docker), build, migrate
pnpm dev            # web :3000 + api :3001
```

Tests need a PostgreSQL server they can create databases on:
`NETRICS_TEST_ADMIN_URL=postgres://netrics:netrics@localhost:5433/postgres pnpm test`
(`pnpm db:up` starts one on 5433).

## Definition of done for a change

1. Branch from `main`; one issue per PR, with `Closes #N` in the body.
2. `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, and
   `pnpm openapi:check` when routes or contracts change (`pnpm openapi`
   regenerates).
3. Tests prove the behaviour. For fixes, include a test that fails on the old
   code. Timing-sensitive suites should pass repeated runs.
4. Schema changes: a drizzle migration (`pnpm db:generate`; hand-edit when
   the generated order is unsafe), tried on data in the previous shape.
   Migrations only move forward, and production data must survive them.
5. Check behaviour where it runs: a real browser for UI flows, built images
   for deploy changes.
6. Squash-merge after CI is green (`check`, `docker`, `migrations`,
   `selfhost`). A merge to `main` publishes images and deploys the hosted
   service; confirm the new commit on `/health/live`.

## Invariants that must hold

- Tenant isolation is enforced twice: RLS under the unprivileged
  `netrics_app` role, and explicit `workspace_id` predicates in queries. The
  server refuses to start as a superuser or BYPASSRLS role.
- Secrets never appear in logs, errors, API responses or the repository.
  Credentials are AES-GCM envelopes bound to their connection.
- Connector code only reaches the network through `runtime.fetch`
  (allowlisted egress). Contract tests run offline.
- One source, same commit: nothing environment-specific at build time.
  Self-hosters run the signed images. The hosted service runs the same server
  image and builds the web frontend on Vercel from the same commit and
  lockfile, with configuration read at request time (ADR 0013; a CI build
  guard checks the web build).
- Packages depend inward only (`PACKAGE_LAYERS` in `eslint.config.mjs`, enforced
  by lint): `domain` imports nothing, and apps compose the concrete connectors.
- Pin dependencies exactly, and avoid releases younger than a few days.
