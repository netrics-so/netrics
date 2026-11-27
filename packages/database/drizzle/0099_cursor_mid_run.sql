-- #928: tell a resumed page from the first page of a run.
--
-- A sync run checkpoints its cursor with every page before the last. When
-- the run then fails or its worker dies, the next attempt starts from that
-- checkpoint, a page of a run that has not finished: a skipped result
-- (SDK 0.2.23, "nothing to do this run") there would end the run over a
-- window no page finished. The sync engine sets cursor_mid_run with every
-- such checkpoint and clears it when a run succeeds.
ALTER TABLE "connection_state" ADD COLUMN "cursor_mid_run" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- A checkpoint stored before this migration: the connection's latest run
-- failed or was continued after committing pages, and the cursor is still
-- the checkpoint it left (cursor_after is set only when pages committed).
-- A run that succeeded since stored its own final cursor instead.
UPDATE "connection_state" AS state
SET "cursor_mid_run" = true
WHERE state."cursor" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM (
      SELECT run."status", run."cursor_after"
      FROM "sync_runs" AS run
      WHERE run."connection_id" = state."connection_id"
        AND run."workspace_id" = state."workspace_id"
      ORDER BY run."started_at" DESC, run."finished_at" DESC
      LIMIT 1
    ) AS latest
    WHERE latest."status" IN ('failed', 'continued')
      AND latest."cursor_after" = state."cursor"
  );
