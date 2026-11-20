// Time windows of a custom API stream: the chunks one sync request reads,
// the window placeholders of a chunk, and where the next incremental
// window starts (the lookback). Dates are calendar dates in the
// definition's time zone; a day-based step keeps DST days contiguous.

import type { SyncRequest } from "@netrics/connector-sdk";
import type {
  CustomApiDefinition,
  CustomApiStream,
  CustomApiWindow,
} from "@netrics/connector-sdk/custom-api";

import { addCalendarDays, dateInZone } from "../freshness.js";
import { wallTimeInZone } from "./records.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** date windows: yyyy-MM-dd, half-open [from, to); timestamp windows: ISO instants [from, to). */
export interface Chunk {
  from: string;
  to: string;
}

/** The instant a calendar date starts in a zone. */
export function startOfDate(date: string, timeZone: string): number {
  return wallTimeInZone(Date.parse(`${date}T00:00:00.000Z`), timeZone);
}

/** The chunk as calendar dates [from, to). */
export function chunkDates(chunk: Chunk, timeZone: string): Chunk {
  return chunk.from.length === 10
    ? chunk
    : {
        from: dateInZone(Date.parse(chunk.from), timeZone),
        to: dateInZone(Date.parse(chunk.to), timeZone),
      };
}

/** The chunk as instants (milliseconds) [from, to). */
export function chunkInstants(
  chunk: Chunk,
  timeZone: string,
): { from: number; to: number } {
  return chunk.from.length === 10
    ? {
        from: startOfDate(chunk.from, timeZone),
        to: startOfDate(chunk.to, timeZone),
      }
    : { from: Date.parse(chunk.from), to: Date.parse(chunk.to) };
}

/**
 * none → [null]. Range: backfill [max(request.from, request.to −
 * backfillDays), request.to); incremental [request.from, request.to).
 * Dates in timeZone; the end date is the calendar date of request.to plus
 * one day (today included). Steps of stepDays.
 */
export function streamChunks(
  stream: Pick<CustomApiStream, "window">,
  request: Pick<SyncRequest, "mode" | "from" | "to">,
  timeZone: string,
): (Chunk | null)[] {
  const window = stream.window;
  if (window.type === "none") return [null];
  const toMs = Date.parse(request.to);
  const fromMs =
    request.mode === "backfill"
      ? Math.max(Date.parse(request.from), toMs - window.backfillDays * DAY_MS)
      : Date.parse(request.from);
  const end = addCalendarDays(dateInZone(toMs, timeZone), 1);
  let start = dateInZone(fromMs, timeZone);
  const chunks: Chunk[] = [];
  while (start < end) {
    const next = addCalendarDays(start, window.stepDays);
    const to = next < end ? next : end;
    chunks.push(
      window.type === "date"
        ? { from: start, to }
        : {
            from: new Date(startOfDate(start, timeZone)).toISOString(),
            to: new Date(startOfDate(to, timeZone)).toISOString(),
          },
    );
    start = to;
  }
  return chunks;
}

/**
 * window.start / window.end in the stream's paramFormat; endInclusive
 * renders the last included date or instant (to − 1 day / − 1 ms).
 */
export function windowPlaceholders(
  window: CustomApiWindow,
  chunk: Chunk,
  timeZone: string,
): Record<"window.start" | "window.end", string> {
  if (window.type === "none")
    throw new Error("windowPlaceholders needs a window");
  const inclusive = window.endInclusive;
  if (window.paramFormat === "date") {
    const dates = chunkDates(chunk, timeZone);
    return {
      "window.start": dates.from,
      "window.end": inclusive ? addCalendarDays(dates.to, -1) : dates.to,
    };
  }
  const instants = chunkInstants(chunk, timeZone);
  const end = inclusive ? instants.to - 1 : instants.to;
  const render = (ms: number) =>
    window.paramFormat === "timestamp"
      ? new Date(ms).toISOString()
      : window.paramFormat === "unix_seconds"
        ? String(Math.floor(ms / 1000))
        : String(ms);
  return { "window.start": render(instants.from), "window.end": render(end) };
}

/**
 * Incremental only: request.to − the largest lookbackDays, at the start of
 * that day in the definition's zone; undefined without windowed streams.
 */
export function nextFromFor(
  definition: Pick<CustomApiDefinition, "streams" | "defaults">,
  request: Pick<SyncRequest, "mode" | "to">,
): string | undefined {
  if (request.mode !== "incremental") return undefined;
  const lookbacks = definition.streams.flatMap((stream) =>
    stream.window.type === "none" ? [] : [stream.window.lookbackDays],
  );
  if (lookbacks.length === 0) return undefined;
  const timeZone = definition.defaults.timeZone;
  const day = dateInZone(
    Date.parse(request.to) - Math.max(...lookbacks) * DAY_MS,
    timeZone,
  );
  const start = Math.min(startOfDate(day, timeZone), Date.parse(request.to));
  return new Date(start).toISOString();
}
