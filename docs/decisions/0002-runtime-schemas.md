# 0002 — Runtime schema library: zod

Status: accepted (milestone 00)

## Context

Contracts must be JSON-compatible and shared between the API and its clients,
and a future language-neutral connector runner should be able to consume the
same shapes. Environment configuration needs validated parsing with clear
startup errors.

## Decision

Use **zod** (v4) as the single runtime schema library:

- `packages/contracts` holds shared zod schemas (starting with the health
  endpoints) consumed by both `apps/server` (validates outgoing payloads) and
  the web app's typed API client (validates incoming payloads).
- `apps/server` validates its environment with zod at startup and exits with a
  readable list of problems on failure.

Route-level schema integration (`fastify-type-provider-zod`, OpenAPI
generation) is deferred until the API surface grows; for milestone 00 the
contracts package is the source of truth and responses are parsed with zod
before sending.

## Alternatives considered

- **TypeBox / JSON Schema first** — natural for Fastify and OpenAPI, but a
  second schema style for env/config; zod keeps one idiom everywhere.
- **valibot / arktype** — smaller or faster, but a smaller ecosystem for
  OpenAPI tooling later.

## Consequences

- One schema idiom across env validation, HTTP contracts, and (later)
  connector manifests.
- OpenAPI generation, when needed, builds on the existing zod schemas (e.g.
  via fastify-type-provider-zod) without re-authoring contracts.
