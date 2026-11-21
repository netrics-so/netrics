// The per-stream record summary of a custom API sync (#834 review): the
// connector reports skipped records on runtime.log, with the fields that
// skipped them by path; the host keeps the last sync's summary per stream
// (custom_api_stream_records) for the connection page. Paths and counts
// only, never values.

/** The log message of a page's skipped records. */
export const CUSTOM_API_SKIPPED_LOG = "records skipped";

/** Field paths kept per stream (and logged per page), most frequent first. */
export const CUSTOM_API_SKIPPED_FIELDS = 5;

/**
 * The log fields of one page's skipped records: `skipped`, then
 * `field<N>`/`count<N>` pairs (N from 1), most frequent first.
 */
export function skippedLogFields(
  skipped: number,
  byPath: ReadonlyMap<string, number>,
): Record<string, string | number> {
  const fields: Record<string, string | number> = { skipped };
  [...byPath]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, CUSTOM_API_SKIPPED_FIELDS)
    .forEach(([path, count], index) => {
      fields[`field${index + 1}`] = path;
      fields[`count${index + 1}`] = count;
    });
  return fields;
}

/** Reads skippedLogFields back: the skipped count and field counts by path. */
export function readSkippedLogFields(
  fields: Readonly<Record<string, unknown>>,
): { skipped: number; byPath: Map<string, number> } | null {
  const skipped = fields.skipped;
  if (typeof skipped !== "number" || !Number.isInteger(skipped) || skipped < 0)
    return null;
  const byPath = new Map<string, number>();
  for (let n = 1; n <= CUSTOM_API_SKIPPED_FIELDS; n++) {
    const path = fields[`field${n}`];
    const count = fields[`count${n}`];
    if (
      typeof path === "string" &&
      typeof count === "number" &&
      Number.isInteger(count) &&
      count > 0
    )
      byPath.set(path, count);
  }
  return { skipped, byPath };
}
