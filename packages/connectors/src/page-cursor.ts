/**
 * Page cursors that carry where their run started reading (#765):
 * "<position>|<run start>", both instants.
 *
 * A connector that re-reads recent days returns the start of that lookback
 * as the next window's start, never later than where the run started
 * reading. A run can span several pages and several attempts: a page's
 * checkpoint may come back in a later run (after a failure), so the start is
 * part of the cursor rather than derived from the page at hand. A page that
 * begins inside the lookback days would otherwise drop the days before it,
 * which an earlier page read before they were final.
 *
 * A bare instant is a cursor without a run start: the cursor of a finished
 * run, or a page cursor written before #765. The run then starts at this
 * page.
 */
export function pageCursor(atMs: number, runStartMs: number): string {
  return `${new Date(atMs).toISOString()}|${new Date(runStartMs).toISOString()}`;
}

export function readPageCursor(cursor: string | undefined): {
  /** The position, as written; undefined without a cursor. */
  at?: string;
  /** Where the run started reading, when the cursor carries it. */
  runStartMs?: number;
} {
  if (!cursor) return {};
  const [at, start] = cursor.split("|");
  const runStartMs = start ? Date.parse(start) : Number.NaN;
  return {
    ...(at ? { at } : {}),
    ...(Number.isFinite(runStartMs) ? { runStartMs } : {}),
  };
}
