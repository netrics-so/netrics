-- #921: no HTTP check URL keeps a fragment across a rollout.
--
-- Migration 0097 stripped stored fragments, but migrations run before the
-- new API is deployed (docs/release.md): an API of the previous release,
-- which still accepts a fragment, can save one after 0097 ran. The stored
-- configuration is what the connection shows and what each run reads, so
-- it has to be clean, not only the probe. A second cleanup on the next
-- deploy would have the same gap for an installation that skips releases;
-- instead the database strips fragments on every write of an http-check
-- connection, whichever API version writes it, and this migration cleans
-- what was saved since 0097. The current API refuses a fragment before it
-- saves, so for it the trigger changes nothing.
CREATE OR REPLACE FUNCTION strip_http_check_url_fragments(config jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  -- As 0097: every check URL loses the part from its first '#', in place
  -- and in order; everything else in the configuration stays. CASE, not
  -- AND: jsonb_array_elements fails on a value that is not an array.
  SELECT CASE
    WHEN jsonb_typeof(config -> 'checks') = 'array'
      AND jsonb_array_length(config -> 'checks') > 0
    THEN jsonb_set(
      config,
      '{checks}',
      (
        SELECT jsonb_agg(
          CASE
            WHEN jsonb_typeof(item) = 'object'
              AND jsonb_typeof(item -> 'url') = 'string'
              AND strpos(item ->> 'url', '#') > 0
            THEN jsonb_set(
              item,
              '{url}',
              to_jsonb(split_part(item ->> 'url', '#', 1))
            )
            ELSE item
          END
          ORDER BY position
        )
        FROM jsonb_array_elements(config -> 'checks')
          WITH ORDINALITY AS checks(item, position)
      )
    )
    ELSE config
  END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_http_check_url_fragments()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.connector_id = 'http-check' THEN
    NEW.config := strip_http_check_url_fragments(NEW.config);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "connections_strip_http_check_url_fragments" ON "connections";
--> statement-breakpoint
CREATE TRIGGER "connections_strip_http_check_url_fragments"
  BEFORE INSERT OR UPDATE OF "config", "connector_id" ON "connections"
  FOR EACH ROW EXECUTE FUNCTION guard_http_check_url_fragments();
--> statement-breakpoint
-- What an API of the previous release saved since 0097. Idempotent: a
-- second run finds nothing to change.
UPDATE "connections"
SET "config" = strip_http_check_url_fragments("config")
WHERE "connector_id" = 'http-check'
  AND "config" IS DISTINCT FROM strip_http_check_url_fragments("config");
