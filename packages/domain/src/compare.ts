/**
 * The compare widget (ADR 0019 section 10): two metrics and their ratio,
 * "12.5k downloads / 38.2k visitors → 32.7 % conversion, ▲ 1.9 pt".
 *
 * `ratioOf` is the one rule for A ÷ B (milestone 11's derived metrics reuse
 * it); `compareChange` the change of the ratio against the previous period;
 * `compareLayout` the widget's content layout. Ported to Swift
 * (apps/tvos/NetricsKit, CompareLayout in StudioLayout.swift) and covered
 * by packages/domain/test-vectors/studio-layout.json, so keep every
 * function pure and its arithmetic in the same order on both sides.
 */
import {
  CURRENCY_DIMENSION,
  amountCurrency,
  isPerCurrencyUnit,
} from "./currency.js";
import {
  STUDIO_LABEL_MAX_LINES,
  STUDIO_TEXT_MINIMUMS,
  effectiveFontScale,
  estimateTextWidth,
  labelParts,
  wrappedLineCount,
} from "./studio-layout.js";

/** How a compare widget shows its ratio: "32.7%" or "4.62" (or "€0.42"). */
export type CompareFormat = "percent" | "ratio";

export const COMPARE_FORMATS: readonly CompareFormat[] = ["percent", "ratio"];

/**
 * A ÷ B over the same period: null when either side has no value, a side
 * is not a finite number, or the denominator is zero — never infinity.
 */
export function ratioOf(
  numerator: number | null,
  denominator: number | null,
): number | null {
  if (numerator === null || denominator === null) return null;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return null;
  }
  if (denominator === 0) return null;
  const ratio = numerator / denominator;
  return Number.isFinite(ratio) ? ratio : null;
}

export interface CompareChange {
  /** points: percentage points (`percent`); relative: a share (`ratio`). */
  kind: "points" | "relative";
  /** Points (1.9 for "1.9 pt"), or the relative change (0.062 for +6.2 %). */
  value: number;
  /** The sign of the change, before rounding. */
  direction: "up" | "down" | "flat";
}

/**
 * The ratio's change against the previous period: in percentage points
 * for the `percent` format ((value − previous) × 100), relative for
 * `ratio` ((value − previous) ÷ |previous|, null against zero). Null
 * without both ratios.
 */
export function compareChange(ratio: {
  value: number | null;
  previousValue: number | null;
  format: CompareFormat;
}): CompareChange | null {
  const { value, previousValue } = ratio;
  if (value === null || previousValue === null) return null;
  if (!Number.isFinite(value) || !Number.isFinite(previousValue)) return null;
  const delta = value - previousValue;
  const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  if (ratio.format === "percent") {
    return { kind: "points", value: delta * 100, direction };
  }
  if (previousValue === 0) return null;
  return {
    kind: "relative",
    value: delta / Math.abs(previousValue),
    direction,
  };
}

// ---------------------------------------------------------------------------
// Units

/** A side's binding as the unit rule needs it. */
export interface CompareSide {
  /** The metric's unit ("count", "EUR_minor", "currency_minor"). */
  unit: string;
  /** Its filters; a `currency` filter fixes a per-currency amount. */
  dimensions: Readonly<Record<string, string>>;
}

/**
 * The currency a side's amounts are in, as far as a save can know: the
 * unit's ("EUR_minor"), the `currency` filter's, the widget's display
 * currency, or "*" for a per-currency amount that follows the workspace's
 * display currency at query time. Null when the side is not an amount.
 */
export function compareSideCurrency(
  side: CompareSide,
  displayCurrency: string | null,
): string | null {
  const fixed = amountCurrency(side.unit, side.dimensions[CURRENCY_DIMENSION]);
  if (fixed !== null) return fixed;
  if (!isPerCurrencyUnit(side.unit)) return null;
  return displayCurrency ?? "*";
}

export type CompareUnitsProblem =
  /** The units cannot form this ratio (ADR 0019 section 10). */
  | "compare_units_incompatible"
  /** A display currency that converts neither side. */
  | "currency_choice_conflict";

/**
 * Whether two sides can form a ratio in `format` (ADR 0019 section 10): a
 * currency denominator only over the same currency (a unitless ratio such
 * as ROAS); a currency numerator over a count is an amount per unit and
 * needs `ratio`; `percent` needs two sides without currency. A display
 * currency must convert at least one side (a per-currency amount without
 * a `currency` filter). Null when they can.
 */
export function compareUnitsProblem(input: {
  numerator: CompareSide;
  denominator: CompareSide;
  displayCurrency: string | null;
  format: CompareFormat;
}): CompareUnitsProblem | null {
  const { numerator, denominator, displayCurrency } = input;
  if (displayCurrency !== null) {
    const converts = (side: CompareSide) =>
      isPerCurrencyUnit(side.unit) &&
      side.dimensions[CURRENCY_DIMENSION] === undefined;
    if (!converts(numerator) && !converts(denominator)) {
      return "currency_choice_conflict";
    }
  }
  const a = compareSideCurrency(numerator, displayCurrency);
  const b = compareSideCurrency(denominator, displayCurrency);
  if (b !== null && a !== b) return "compare_units_incompatible";
  if (input.format === "percent" && (a !== null || b !== null)) {
    return "compare_units_incompatible";
  }
  return null;
}

/**
 * The ratio's unit in a payload: the numerator's currency ("EUR_minor")
 * for an amount per unit, else null (unitless). `numeratorUnit` and
 * `denominatorUnit` are the queried sides' units ("EUR_minor", "count").
 */
export function compareRatioUnit(
  numeratorUnit: string | null,
  denominatorUnit: string | null,
): string | null {
  if (numeratorUnit === null) return null;
  const a = amountCurrency(numeratorUnit);
  if (a === null) return null;
  const b = denominatorUnit === null ? null : amountCurrency(denominatorUnit);
  return b === null ? numeratorUnit : null;
}

// ---------------------------------------------------------------------------
// Layout

/** Line height of a compare widget's text, as `STUDIO_LINE_HEIGHT`. */
const COMPARE_LINE_HEIGHT = 1.15;

/** A compare widget's spacing in units. */
export const COMPARE_SPACING = {
  /** Between the label, period line, operands, ratio and footer. */
  stack: 8,
  /** On both sides of the "/" between the operands. */
  operandGap: 24,
  /** Between the ratio, its label and its change. */
  ratioGap: 16,
} as const;

/** The separator between the operands. */
export const COMPARE_SEPARATOR = "/";

/** Share of the content height the ratio may take at most. */
const COMPARE_RATIO_HEIGHT_SHARE = 0.3;

export interface CompareLayoutInput {
  /** The widget's label as screens show it ("Downloads · Wurfel"). */
  label: string;
  /** The content box in units: the widget's rect less its padding. */
  width: number;
  height: number;
  fontScale?: number;
  /** The operands as shown, full and compact ("12,500", "12.5K"). */
  numerator: { full: string; compact: string };
  denominator: { full: string; compact: string };
  /** The ratio as shown ("32.7%", "4.62"). */
  ratio: string;
  /** The ratio's label ("conversion"; "ratio" by default). */
  ratioLabel: string;
  /** The change ("▲ 1.9 pt"), or null without one. */
  change: string | null;
}

export interface CompareLayout {
  /** Text sizes in units. */
  sizes: {
    title: number;
    resource: number;
    /** The period line and the footer. */
    small: number;
    operand: number;
    caption: number;
    /** The ratio: at least the value minimum, as large as fits. */
    ratio: number;
    /** The ratio's label and change (change role). */
    change: number;
  };
  /** Lines of the title (1–2) and of the resource line (0–2). */
  titleLines: number;
  resourceLines: number;
  /** The period line and the footer; the footer goes first, then the period. */
  showPeriod: boolean;
  showFooter: boolean;
  /** The operands in their compact form ("12.5K"). */
  compact: boolean;
  /** The widest a caption may be before it ends with an ellipsis. */
  captionWidth: number;
  /** The ratio's label and change beside the ratio, or on a line below. */
  ratioLine: "beside" | "below";
}

/**
 * A compare widget's content (ADR 0019 section 10), top to bottom: the
 * label (title and resource line, at most two lines each), the period
 * line, the operands side by side (48 u, compact when the full forms do
 * not fit) with their captions (24 u) and "/" between them, the ratio (the
 * value role: at least 64 u and as large as fits) with its label and
 * change (28 u) beside it or, when they do not fit there, below it, and
 * the footer. When height runs short the footer goes first, then the
 * period line.
 */
export function compareLayout(input: CompareLayoutInput): CompareLayout {
  const scale = effectiveFontScale(input.fontScale);
  const m = STUDIO_TEXT_MINIMUMS;
  const width = Math.max(0, input.width);
  const height = Math.max(0, input.height);
  const lh = COMPARE_LINE_HEIGHT;
  const gap = COMPARE_SPACING.stack;
  const title = m.title * scale;
  const resource = m.resource * scale;
  const small = m.any * scale;
  const operand = m.operand * scale;
  const caption = m.any * scale;
  const change = m.change * scale;
  const valueMin = m.value * scale;
  const valueMax = Math.max(valueMin, height * COMPARE_RATIO_HEIGHT_SHARE);

  const parts = labelParts(input.label);
  const titleLines = Math.min(
    STUDIO_LABEL_MAX_LINES,
    Math.max(1, wrappedLineCount(parts.title, width, title, "semibold")),
  );
  const resourceLines =
    parts.resource === null
      ? 0
      : Math.min(
          STUDIO_LABEL_MAX_LINES,
          Math.max(
            1,
            wrappedLineCount(parts.resource, width, resource, "semibold"),
          ),
        );
  const labelHeight = titleLines * title * lh + resourceLines * resource * lh;

  // The operands: full when both fit beside the separator, else compact.
  const separator = estimateTextWidth(COMPARE_SEPARATOR, operand, "regular");
  const between = 2 * COMPARE_SPACING.operandGap + separator;
  const operandsWidth = (compactForm: boolean) => {
    const a = compactForm ? input.numerator.compact : input.numerator.full;
    const b = compactForm ? input.denominator.compact : input.denominator.full;
    return (
      estimateTextWidth(a, operand, "semibold") +
      between +
      estimateTextWidth(b, operand, "semibold")
    );
  };
  const fullWidth = operandsWidth(false);
  const compact = fullWidth > width && operandsWidth(true) < fullWidth;
  const captionWidth = Math.max(0, (width - between) / 2);
  const operandsHeight = operand * lh + caption * lh;

  // The ratio's label and change: beside the ratio when they fit there at
  // its minimum, else on a line of their own below it.
  const ratioGap = COMPARE_SPACING.ratioGap;
  const restWidth =
    ratioGap +
    estimateTextWidth(input.ratioLabel, change, "regular") +
    (input.change === null
      ? 0
      : ratioGap + estimateTextWidth(input.change, change, "regular"));
  const ratioAtOne = estimateTextWidth(input.ratio, 1, "semibold");
  const beside = ratioAtOne * valueMin + restWidth <= width;
  const below = beside ? 0 : gap + change * lh;

  const fixed = (ratio: number) =>
    labelHeight + gap + operandsHeight + gap + ratio * lh + below;
  const line = gap + small * lh;
  const candidates: Array<[boolean, boolean]> = [
    [true, true],
    [true, false],
    [false, false],
  ];
  const [showPeriod, showFooter] = candidates.find(
    ([period, footer]) =>
      fixed(valueMin) + (period ? line : 0) + (footer ? line : 0) <= height,
  ) ?? [false, false];
  const others = fixed(0) + (showPeriod ? line : 0) + (showFooter ? line : 0);
  const byHeight = (height - others) / lh;
  const room = beside ? width - restWidth : width;
  const byWidth = ratioAtOne > 0 ? room / ratioAtOne : valueMax;
  const ratio = Math.max(valueMin, Math.min(valueMax, byHeight, byWidth));

  return {
    sizes: {
      title,
      resource,
      small,
      operand,
      caption,
      ratio,
      change,
    },
    titleLines,
    resourceLines,
    showPeriod,
    showFooter,
    compact,
    captionWidth,
    ratioLine: beside ? "beside" : "below",
  };
}
