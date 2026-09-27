# Milestone 03 — Connector and metrics spine

## Outcome

A built-in demo connector can be configured from the UI, scheduled, executed by
a worker, and inspected as normalized observations with visible sync health.

## Dependencies

- Milestone 02

## In scope

- Initial TypeScript connector SDK and manifest schema
- Connector catalog records and workspace connection records
- Encrypted credential envelope with instance master key
- PostgreSQL-backed durable jobs
- Scheduler with single-active-instance protection
- Worker execution boundary
- `check`, `discover`, and `sync` lifecycle
- Metric definitions, observations, series identity, and sync runs
- Cursor/watermark persistence and idempotent ingestion
- Retry classification and dead-letter visibility
- Connection creation wizard and health UI
- Deterministic demo connector and onboarding sample data
- Connector fixture and contract-test harness

## Out of scope

- External provider APIs
- OAuth authorization-code flow
- Derived metrics and alerts
- Community package distribution
- Arbitrary plugin installation

## Implementation slices

1. Define connector DTOs and version negotiation.
2. Add connector catalog and connection persistence.
3. Implement encryption key loading, rotation metadata, and secret redaction.
4. Add durable jobs, scheduler claims, retries, and worker heartbeats.
5. Add metric definitions, observations, dimensions, and idempotency keys.
6. Implement demo connector discovery, backfill, incremental sync, and failures.
7. Build the connection wizard and sync-health views.
8. Add contract fixtures that run without network access.

## Data invariants

- A connection belongs to one workspace and may have an optional project.
- Connector code cannot access database or queue handles.
- Every job carries explicit workspace and connection identity.
- Repeating a successful sync produces no duplicate observations.
- Cursor advancement occurs only with committed observations.
- Logs and error messages never contain credentials.

## Verification

- Scheduling the same connection concurrently still serializes cursor updates.
- Retrying after a simulated crash remains idempotent.
- Bad credentials and provider outages produce different actionable states.
- Backfill and current sync can overlap safely.
- Cross-workspace job payload tampering is rejected.

## Exit gate

Create a demo connection in the UI, observe its backfill and incremental sync,
inspect health and retry information, and verify stable observation counts after
replaying every job.

## Completion

- Completed: 2026-09-27
- Release: none (pre-0.2.0; shipped via squash merges)
- Pull requests:
  [#15](https://github.com/netrics-so/netrics/pull/15),
  [#16](https://github.com/netrics-so/netrics/pull/16),
  [#17](https://github.com/netrics-so/netrics/pull/17),
  [#18](https://github.com/netrics-so/netrics/pull/18),
  [#19](https://github.com/netrics-so/netrics/pull/19),
  [#20](https://github.com/netrics-so/netrics/pull/20) (adversarial
  verification + exit gate; number expected — fix here if it differs)
- Exit gate: run locally against the built server (api + worker + scheduler
  processes) and web app with real PostgreSQL — demo connection created through
  the web origin (cookie jar), backfill completed with 364 observations,
  scheduler-driven incremental sync observed (0 new, idempotent), health and
  sync-run history inspected via the connections/observations endpoints, then
  every succeeded job replayed through the real worker with observation counts
  unchanged (364 before and after). Test suite: 243 tests green, including the
  adversarial verification suite
  (`apps/server/src/sync/verification.test.ts`).
- Material deviations: pending jobs are cancelled (`status=failed`,
  `last_error='connection deleted'`) rather than deleted on connection delete —
  the app role has no DELETE grant on `jobs`; the resource selection chosen at
  creation time is stored under the reserved `resourceSelection` config key
  (stripped from API responses; PATCH carries it over); the scheduler skips
  `auth_failed` connections until credentials are updated through the API
  (credential repair resets the state and makes the connection due
  immediately).
