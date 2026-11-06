import type { DashboardWidget } from "@netrics/contracts";
import {
  gaugeLayout,
  goalLabel,
  goalPercent,
  goalReached,
  goalTimeText,
  type GaugeLayout,
  type GoalTimeText,
  type Locale,
} from "@netrics/domain";

import { formatCompactValue } from "./format-metric";
import { formatGoalNumber, targetUnit } from "./goals";
import { webTranslator } from "./i18n/catalogs";
import {
  contentBox,
  labelLayout,
  typeScaleFor,
  type ScreenPlacement,
  type WidgetLabelLayout,
} from "./studio-render";

// How the web lays out and words a goal widget (ADR 0019 section 5): the
// domain's `gaugeLayout` (shared with tvOS through the studio-layout
// vectors) for the ring and the parts that fit, `goalPercent` and
// `goalTimeText` for what it says, the numbers formatted for the viewer.

export type GaugeWidget = Extract<DashboardWidget, { type: "gauge" }>;

/** Where a goal stands, as a goal widget shows it. */
export interface GaugeReading {
  /** The goal's period, for "today"'s hours. */
  period: string;
  /** Null without data. */
  value: number | null;
  target: number;
  /** value ÷ target, not clipped; null without data. */
  progress: number | null;
  reachedAt: string | null;
  /** Exclusive end of the period, ISO 8601 with the zone's offset. */
  periodEnd: string;
  /** The display unit ("count", "EUR_minor"). */
  unit: string;
  /** Converted amounts: values read "≈ …". */
  approximate?: boolean;
}

/** A goal widget's label: its title, else its goal's name, else "Goal". */
export function gaugeLabel(
  widget: Pick<GaugeWidget, "title" | "goalName">,
  locale: Locale,
): string {
  return widget.title?.trim() || widget.goalName || goalLabel(locale);
}

/**
 * A whole percent: "122 %", the digits in the viewer's language and a
 * no-break space before the sign in every language, as on tvOS (ADR 0019
 * section 5 writes "83 %").
 */
export function formatPercent(percent: number, locale: Locale): string {
  return `${new Intl.NumberFormat(locale).format(percent)}\u00a0%`;
}

/** "9 days left", "last day", "5 h left", "< 1 h left", "2 days early". */
export function goalTimeWords(time: GoalTimeText, locale: Locale): string {
  const t = webTranslator(locale, "screen.widget");
  switch (time.kind) {
    case "days":
      return t("gaugeDaysLeft", { count: time.days });
    case "last_day":
      return t("gaugeLastDay");
    case "hours":
      return t("gaugeHoursLeft", { count: time.hours });
    case "under_hour":
      return t("gaugeUnderHour");
    case "early":
      return t("gaugeEarly", { count: time.days });
  }
}

export interface GaugeTexts {
  /** Reached: progress at or above the target. */
  reached: boolean;
  /** 0–1, what the ring fills. */
  fill: number;
  /** The text inside the ring: the percent's digits, or the value. */
  value: { full: string; compact: string };
  /** What counts up on slide enter: the percent or the value. */
  count: number | null;
  /** "%" after the percent; null once reached (the value). */
  suffix: string | null;
  /** "Goal 15,000". */
  target: string;
  /** "2,520 to go · 9 days left", "✓ Reached · 122 % · 2 days early". */
  progress: string;
}

/**
 * What a goal widget says (ADR 0019 section 5): in progress the percent
 * rounded down inside the ring and "2,520 to go · 9 days left"; reached,
 * the value inside and "✓ Reached · 122 % · 2 days early". The time part
 * only with `showTimeLeft`, from the viewer's clock.
 */
export function gaugeTexts(
  reading: GaugeReading,
  options: { showTimeLeft: boolean },
  now: Date,
  timeZone: string,
  locale: Locale,
): GaugeTexts {
  const t = webTranslator(locale, "screen.widget");
  const approx = reading.approximate && reading.value !== null ? "≈ " : "";
  const reached = goalReached(reading.progress);
  const percent = goalPercent(reading.progress);
  const time = options.showTimeLeft
    ? goalTimeText({
        period: reading.period,
        periodEnd: reading.periodEnd,
        reachedAt: reading.reachedAt,
        progress: reading.progress,
        now,
        timeZone,
      })
    : null;
  const timeWords = time ? goalTimeWords(time, locale) : null;
  // Goal numbers in full ("15,000", "€1,234.50"), as on the Goals page.
  const unit = targetUnit(reading.unit, {
    dimensions: {},
    displayCurrency: null,
  });
  const full = (value: number | null) => formatGoalNumber(value, unit, locale);
  const target = t("gaugeTarget", {
    target: full(reading.target),
  });
  if (reached && percent !== null) {
    const parts = [
      t("gaugeReached"),
      formatPercent(percent, locale),
      ...(timeWords ? [timeWords] : []),
    ];
    return {
      reached,
      fill: 1,
      value: {
        full: `${approx}${full(reading.value)}`,
        compact: `${approx}${formatCompactValue(reading.value, reading.unit, locale)}`,
      },
      count: reading.value,
      suffix: null,
      target,
      progress: parts.join(" · "),
    };
  }
  const digits =
    percent === null ? "—" : new Intl.NumberFormat(locale).format(percent);
  const left =
    reading.value === null
      ? null
      : t("gaugeToGo", {
          amount: `${approx}${full(Math.max(0, reading.target - reading.value))}`,
        });
  return {
    reached: false,
    fill: Math.min(1, Math.max(0, reading.progress ?? 0)),
    value: { full: digits, compact: digits },
    count: percent,
    suffix: percent === null ? null : "%",
    target,
    progress: [left, timeWords].filter(Boolean).join(" · "),
  };
}

export interface GaugeWidgetLayout {
  label: WidgetLabelLayout;
  gauge: GaugeLayout;
}

/**
 * A goal widget at its size: the domain's layout (orientation, ring,
 * which lines fit, the value's size) and the label fitted to the text's
 * width, as tvOS does it.
 */
export function gaugeWidgetLayout(input: {
  label: string;
  texts: GaugeTexts | null;
  placement: ScreenPlacement;
  showHeader: boolean;
  fontScale: number;
}): GaugeWidgetLayout {
  const box = contentBox(input.placement, input.showHeader);
  const gauge = gaugeLayout({
    label: input.label,
    width: box.width,
    height: box.height,
    fontScale: input.fontScale,
    value: input.texts?.value ?? null,
    suffix: input.texts?.suffix ?? null,
    progress: input.texts?.progress ?? null,
  });
  const sizes = typeScaleFor(
    "gauge",
    input.placement,
    input.fontScale,
    input.showHeader,
  );
  return {
    label: labelLayout(input.label, gauge.textWidth, sizes),
    gauge,
  };
}

/**
 * How the number inside the ring is worded on every frame of the slide
 * enter (ADR 0018 section 6): the percent's digits in progress, the value
 * in the form it is shown in once reached; null when nothing counts.
 */
export function gaugeCountFormat(
  texts: GaugeTexts | null,
  shown: string,
  reading: GaugeReading | null,
  locale: Locale,
): ((value: number) => string) | null {
  if (!texts || !reading || texts.count === null) return null;
  if (!texts.reached) {
    return (value) => new Intl.NumberFormat(locale).format(Math.floor(value));
  }
  const approx = reading.approximate ? "≈ " : "";
  const unit = targetUnit(reading.unit, {
    dimensions: {},
    displayCurrency: null,
  });
  if (shown === texts.value.full) {
    return (value) => `${approx}${formatGoalNumber(value, unit, locale)}`;
  }
  if (shown === texts.value.compact) {
    return (value) =>
      `${approx}${formatCompactValue(value, reading.unit, locale)}`;
  }
  return null;
}
