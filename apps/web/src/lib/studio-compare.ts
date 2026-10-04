import type { MetricBetter, MetricPeriod } from "@netrics/contracts";
import {
  compareChange,
  compareLayout,
  periodLabel,
  type CompareFormat,
  type CompareLayout,
  type Locale,
} from "@netrics/domain";

import {
  formatCompactValue,
  formatValue,
  type ChangeTone,
} from "./format-metric";
import { webTranslator } from "./i18n/catalogs";
import {
  contentBox,
  labelLayout,
  typeScaleFor,
  type ScreenPlacement,
  type WidgetLabelLayout,
} from "./studio-render";

// How the web lays out a compare widget (ADR 0019 section 10): the
// domain's `compareLayout` (shared with tvOS through the studio-layout
// vectors) for the sizes and what fits, the numbers formatted for the
// viewer exactly as NetricsKit's CompareText does.

/** One side as the widget shows it: its metric's name and value. */
export interface CompareOperandReading {
  label: string;
  /** Null without data. */
  value: number | null;
  /** The display unit ("count", "EUR_minor"). */
  unit: string;
}

export interface CompareReading {
  numerator: CompareOperandReading;
  denominator: CompareOperandReading;
  /** A ÷ B now and over the previous period (`ratioOf`). */
  ratio: { value: number | null; previousValue: number | null };
  /** The ratio's unit: null (unitless) or an amount per unit's currency. */
  unit: string | null;
  better: MetricBetter;
}

const ARROWS = { up: "▲", down: "▼", flat: "■" } as const;

/** "32.7%" (percent), "4.62" or "€0.42" (ratio); "–" without a ratio. */
export function compareRatioText(
  value: number | null,
  format: CompareFormat,
  unit: string | null,
  locale: Locale,
): string {
  if (value === null || !Number.isFinite(value)) {
    return webTranslator(locale, "screen.widget")("compareNoRatio");
  }
  if (format === "percent") return formatValue(value, "ratio", locale);
  return formatValue(value, unit ?? "count", locale);
}

/**
 * The ratio's change: "▲ 1.9 pt" in percentage points (one decimal, no
 * sign) for `percent`, "▲ +6.2%" for `ratio`; toned by `better`. Null
 * without both ratios (or against a zero for `ratio`).
 */
export function compareChangeText(
  ratio: { value: number | null; previousValue: number | null },
  format: CompareFormat,
  better: MetricBetter,
  locale: Locale,
): { text: string; tone: ChangeTone } | null {
  const change = compareChange({ ...ratio, format });
  if (!change) return null;
  const tone: ChangeTone =
    change.direction === "flat"
      ? "neutral"
      : (change.direction === "up") === (better === "higher")
        ? "good"
        : "bad";
  const arrow = ARROWS[change.direction];
  if (change.kind === "points") {
    const points = new Intl.NumberFormat(locale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(Math.abs(change.value));
    const t = webTranslator(locale, "screen.widget");
    return { text: `${arrow} ${t("comparePoints", { value: points })}`, tone };
  }
  const sign =
    change.direction === "up" ? "+" : change.direction === "down" ? "−" : "±";
  const percent = new Intl.NumberFormat(locale, {
    maximumFractionDigits: Math.abs(change.value) < 0.1 ? 1 : 0,
  }).format(Math.abs(change.value) * 100);
  return { text: `${arrow} ${sign}${percent}%`, tone };
}

/** An operand in full and compact form; "—" without a value. */
export function compareOperandTexts(
  operand: CompareOperandReading,
  locale: Locale,
): { full: string; compact: string } {
  return {
    full: formatValue(operand.value, operand.unit, locale),
    compact: formatCompactValue(operand.value, operand.unit, locale),
  };
}

/** The footer's candidates with "derived" first (design 4b). */
export function compareFooterCandidates(
  candidates: readonly string[],
  locale: Locale,
): string[] {
  const derived = webTranslator(locale, "screen.widget")("compareDerived");
  return [...candidates.map((text) => `${derived} · ${text}`), derived];
}

export interface CompareWidgetLayout {
  label: WidgetLabelLayout;
  compare: CompareLayout;
  /** "Last 7 days". */
  period: string;
  numerator: { text: string; caption: string };
  denominator: { text: string; caption: string };
  ratio: string;
  ratioLabel: string;
  change: { text: string; tone: ChangeTone } | null;
}

/**
 * A compare widget at its size (ADR 0019 section 10): the label, the
 * period line, the operands (compact when the full forms do not fit), the
 * ratio with its label and change, and whether the footer has room.
 */
export function compareWidgetLayout(input: {
  label: string;
  period: MetricPeriod;
  options: {
    format: CompareFormat;
    ratioLabel: string | null;
    showChange: boolean;
  };
  reading: CompareReading | null;
  loading?: boolean;
  placement: ScreenPlacement;
  showHeader: boolean;
  fontScale: number;
  locale: Locale;
}): CompareWidgetLayout {
  const { locale, reading, options } = input;
  const t = webTranslator(locale, "screen.widget");
  const box = contentBox(input.placement, input.showHeader);
  const placeholder = input.loading ? "…" : "—";
  const operand = (side: CompareOperandReading | undefined) =>
    side
      ? compareOperandTexts(side, locale)
      : { full: placeholder, compact: placeholder };
  const numerator = operand(reading?.numerator);
  const denominator = operand(reading?.denominator);
  const ratio = reading
    ? compareRatioText(
        reading.ratio.value,
        options.format,
        reading.unit,
        locale,
      )
    : placeholder;
  const ratioLabel = options.ratioLabel ?? t("compareRatio");
  const change =
    reading && options.showChange
      ? compareChangeText(reading.ratio, options.format, reading.better, locale)
      : null;
  const compare = compareLayout({
    label: input.label,
    width: box.width,
    height: box.height,
    fontScale: input.fontScale,
    numerator,
    denominator,
    ratio,
    ratioLabel,
    change: change?.text ?? null,
  });
  const sizes = typeScaleFor(
    "compare",
    input.placement,
    input.fontScale,
    input.showHeader,
  );
  return {
    label: labelLayout(input.label, box.width, sizes),
    compare,
    period: periodLabel(input.period, locale),
    numerator: {
      text: compare.compact ? numerator.compact : numerator.full,
      caption: reading?.numerator.label ?? "",
    },
    denominator: {
      text: compare.compact ? denominator.compact : denominator.full,
      caption: reading?.denominator.label ?? "",
    },
    ratio,
    ratioLabel,
    change,
  };
}
