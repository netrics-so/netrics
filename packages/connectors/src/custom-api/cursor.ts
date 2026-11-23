// The custom-api connector's sync cursor: opaque "cav1." + base64url(JSON).
// Anything else, or a shape this version does not know, restarts the run.

import type { PageState } from "./pagination.js";

export interface CustomApiCursorV1 {
  v: 1;
  /** Index of the stream being read. */
  stream: number;
  /** Index of the chunk of that stream. */
  chunk: number;
  /** The next page to request. */
  page: PageState;
  /** The current refresh, fixed at its first page; "" before it starts. */
  refreshKey: string;
  /** Dataset pages the refresh has emitted so far. */
  pageIndex: number;
  /**
   * Next-link pages the refresh has read, as short hashes of their URL
   * without secrets and with sorted parameters (at most
   * CUSTOM_API_SEEN_PAGES, newest last). A next link back to one of them
   * is a cycle and ends the stream. Absent in cursors of earlier builds.
   */
  seen?: string[];
  /** Safety-limit counters of the run; `request` names the run's sync window. */
  run: { pages: number; records: number; startedAt: string; request: string };
}

const PREFIX = "cav1.";

/** Pages a cursor remembers to detect a next-link cycle. */
export const CUSTOM_API_SEEN_PAGES = 32;

const seenList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= CUSTOM_API_SEEN_PAGES &&
  value.every((hash) => text(hash, 64));

export function encodeCursor(cursor: CustomApiCursorV1): string {
  return (
    PREFIX + Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
  );
}

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown, max = 4_096): value is string =>
  typeof value === "string" && value.length <= max;

function isPageState(value: unknown): value is PageState {
  if (value === null || typeof value !== "object") return false;
  const page = value as Record<string, unknown>;
  switch (page.type) {
    case "first":
      return true;
    case "page_number":
      return count(page.number);
    case "offset":
      return count(page.offset);
    case "cursor":
      // A body-path cursor keeps its JSON type: a number stays a number.
      return (
        (text(page.cursor) && page.cursor !== "") ||
        (typeof page.cursor === "number" && Number.isFinite(page.cursor))
      );
    case "next_url":
      return text(page.url) && page.url !== "";
    default:
      return false;
  }
}

/** Unknown prefix or shape → null (restart the run). */
export function decodeCursor(
  raw: string | undefined,
): CustomApiCursorV1 | null {
  if (!raw?.startsWith(PREFIX) || raw.length > 20_000) return null;
  let value: unknown;
  try {
    value = JSON.parse(
      Buffer.from(raw.slice(PREFIX.length), "base64url").toString("utf8"),
    );
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const cursor = value as Record<string, unknown>;
  const run = cursor.run as Record<string, unknown> | null | undefined;
  if (
    cursor.v !== 1 ||
    !count(cursor.stream) ||
    !count(cursor.chunk) ||
    !isPageState(cursor.page) ||
    !text(cursor.refreshKey, 200) ||
    !count(cursor.pageIndex) ||
    !run ||
    typeof run !== "object" ||
    !count(run.pages) ||
    !count(run.records) ||
    !text(run.startedAt, 40) ||
    !Number.isFinite(Date.parse(run.startedAt)) ||
    !text(run.request, 200) ||
    (cursor.seen !== undefined && !seenList(cursor.seen))
  )
    return null;
  return {
    v: 1,
    stream: cursor.stream,
    chunk: cursor.chunk,
    page: cursor.page,
    refreshKey: cursor.refreshKey,
    pageIndex: cursor.pageIndex,
    ...(cursor.seen !== undefined ? { seen: cursor.seen as string[] } : {}),
    run: {
      pages: run.pages,
      records: run.records,
      startedAt: run.startedAt,
      request: run.request,
    },
  };
}
