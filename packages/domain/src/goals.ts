import {
  CURRENCY_DIMENSION,
  isCurrencyCode,
  isPerCurrencyUnit,
} from "./currency.js";
import {
  addDays,
  civilDate,
  startOfDay,
  type Aggregation,
  type CivilDate,
  type MetricKind,
  type Period,
} from "./metrics.js";

/**
 * Goals (ADR 0019 section 4): a named target for one metric in a calendar
 * period that renews each period, "15,000 downloads of Wurfel this month".
 * Shared by the Goals page, the gauge widget's payload (section 5) and,
 * later, alert rules (milestone 14).
 */

/** Periods to date: a rolling window has no end to reach a goal by. */
export const GOAL_PERIODS = [
  "today",
  "this_week",
  "this_month",
  "this_quarter",
  "this_year",
] as const satisfies readonly Period[];
export type GoalPeriod = (typeof GOAL_PERIODS)[number];

/** `sum` for delta metrics, `last` for gauges and counters. */
export const GOAL_AGGREGATIONS = [
  "sum",
  "last",
] as const satisfies readonly Aggregation[];
export type GoalAggregation = (typeof GOAL_AGGREGATIONS)[number];

export const GOAL_LIMITS = {
  nameLength: 60,
  /** Targets are in payload units (minor units, 0–1 for a ratio). */
  maxTarget: 1e15,
} as const;

export function isGoalPeriod(period: string): period is GoalPeriod {
  return (GOAL_PERIODS as readonly string[]).includes(period);
}

export function isGoalAggregation(
  aggregation: string,
): aggregation is GoalAggregation {
  return (GOAL_AGGREGATIONS as readonly string[]).includes(aggregation);
}

/** Why a metric binding cannot be a goal (400 codes), checked in this order. */
export type GoalProblem =
  | "aggregation_not_supported"
  | "period_not_supported"
  | "goal_direction_unsupported"
  | "currency_required";

/**
 * What keeps a valid metric binding from being a goal, or null. The binding
 * itself (connection, metric, filters) is checked like a widget's first.
 */
export function goalBindingProblem(binding: {
  aggregation: string;
  period: string;
  /** The metric's direction: a "stay below" goal needs its own rule. */
  better: "higher" | "lower";
  unit: string;
  dimensions: Readonly<Record<string, string>>;
  displayCurrency: string | null;
}): GoalProblem | null {
  if (!isGoalAggregation(binding.aggregation)) {
    return "aggregation_not_supported";
  }
  if (!isGoalPeriod(binding.period)) {
    return "period_not_supported";
  }
  if (binding.better === "lower") {
    return "goal_direction_unsupported";
  }
  // The target is in one currency, so the value must be too: one currency
  // exactly, or converted into a fixed one, never "the workspace's".
  if (isPerCurrencyUnit(binding.unit)) {
    const only = binding.dimensions[CURRENCY_DIMENSION];
    const fixed =
      (only !== undefined && isCurrencyCode(only)) ||
      binding.displayCurrency !== null;
    if (!fixed) {
      return "currency_required";
    }
  }
  return null;
}

// ─── Period end ─────────────────────────────────────────────────────────────

function parts(date: CivilDate): [number, number, number] {
  const [year, month, day] = date.split("-").map(Number);
  return [year!, month!, day!];
}

function firstOfMonth(year: number, monthIndex: number): CivilDate {
  return new Date(Date.UTC(year, monthIndex, 1)).toISOString().slice(0, 10);
}

/** The first day after the goal's period that contains `today`. */
function nextPeriodStart(period: GoalPeriod, today: CivilDate): CivilDate {
  const [year, month] = parts(today);
  switch (period) {
    case "today":
      return addDays(today, 1);
    case "this_week": {
      // ISO weeks: Monday starts (ADR 0019 §3).
      const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
      return addDays(today, 7 - ((weekday + 6) % 7));
    }
    case "this_month":
      return firstOfMonth(year, month);
    case "this_quarter":
      return firstOfMonth(year, month - 1 - ((month - 1) % 3) + 3);
    case "this_year":
      return `${year + 1}-01-01`;
  }
}

/** The exclusive end of the goal's current period in the workspace zone. */
export function goalPeriodEnd(
  period: GoalPeriod,
  now: Date,
  timeZone: string,
): Date {
  return startOfDay(
    nextPeriodStart(period, civilDate(now, timeZone)),
    timeZone,
  );
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * An instant as ISO 8601 with the zone's offset at that instant,
 * "2026-11-01T00:00:00+01:00", so clients read the zone's wall time.
 */
export function zonedIsoString(instant: Date, timeZone: string): string {
  let formatter = zoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "longOffset",
    });
    zoneFormatters.set(timeZone, formatter);
  }
  const field: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    field[part.type] = part.value;
  }
  // "GMT+01:00", or "GMT" for UTC itself.
  const offset = (field.timeZoneName ?? "GMT").slice(3) || "+00:00";
  return `${field.year}-${field.month}-${field.day}T${field.hour}:${field.minute}:${field.second}${offset}`;
}

// ─── Progress ───────────────────────────────────────────────────────────────

/** Where a goal stands in its current period (ADR 0019 §5's payload fields). */
export interface GoalProgress {
  /** The metric's value so far; null without data. */
  value: number | null;
  target: number;
  /** value ÷ target, not clipped; null without data. */
  progress: number | null;
  /**
   * The start of the bucket where the running sum first reached the target
   * (a sum of a delta metric only), else null.
   */
  reachedAt: string | null;
  /** Exclusive end of the period, ISO 8601 with the zone's offset. */
  periodEnd: string;
}

/**
 * A goal's progress from its metric's value and series over the current
 * period (as the metric query returns them). Used by the Goals page and the
 * gauge payload alike, so both always agree.
 */
export function goalProgress(input: {
  target: number;
  aggregation: GoalAggregation;
  kind: MetricKind;
  value: number | null;
  /** The current window's points in order; null where empty. */
  series: readonly { bucket: string; value: number | null }[];
  period: GoalPeriod;
  now: Date;
  timeZone: string;
}): GoalProgress {
  const periodEnd = zonedIsoString(
    goalPeriodEnd(input.period, input.now, input.timeZone),
    input.timeZone,
  );
  if (input.value === null) {
    return {
      value: null,
      target: input.target,
      progress: null,
      reachedAt: null,
      periodEnd,
    };
  }
  let reachedAt: string | null = null;
  if (input.aggregation === "sum" && input.kind === "delta") {
    let running = 0;
    for (const point of input.series) {
      running += point.value ?? 0;
      if (running >= input.target) {
        reachedAt = point.bucket;
        break;
      }
    }
  }
  return {
    value: input.value,
    target: input.target,
    progress: input.value / input.target,
    reachedAt,
    periodEnd,
  };
}

// ─── What screens show ──────────────────────────────────────────────────────

/**
 * The goal is reached: progress at or above the target. Screens show the
 * reached state only on fresh data (the stale surface wins, ADR 0019 §5).
 */
export function goalReached(progress: number | null): boolean {
  return progress !== null && Number.isFinite(progress) && progress >= 1;
}

/**
 * The whole percent a goal widget shows: rounded down, so "100 %" never
 * appears before the goal is reached (99.9 % is "99 %"); 1.224 is 122.
 * Null without progress.
 */
export function goalPercent(progress: number | null): number | null {
  if (progress === null || !Number.isFinite(progress)) return null;
  // A hair over the float error, so 0.29 × 100 = 28.999… is 29.
  const percent = Math.floor(progress * 100 + 1e-9);
  return progress < 1 ? Math.min(99, Math.max(0, percent)) : percent;
}

/**
 * The time part of a goal's progress line, for the client to word:
 * `days` ("9 days left"), `last_day`, `hours` ("5 h left") and
 * `under_hour` ("< 1 h left") while in progress; `early` ("2 days early")
 * once reached.
 */
export type GoalTimeText =
  | { kind: "days"; days: number }
  | { kind: "last_day" }
  | { kind: "hours"; hours: number }
  | { kind: "under_hour" }
  | { kind: "early"; days: number };

/** Whole days from one civil date to another. */
function daysBetween(from: CivilDate, to: CivilDate): number {
  const [fy, fm, fd] = parts(from);
  const [ty, tm, td] = parts(to);
  return Math.round(
    (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000,
  );
}

/**
 * What a goal widget says about time (ADR 0019 §5), from the payload and
 * the screen's own clock, so a cached payload stays right offline and its
 * ETag does not change at midnight.
 *
 * In progress: whole days after today until the period ends ("9 days
 * left"), "last day" on its last day; for `today` the whole hours left
 * ("5 h left"), "< 1 h left" in the last hour. Reached: the whole days
 * after the day it was reached until the period ends ("2 days early"),
 * only with `reachedAt` and not for `today`. Null when there is nothing to
 * say: no progress, the period is over (a payload from before its end), or
 * reached on its last day. Dates are the workspace zone's (`timeZone`).
 */
export function goalTimeText(input: {
  period: string;
  /** Exclusive end of the period, ISO 8601. */
  periodEnd: string;
  reachedAt: string | null;
  progress: number | null;
  now: Date;
  timeZone: string;
}): GoalTimeText | null {
  const end = new Date(input.periodEnd);
  if (input.progress === null || Number.isNaN(end.getTime())) return null;
  const endDate = civilDate(end, input.timeZone);
  if (goalReached(input.progress)) {
    if (input.period === "today" || input.reachedAt === null) return null;
    const reached = new Date(input.reachedAt);
    if (Number.isNaN(reached.getTime())) return null;
    const days = daysBetween(civilDate(reached, input.timeZone), endDate) - 1;
    return days >= 1 ? { kind: "early", days } : null;
  }
  const left = end.getTime() - input.now.getTime();
  if (left <= 0) return null;
  if (input.period === "today") {
    const hours = Math.floor(left / 3_600_000);
    return hours >= 1 ? { kind: "hours", hours } : { kind: "under_hour" };
  }
  const days = daysBetween(civilDate(input.now, input.timeZone), endDate) - 1;
  return days >= 1 ? { kind: "days", days } : { kind: "last_day" };
}
