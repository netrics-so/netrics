-- #758: the cursor is opaque to the host. Until now an incremental sync
-- started its window at a stored cursor that Date.parse read as a date, and
-- a done result without a cursor stored the window's end as one. The next
-- window start now has its own column, written by the sync engine from a
-- done result's nextFrom (or the window's end), and the cursor is only ever
-- handed back to the connector.
-- Every sync writes connection_state: a lock not granted within 5 s fails the
-- migration (to be re-run) instead of queueing those writes behind a
-- long-running transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "connection_state" ADD COLUMN "next_from" timestamp with time zone;--> statement-breakpoint
-- Rows written by the old engine keep their next window: a cursor that is an
-- ISO 8601 instant (every date-like cursor the host or a connector wrote:
-- toISOString, or a bare UTC date) becomes next_from, so no connection
-- re-reads its history or skips days after the upgrade. The cursor itself
-- stays as it is for the connector. Any other cursor (or none) leaves
-- next_from empty and the last success stands in, as before. A value that
-- matches the shape but is no real instant is left alone, row by row.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT "connection_id", "cursor" FROM "connection_state"
    WHERE "cursor" ~ '^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2}))?$'
  LOOP
    BEGIN
      UPDATE "connection_state"
      SET "next_from" = CASE
        WHEN position('T' in r."cursor") > 0 THEN r."cursor"::timestamptz
        ELSE r."cursor"::date::timestamp AT TIME ZONE 'UTC'
      END
      WHERE "connection_id" = r."connection_id";
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
      NULL;
    END;
  END LOOP;
END $$;--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
