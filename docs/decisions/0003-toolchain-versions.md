# 0003 — Toolchain versions: Node.js 26 LTS, pnpm 10

Status: accepted (milestone 00); Node.js moved from 24 to 26 in #502

## Context

The architecture requires the current active Node.js LTS at implementation
time, with all production toolchain versions pinned.

## Decision

- **Node.js 26** is the supported runtime. The root `package.json` declares
  `engines: { "node": ">=26" }` (permissive range so newer local installs keep
  working), `.nvmrc` pins `26`, CI uses `node-version: 26`, and Docker base
  images use `node:26-alpine` pinned by its multi-arch index digest.
- **pnpm 10.34.5** is the package manager, pinned via
  `packageManager: "pnpm@10.34.5"`. CI activates exactly this with
  `pnpm/action-setup`. Node 25+ no longer bundles corepack, so the Docker
  images install the same version with `npm install -g pnpm@10.34.5`, and a
  pnpm bump changes `packageManager` and both Dockerfiles together.
- **TypeScript 6.0** — pinned to the latest 6.0.x release (6.0.3).
  typescript-eslint 8.x supports `>=4.8.4 <6.1.0`, so TypeScript 6.1+ and 7
  wait until typescript-eslint declares support. TypeScript 6 no longer
  loads every `@types/*` package by default, so `tsconfig.base.json` lists
  `"types": ["node"]` explicitly. `@types/node` follows the runtime's major
  version (26.x).
- **PostgreSQL 17** for local development and CI (`postgres:17-alpine`).

## Consequences

- CI and Docker images run Node 26 even where developer machines run newer
  versions.
- Upgrading TypeScript past 6.0 is blocked on typescript-eslint support.
- Moving to the next LTS line is a deliberate change (Dependabot ignores
  Node major versions): `.nvmrc`, `engines`, CI `node-version`, the Docker
  base images and `@types/node` move together, and this ADR records it.

## History

- 2026-11: Node.js 24 → 26 (#502). Node 26 became the active LTS and Node 24
  moved to maintenance.
