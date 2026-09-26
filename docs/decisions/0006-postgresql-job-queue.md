# 0006 — Job queue: hand-rolled PostgreSQL table with SKIP LOCKED claiming

Status: accepted (milestone 03)

## Context

The architecture requires durable jobs for synchronization, backfills,
maintenance, and notifications, with four hard constraints:

- **Transactional enqueue.** A domain write (e.g. creating a connection,
  committing observations) and the job that processes it must commit in the
  same transaction. Anything less opens a window where the domain row exists
  but the job was lost (or vice versa).
- **RLS integration.** Jobs carry `workspace_id`; the application role must
  only ever see and enqueue jobs for the current tenant context, while a
  separate scheduler role claims across all tenants.
- **Per-connection serialization.** Provider cursors break if two syncs for
  the same connection overlap; claiming must support serial execution per
  connection.
- **At-least-once execution with idempotent handlers.** Workers can crash
  mid-job; retries must be safe.

PostgreSQL is already the only mandatory stateful dependency (ADR 0001), so
the question is which PostgreSQL-backed queue to adopt.

## Decision

Implement the queue ourselves as a single durable `jobs` table, claimed with
`SELECT ... FOR UPDATE SKIP LOCKED`:

- Enqueue is a plain `INSERT INTO jobs ...` inside the caller's tenant
  transaction — transactional enqueue falls out of the data model, no outbox
  relay needed.
- `run_at` + `status` drive scheduling; a partial index on
  `(status, run_at) WHERE status = 'pending'` keeps claiming cheap.
- Claiming sets `status = 'running'`, `locked_by`, `locked_at`; a lock
  visibility timeout (jobs stuck in `running` past the timeout are reclaimable)
  covers worker crashes. Retry uses exponential backoff via `run_at`;
  `max_attempts` moves a job to `dead` for dead-letter visibility.
- RLS gives each role exactly its surface: `netrics_app` sees/enqueues/retries
  only its own workspace's jobs (enqueue happens inside tenant transactions),
  and a scheduler policy (`current_user = 'netrics_scheduler'`) grants
  cross-tenant SELECT/UPDATE for claiming. This composes with the existing
  tenant-context machinery unchanged.
- `idempotency_key` (unique, nullable) lets enqueuers suppress duplicates for
  scheduled recurring jobs.

## Alternatives considered

- **pg-boss** — feature-complete, but it owns its own schema, functions, and
  maintenance jobs, and its transactional-enqueue story requires writing to
  its raw internal table (unsupported and version-fragile). It also has no
  notion of our RLS tenant context, so cross-tenant visibility would need a
  parallel enforcement layer.
- **graphile-worker** — solid and closer to our model (plain table, supports
  `FOR UPDATE SKIP LOCKED` claiming), but still brings its own schema,
  migrations, and worker lifecycle to embed, and its local-tx enqueue API is a
  side channel rather than the primary path. A heavier dependency for
  requirements we fully control.

## Consequences

- We own correctness for the sharp edges: claim visibility timeouts, retry
  backoff, dead-letter handling, and per-connection serialization. The surface
  is deliberately tiny (one table, one claim query) and must be heavily
  tested.
- Workers and the scheduler must run handlers idempotently; the database gives
  at-least-once, not exactly-once.
- Throughput is bounded by a single-table queue; if a later milestone needs
  high-volume job classes, partitioning or a dedicated queue can be introduced
  behind the same enqueue/claim interface.
