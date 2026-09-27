# Milestone 03 — implementation status (working document)

> Scratch status for an in-flight milestone. Delete this file when milestone 03
> is marked complete. Last updated: 2026-09-27 (slice 5 complete).

## Done (stacked PRs, in merge order; each CI-green on its branch)

| Slice | Branch                         | PR      | Content                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----- | ------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `m03/01-connector-sdk`         | #15     | `@netrics/connector-sdk` (manifest/transport zod schemas, `Connector` interface, SDK_VERSION + semver-range check), contract fixture harness (`runConnectorContractTests`), deterministic demo connector in `@netrics/connectors`                                                                                                                                                                           |
| 2     | `m03/02-data-model`            | #16     | ADR 0006 (hand-rolled SKIP LOCKED job queue); tables: connectors, metric_definitions, connections (encrypted creds), connection_state, observations (UNIQUE(connection_id, source_identity)), sync_runs, jobs; RLS + 3-role grant matrix (scheduler cannot read credentials); `apps/server/src/credentials.ts` (AES-256-GCM envelope, `APP_ENCRYPTION_KEY`); race fix in migration 0001 (23505 on pg_roles) |
| 3     | `m03/03-jobs-scheduler-worker` | #17     | Migration 0006 (claim_jobs / enqueue_sync_job SECURITY DEFINER functions, worker_heartbeats); queue module in `@netrics/database`; worker process (dual pools, handler registry, graceful shutdown); scheduler process (advisory-lock single instance, idempotent hourly enqueue, skips auth_failed); role-scoped env requirements                                                                          |
| 4     | `m03/04-sync-engine`           | #18     | `@netrics/connector-runtime` (registry, executeCheck/executeSync/executeDiscover boundary, capability-leak guard, credential redaction); sync engine (auth → paginated sync in ONE tenant tx = ingest + cursor atomically); failure matrix (auth=terminal, outage=retryable, contract=dead); catalog upsert at startup                                                                                      |
| 5     | `m03/05-connections-ui`        | pending | Connections API (catalog, create with check + transactional backfill enqueue, preview, detail, PATCH credential recovery, DELETE with job cancellation, manual sync, observations query); config-schema validator; domain `connections:*` actions; web UI: connections section, creation wizard, detail page. 236 tests green; full-stack smoke verified                                                    |
| 6     | —                              | —       | Not started: adversarial verification (concurrent scheduling, crash-retry, tampering), exit gate run, completion record                                                                                                                                                                                                                                                                                     |

## How to continue

1. Open slice 5's PR stacked on #18 (base `m03/04-sync-engine`).
2. Slice 6 on a new branch `m03/06-verification` stacked on slice 5:
   adversarial tests (the milestone's Verification section), exit-gate run,
   completion block in `03-connector-and-metrics-spine.md`, delete this file.
3. Merge the stack in order (#15 → slice 6), rebasing each onto main after
   each squash merge (`git rebase main --update-refs` from the topmost branch,
   force-push). Do NOT delete a base branch before retargeting its child PR to
   main — GitHub auto-closed PR #6 that way once.
4. Merging to main triggers the production release pipeline (public release →
   dispatch → netrics-cloud deploy → smoke → manifest). Expect a Railway
   redeploy per merge; verify `https://netrics-api.up.railway.app/health/live`.

## Key invariants (do not regress)

- Cursor advance and observation ingest commit in ONE transaction.
- Observations idempotent via UNIQUE(connection_id, source_identity) +
  ON CONFLICT DO NOTHING.
- Scheduler role can never read `connections` (credentials).
- Connector code receives only `{ connectionId, config, credentials }` — no
  db/queue handles (enforced structurally in connector-runtime).
- Every job carries explicit workspace_id + connection_id; the worker
  dead-letters payload/row mismatches.
- Job enqueue for a domain write happens in the same transaction.

## Environment quirks

- Local test runs need a Postgres — port 5433 is occupied by another project;
  use a throwaway container:
  `docker run -d --name netrics-tmp-pg -e POSTGRES_USER=netrics -e POSTGRES_PASSWORD=netrics -e POSTGRES_DB=postgres -p 5499:5432 postgres:17-alpine`
  and `NETRICS_TEST_ADMIN_URL=postgres://netrics:netrics@localhost:5499/postgres pnpm test`.
  The repo's own `netrics-postgres-1` volume may have stale credentials —
  recreate with `docker compose down -v && pnpm db:up` when convenient
  (destroys dev data).
- Release pipeline: web image bakes `NETRICS_API_URL` at build time from the
  `NETRICS_WEB_API_URL` repo variable (set to `http://api.railway.internal:3001`).
- Production hardening follow-up (noted in milestone 01 completion): Railway
  API service still connects as the provider DB role, not `netrics_app`; the
  migration creates roles with dev passwords on any cluster.
