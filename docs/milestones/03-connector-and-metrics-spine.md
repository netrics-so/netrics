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
