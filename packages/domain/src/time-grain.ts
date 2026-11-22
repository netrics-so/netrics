import { civilDate } from "./metrics.js";

/**
 * The buckets a query can group a date or timestamp dimension into (#838,
 * ADR 0028): calendar days, ISO weeks (Monday, as period windows count
 * weeks) and calendar months.
 */
export const TIME_GRAINS = ["day", "week", "month"] as const;
export type TimeGrain = (typeof TIME_GRAINS)[number];
/** Per grouped dimension id, the bucket its values are grouped into. */
export type GroupByGrain = Readonly<Record<string, TimeGrain>>;

export function isTimeGrain(value: unknown): value is TimeGrain {
  return (TIME_GRAINS as readonly unknown[]).includes(value);
}

/** The first day of the bucket a calendar day ("YYYY-MM-DD") falls in. */
export function grainStart(date: string, grain: TimeGrain): string {
  if (grain === "week") {
    // Monday of the ISO week, as period windows count weeks (startOfWeek);
    // setUTCFullYear keeps years before 100 what they are.
    const day = new Date(0);
    day.setUTCFullYear(
      Number(date.slice(0, 4)),
      Number(date.slice(5, 7)) - 1,
      Number(date.slice(8, 10)),
    );
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
    return day.toISOString().slice(0, 10);
  }
  if (grain === "month") return date.slice(0, 8) + "01";
  return date;
}

const SLOT_MS = 15 * 60 * 1000;

/**
 * A bucketing function for one dimension: a date stays the calendar day it
 * is (no zone applies to a reporting date); a timestamp is the calendar day
 * of its instant in `timeZone` (a 23- or 25-hour day is still one day).
 * The result is the first day of the bucket, a date.
 *
 * Asking the zone for every row would dominate a query, so days are
 * remembered per quarter hour of UTC: where a quarter hour starts and ends
 * on the same day in the zone (all but the one holding its midnight, or a
 * clock change across it), every instant in it is that day; the others are
 * asked one by one.
 */
export function timeGrainBucket(
  type: "date" | "timestamp",
  grain: TimeGrain,
  timeZone: string,
): (value: string) => string {
  if (type === "date") return (value) => grainStart(value, grain);
  if (timeZone === "UTC")
    return (value) => grainStart(value.slice(0, 10), grain);
  /** Per quarter hour, its bucket; null where its instants differ. */
  const slots = new Map<number, string | null>();
  const days = new Map<string, string>();
  const bucketOf = (date: string) => {
    let bucket = days.get(date);
    if (bucket === undefined) {
      bucket = grainStart(date, grain);
      days.set(date, bucket);
    }
    return bucket;
  };
  return (value) => {
    const utc = value.slice(0, 10);
    // No zone has rules for the first century (a source's zero time stays
    // its UTC day), nor a day past the last date a result can carry.
    if (utc < "0100" || utc >= "9999-12-30") return bucketOf(utc);
    // Whole seconds: the precision of a zone's offset.
    const instant = Date.parse(value.slice(0, 19) + "Z");
    const slot = Math.floor(instant / SLOT_MS);
    let known = slots.get(slot);
    if (known === undefined) {
      const first = civilDate(new Date(slot * SLOT_MS), timeZone);
      const last = civilDate(new Date((slot + 1) * SLOT_MS - 1000), timeZone);
      known = first === last ? bucketOf(first) : null;
      if (slots.size < 200_000) slots.set(slot, known);
    }
    return known ?? bucketOf(civilDate(new Date(instant), timeZone));
  };
}
