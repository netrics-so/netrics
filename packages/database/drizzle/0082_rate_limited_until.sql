-- #781: a provider rate limit with a known reset is no failure. The sync
-- engine records it in connection_state.rate_limited_until (no job of the
-- connection runs before it) and as error class rate_limited on the run,
-- instead of a transient failure that marked the connection as an outage.
-- Additive: existing rows keep their state, and a connection that shows an
-- outage from earlier rate limits recovers with its next successful run.
-- Every sync writes connection_state and sync_runs: a lock not granted
-- within 5 s fails the migration (to be re-run) instead of queueing those
-- writes behind a long-running transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "connection_state" ADD COLUMN "rate_limited_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_error_class_valid";--> statement-breakpoint
-- Added without checking the existing rows, then validated: the rows met the
-- narrower check already. (Dropping the old check takes the table lock for
-- the rest of the migration's transaction either way; sync_runs is pruned by
-- the history retention, so the check is short.)
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_error_class_valid" CHECK ("sync_runs"."error_class" in ('auth', 'transient', 'contract', 'budget', 'rate_limited')) NOT VALID;--> statement-breakpoint
ALTER TABLE "sync_runs" VALIDATE CONSTRAINT "sync_runs_error_class_valid";
