-- #165: Search Console stored position = 0 and ctr = 0 on days without
-- impressions. Neither is defined there (position 0 reads as better than rank
-- 1), and the connector no longer writes them. Remove the stored ones: a
-- position or ctr observation goes when the same connection, series (the
-- property's `resource` dimension) and day has an impressions observation of
-- 0, or has none and the value is 0. A day with impressions keeps its values,
-- and a nonzero value without an impressions row is left alone rather than
-- guessed at. clicks, impressions and position_sum (0 on such days) stay: sums
-- and impression-weighted averages stay correct with them.
-- Idempotent: a second run finds nothing. The migration role owns the table,
-- and observations does not force row level security.
DELETE FROM "observations" o
USING "metric_definitions" m
WHERE m."id" = o."metric_definition_id"
  AND m."connector_id" = 'google-search-console'
  AND m."key" IN ('google-search-console.position', 'google-search-console.ctr')
  AND NOT EXISTS (
    SELECT 1
    FROM "observations" i
    JOIN "metric_definitions" im ON im."id" = i."metric_definition_id"
    WHERE im."connector_id" = 'google-search-console'
      AND im."key" = 'google-search-console.impressions'
      AND i."connection_id" = o."connection_id"
      AND i."series_key" = o."series_key"
      AND i."source_timestamp" = o."source_timestamp"
      AND i."value" > 0
  )
  AND (
    o."value" = 0
    OR EXISTS (
      SELECT 1
      FROM "observations" i
      JOIN "metric_definitions" im ON im."id" = i."metric_definition_id"
      WHERE im."connector_id" = 'google-search-console'
        AND im."key" = 'google-search-console.impressions'
        AND i."connection_id" = o."connection_id"
        AND i."series_key" = o."series_key"
        AND i."source_timestamp" = o."source_timestamp"
    )
  );
