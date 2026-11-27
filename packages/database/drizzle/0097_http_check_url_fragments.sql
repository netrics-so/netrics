-- #898: HTTP check URLs no longer take a fragment (the part after '#'),
-- which never reaches the site and can carry a token. Before, a saved URL
-- kept its fragment and only the probe dropped it; the check now refuses
-- one, so a stored fragment would fail the whole connection. Strip it from
-- every stored check URL of an http-check connection, in place and in
-- order; everything else in the configuration stays. The configuration is
-- the only stored copy (audit events name changed fields, not values).
-- Idempotent: a second run finds no '#'.
UPDATE "connections" c
SET "config" = jsonb_set(
  c."config",
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
    FROM jsonb_array_elements(c."config" -> 'checks')
      WITH ORDINALITY AS checks(item, position)
  )
)
-- CASE, not AND: PostgreSQL may evaluate AND operands in any order, and
-- jsonb_array_elements fails on a value that is not an array.
WHERE c."connector_id" = 'http-check'
  AND CASE
    WHEN jsonb_typeof(c."config" -> 'checks') = 'array' THEN EXISTS (
      SELECT 1
      FROM jsonb_array_elements(c."config" -> 'checks') item
      WHERE jsonb_typeof(item) = 'object'
        AND jsonb_typeof(item -> 'url') = 'string'
        AND strpos(item ->> 'url', '#') > 0
    )
    ELSE false
  END;
