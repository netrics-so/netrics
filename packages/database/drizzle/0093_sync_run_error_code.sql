-- #795: a failed sync run gets a stable reason code next to its English
-- message (such as "apple_ads.invalid_client"), which clients translate by;
-- until now they matched the message's exact English text. Additive and
-- forward-only: the column is null for every existing row, which keeps its
-- message and is shown as before. A code is a fixed word (lowercase words
-- joined by "_" or "."), never provider text.
-- Every sync writes sync_runs: a lock not granted within 5 s fails the
-- migration (to be re-run) instead of queueing those writes behind a
-- long-running transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "error_code" text;--> statement-breakpoint
-- Added without checking the existing rows, then validated: they are all
-- null. (sync_runs is pruned by the history retention, so the check is
-- short.)
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_error_code_valid" CHECK ("sync_runs"."error_code" ~ '^[a-z0-9]+([._][a-z0-9]+)*$' and length("sync_runs"."error_code") <= 64) NOT VALID;--> statement-breakpoint
ALTER TABLE "sync_runs" VALIDATE CONSTRAINT "sync_runs_error_code_valid";--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
