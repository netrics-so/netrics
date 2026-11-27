-- #928: tell a resumed page from the first page of a run.
--
-- A sync run checkpoints its cursor with every page before the last. When
-- the run then fails or its worker dies, the next attempt starts from that
-- checkpoint, a page of a run that has not finished: a skipped result
-- (SDK 0.2.23, "nothing to do this run") there would end the run over a
-- window no page finished. The sync engine sets cursor_mid_run with every
-- such checkpoint and clears it when a run succeeds.
--
-- The marker is accurate from the first run by a worker of this release.
-- Migrations run before the workers are replaced (docs/release.md): a
-- checkpoint an old worker writes during that replacement is not marked.
ALTER TABLE "connection_state" ADD COLUMN "cursor_mid_run" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- A cursor stored before this migration, conservatively: it is a finished
-- run's only when the connection's latest succeeded run stored it as its
-- final cursor (a succeeded run writes the same value to its cursor_after
-- and to connection_state.cursor). Any other cursor is a checkpoint, for
-- example of a run whose retries failed before a page, or of a worker that
-- died after a page and recorded no run.
UPDATE "connection_state" AS state
SET "cursor_mid_run" = true
WHERE state."cursor" IS NOT NULL
  AND state."cursor" IS DISTINCT FROM (
    SELECT run."cursor_after"
    FROM "sync_runs" AS run
    WHERE run."connection_id" = state."connection_id"
      AND run."workspace_id" = state."workspace_id"
      AND run."status" = 'succeeded'
    ORDER BY run."started_at" DESC, run."finished_at" DESC
    LIMIT 1
  );
