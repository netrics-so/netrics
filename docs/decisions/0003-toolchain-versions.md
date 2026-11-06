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
- **TypeScript 6.0** — pinned to the latest 6.0.x release (6.0.3).
  typescript-eslint 8.x supports `>=4.8.4 <6.1.0`, so TypeScript 6.1+ and 7
  wait until typescript-eslint declares support. TypeScript 6 no longer
  loads every `@types/*` package by default, so `tsconfig.base.json` lists
  `"types": ["node"]` explicitly.
- **PostgreSQL 17** for local development and CI (`postgres:17-alpine`).

## Consequences

- CI and Docker images run Node 24 even where developer machines run newer
  versions.
- Upgrading TypeScript past 6.0 is blocked on typescript-eslint support.
