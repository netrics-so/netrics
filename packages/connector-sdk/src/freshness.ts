import { z } from "zod";

// ─── Data freshness (optional, since SDK 0.2.13; ADR 0025) ─────────────────

/** Bounds of the freshness contract. */
export const FRESHNESS_LIMITS = {
  /** Streams per manifest. */
  streams: 20,
  /** Entries per done SyncResult (streams × resources, plus connection entries). */
  entries: 2_000,
} as const;

const streamKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/)
  .refine(
    (value) => !["__proto__", "constructor", "prototype"].includes(value),
  );

/** Whether `zone` is an IANA time zone this runtime knows. */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Whether `value` is a real calendar date written YYYY-MM-DD. */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    year >= 1 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Whether a YYYY-MM-DD calendar date is the last day of its month: the
 * only `dataThrough` a monthly stream reports (ADR 0025 §2).
 */
export function isLastDayOfMonth(value: string): boolean {
  if (!isCalendarDate(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1] === day;
}

/**
 * A part of a connector's data that the provider publishes on one cadence
 * (ADR 0025 section 1). "periodic" streams publish complete periods (days,
 * or months with `period: "month"`) in the provider's `timeZone`;
 * "continuous" streams change at any time. Metrics and datasets named here
 * belong to the stream; membership is static.
 */
export const freshnessStreamSchema = z
  .strictObject({
    /** Unique in the manifest ("sales"). */
    key: streamKey,
    /** Display name ("Sales"); translatable like metric names (ADR 0016). */
    name: z.string().min(1).max(100),
    kind: z.enum(["periodic", "continuous"]),
    /** Periodic only; default "day". */
    period: z.enum(["day", "month"]).optional(),
    /** IANA zone of the provider's days; required for periodic streams. */
    timeZone: z.string().min(1).max(100).optional(),
    /** Metric keys of this manifest. */
    metrics: z.array(z.string().min(1)).max(500).optional(),
    /** Source dataset keys of this manifest. */
    datasets: z.array(z.string().min(1)).max(100).optional(),
  })
  .superRefine((stream, ctx) => {
    if (stream.kind === "periodic") {
      if (!stream.timeZone)
        ctx.addIssue({
          code: "custom",
          message: "a periodic freshness stream needs a timeZone",
          path: ["timeZone"],
        });
      else if (!isValidTimeZone(stream.timeZone))
        ctx.addIssue({
          code: "custom",
          message: "invalid freshness stream timeZone",
          path: ["timeZone"],
        });
    } else {
      if (stream.period !== undefined)
        ctx.addIssue({
          code: "custom",
          message: "a continuous freshness stream has no period",
          path: ["period"],
        });
      if (stream.timeZone !== undefined)
        ctx.addIssue({
          code: "custom",
          message: "a continuous freshness stream has no timeZone",
          path: ["timeZone"],
        });
    }
  });
export type FreshnessStream = z.infer<typeof freshnessStreamSchema>;

const instant = z.iso.datetime({ offset: false });

/**
 * What a done sync reports about one stream (ADR 0025 section 2): the run
 * read the stream (of one `resource`, or of the whole connection) completely.
 * `dataThrough` is the last complete provider day (a calendar date in the
 * stream's zone, periodic only); `nextExpectedAt` is when the period after
 * it should be published, reported even when already past; `expectedFrom`
 * the typical earliest publication. A continuous stream reports neither.
 */
export const freshnessEntrySchema = z
  .strictObject({
    stream: streamKey,
    /** Absent: the whole connection. */
    resource: z.string().min(1).max(200).optional(),
    /** YYYY-MM-DD in the provider's reporting zone (periodic only). */
    dataThrough: z
      .string()
      .refine(isCalendarDate, { message: "dataThrough must be YYYY-MM-DD" })
      .optional(),
    /** Overrides the stream's zone for this entry (periodic only). */
    timeZone: z
      .string()
      .min(1)
      .max(100)
      .refine(isValidTimeZone, { message: "invalid timeZone" })
      .optional(),
    /** ISO instant (UTC): earliest typical publication of the next period. */
    expectedFrom: instant.optional(),
    /** ISO instant (UTC): latest normal publication of the next period. */
    nextExpectedAt: instant.optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.expectedFrom === undefined) return;
    if (entry.nextExpectedAt === undefined)
      ctx.addIssue({
        code: "custom",
        message: "expectedFrom needs nextExpectedAt",
        path: ["expectedFrom"],
      });
    else if (Date.parse(entry.expectedFrom) > Date.parse(entry.nextExpectedAt))
      ctx.addIssue({
        code: "custom",
        message: "expectedFrom must not be after nextExpectedAt",
        path: ["expectedFrom"],
      });
  });
export type FreshnessEntry = z.infer<typeof freshnessEntrySchema>;

/**
 * Checks a done result's freshness entries against the manifest's streams
 * (ADR 0025 section 2). Returns the first problem, or null. Undeclared
 * streams, `dataThrough`, expected times or a zone on a continuous stream,
 * and two entries for the same stream and resource are contract violations.
 */
export function freshnessProblem(
  streams: readonly FreshnessStream[] | undefined,
  entries: readonly FreshnessEntry[] | undefined,
): string | null {
  if (!entries?.length) return null;
  const declared = new Map((streams ?? []).map((s) => [s.key, s]));
  const seen = new Set<string>();
  for (const entry of entries) {
    const stream = declared.get(entry.stream);
    if (!stream) return `undeclared freshness stream "${entry.stream}"`;
    const identity = JSON.stringify([entry.stream, entry.resource ?? ""]);
    if (seen.has(identity))
      return `duplicate freshness entry for stream "${entry.stream}"`;
    seen.add(identity);
    if (
      stream.kind === "continuous" &&
      (entry.dataThrough !== undefined ||
        entry.nextExpectedAt !== undefined ||
        entry.expectedFrom !== undefined ||
        entry.timeZone !== undefined)
    )
      return `continuous freshness stream "${entry.stream}" reports no dataThrough, expected times or timeZone`;
    if (
      stream.period === "month" &&
      entry.dataThrough !== undefined &&
      !isLastDayOfMonth(entry.dataThrough)
    )
      return `monthly freshness stream "${entry.stream}" reports dataThrough as the last day of a month`;
  }
  return null;
}
