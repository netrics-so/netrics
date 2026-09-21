# 0001 — Database tooling: Drizzle ORM + drizzle-kit

Status: accepted (milestone 00)

## Context

The architecture requires PostgreSQL as the only mandatory stateful dependency,
with row-level security as a defense-in-depth boundary. Migration tooling must
support first-class raw SQL (RLS policies, `FORCE ROW LEVEL SECURITY`, custom
roles) while day-to-day queries benefit from a typed schema layer.

## Decision

Use **Drizzle ORM** (`drizzle-orm` with the `postgres` driver) for typed schema
definitions and queries, and **drizzle-kit** for migration generation and
application (`pnpm db:migrate`). Migrations are plain SQL files committed under
`packages/database/drizzle/`, so RLS policies and other raw DDL can be added
directly when tenant tables arrive.

`packages/database` owns the schema, the drizzle-kit config, and the migration
commands. Milestone 00 ships only an initial metadata migration (`schema_info`
table).

## Alternatives considered

- **Prisma** — migrations hide SQL behind an engine; RLS and custom roles are
  awkward to express.
- **node-pg-migrate / raw SQL only** — full control, but loses the typed query
  layer shared across api/worker/scheduler.

## Consequences

- Migration files are authoritative SQL; review them like hand-written DDL.
- `drizzle-kit generate` diffs `packages/database/src/schema.ts` into SQL;
  hand-edits for RLS live alongside generated statements.
