-- #828: one test request per builder draft across API processes. A test
-- takes a lease in connection_state.custom_api_test_until (the draft's
-- state row) and clears it when it ends; a second test of the same draft
-- is refused while the lease runs. A lease left by a process that died
-- mid-test simply expires. Additive: a nullable column, no rewrite, and
-- existing rows read as "no test running".
-- Every sync writes connection_state: a lock not granted within 5 s fails
-- the migration (to be re-run) instead of queueing those writes behind a
-- long-running transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "connection_state" ADD COLUMN "custom_api_test_until" timestamp with time zone;--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
