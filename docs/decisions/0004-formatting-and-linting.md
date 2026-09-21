# 0004 — Formatting and linting: Prettier + ESLint (flat config)

Status: accepted (milestone 00)

## Context

The monorepo needs consistent formatting and linting with minimal config drift
across packages.

## Decision

- **Prettier** for formatting (defaults only, no custom rules), driven by root
  scripts `pnpm format` / `pnpm format:check`.
- **ESLint** with a single root flat config (`eslint.config.mjs`) using
  `@eslint/js` recommended + `typescript-eslint` recommended. One config at
  the root covers all apps and packages.
- **Vitest** for unit tests, run from the root (`pnpm test`).

## Alternatives considered

- **Biome** (formatter + linter in one tool) — attractive for speed, but
  ESLint + typescript-eslint remains the better-supported combination for
  Next.js/Fastify ecosystems; can be revisited without code changes.

## Consequences

- Formatting never appears in ESLint; the two tools do not overlap.
- New packages need no lint configuration of their own.
