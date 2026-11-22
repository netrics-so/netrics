import { dataFail, validateDataValue } from "./data-expression.js";
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
    // The week holding the first day a date can be is cut at that day.
    return day.getUTCFullYear() < 0
      ? "0000-01-01"
      : day.toISOString().slice(0, 10);
  }
  if (grain === "month") return date.slice(0, 8) + "01";
  return date;
}

const SLOT_MS = 15 * 60 * 1000;
/** From here on an instant is read in the zone; before, as its UTC day. */
const FIRST_ZONED_INSTANT = Date.parse("0100-01-01T00:00:00Z");
const LAST_INSTANT = Date.parse("9999-12-31T23:59:59Z");
const LAST_DAY = "9999-12-31";

/**
 * A bucketing function for one dimension: a date stays the calendar day it
 * is (no zone applies to a reporting date); a timestamp is the calendar day
 * of its instant in `timeZone` (a 23- or 25-hour day is still one day).
 * The result is the first day of the bucket, a date.
 *
 * A timestamp is bucketed from its parsed instant, never from its text
 * ("…T24:00:00Z" is the next day), and UTC is a zone like any other. Two
 * edges, where no zone has rules or no date exists: an instant before the
 * year 100 is its UTC day (a source's zero time stays one day), and a day
 * past 9999-12-31 in the zone is 9999-12-31.
 *
 * Asking the zone for every row would dominate a query, so days are
 * remembered per quarter hour of UTC: where a quarter hour and the next
 * start on the same day in the zone (all but the one before its midnight,
 * or a clock change across it), every instant in it is that day; the
 * others are asked one by one.
 */
export function timeGrainBucket(
  type: "date" | "timestamp",
  grain: TimeGrain,
  timeZone: string,
): (value: string) => string {
  // Tables are validated before they are queried; a value that is no date
  // or timestamp after all is the data error it would have been there,
  // never a malformed group or a crash.
  const buckets = new Map<unknown, string>();
  const bucketOf = (date: string) => {
    let bucket = buckets.get(date);
    if (bucket === undefined) {
      validateDataValue("date", date, false);
      bucket = grainStart(date, grain);
      if (buckets.size < 200_000) buckets.set(date, bucket);
    }
    return bucket;
  };
  if (type === "date") return bucketOf;
  /** The instant's calendar day in the zone. */
  const dayAt = (instant: number): string => {
    if (instant > LAST_INSTANT) return LAST_DAY;
    if (instant < FIRST_ZONED_INSTANT)
      return new Date(instant).toISOString().slice(0, 10);
    const day = civilDate(new Date(instant), timeZone);
    return day.length === 10 ? day : LAST_DAY;
  };
  /** Per quarter hour, the day it starts on. */
  const starts = new Map<number, string>();
  const startOf = (slot: number) => {
    let day = starts.get(slot);
    if (day === undefined) {
      day = dayAt(slot * SLOT_MS);
      if (starts.size < 200_000) starts.set(slot, day);
    }
    return day;
  };
  return (value) => {
    // Whole seconds: the precision of a zone's offset.
    const instant =
      typeof value === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value)
        ? Date.parse(value.slice(0, 19) + "Z")
        : NaN;
    if (!Number.isFinite(instant)) dataFail("data_timestamp_invalid");
    const slot = Math.floor(instant / SLOT_MS);
    const day = startOf(slot);
    return bucketOf(day === startOf(slot + 1) ? day : dayAt(instant));
  };
}
