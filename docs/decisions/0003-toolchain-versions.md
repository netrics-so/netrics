# 0003 — Toolchain versions: Node.js 24 LTS, pnpm 10

Status: accepted (milestone 00)

## Context

The architecture requires the current active Node.js LTS at implementation
time, with all production toolchain versions pinned.

## Decision

- **Node.js 24** is the supported runtime. The root `package.json` declares
  `engines: { "node": ">=24" }` (permissive range so newer local installs keep
  working), `.nvmrc` pins `24`, and Docker base images use `node:24-alpine`.
- **pnpm 10.34.5** is the package manager, pinned via
  `packageManager: "pnpm@10.34.5"` (corepack/CI activate exactly this).
- **TypeScript 5.9** — pinned to the latest 5.x release because
  typescript-eslint does not yet support TypeScript 6+/7. Revisit once
  typescript-eslint declares support.
- **PostgreSQL 17** for local development and CI (`postgres:17-alpine`).

## Consequences

- CI and Docker images run Node 24 even where developer machines run newer
  versions.
- Upgrading TypeScript past 5.x is blocked on typescript-eslint support.
