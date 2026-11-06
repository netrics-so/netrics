import { STUDIO_TEXT_MINIMUMS, estimateTextWidth } from "@netrics/domain";

import { LINE_HEIGHT, fitLabel, type FittedLabel } from "./studio-render";

// Geometry of the line and bar widgets (ADR 0015, section 2), in canvas
// units. The renderers draw it as SVG and HTML; nothing here touches the DOM.

export interface ChartPoint {
  bucket?: string;
  value: number | null;
}

export interface LineChartGeometry {
  /** The plot area inside the chart box. */
  plot: { x: number; y: number; width: number; height: number };
  /** The current period, one path per run of points without gaps. */
  current: string[];
  /** The area under the current period's runs. */
  area: string[];
  /** The previous period, dashed; empty when hidden or without data. */
  previous: string[];
  /** The latest current point, marked in the accent colour. */
  last: { x: number; y: number } | null;
  /** Value labels at the top and bottom of the plot, when the axis shows. */
  yLabels: Array<{ y: number; text: string }>;
  /** Period labels under the plot, when the axis shows. */
  xLabels: Array<{ x: number; text: string; anchor: "start" | "end" }>;
  /** Axis label size in units. */
  axisSize: number;
}

function finite(points: readonly ChartPoint[]): number[] {
  return points
    .map((point) => point.value)
    .filter(
      (value): value is number => value !== null && Number.isFinite(value),
    );
}

function runs(
  points: readonly ChartPoint[],
  x: (index: number) => number,
  y: (value: number) => number,
): Array<Array<[number, number]>> {
  const result: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [];
  points.forEach((point, index) => {
    if (point.value === null || !Number.isFinite(point.value)) {
      if (current.length > 0) result.push(current);
      current = [];
      return;
    }
    current.push([x(index), y(point.value)]);
  });
  if (current.length > 0) result.push(current);
  return result;
}

function path(run: Array<[number, number]>): string {
  return run
    .map(
      ([px, py], index) =>
        `${index === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`,
    )
    .join("");
}

/**
 * A line chart of the current period with the previous one dashed behind
 * it, scaled to share one value axis that starts at zero (or below, for
 * negative values). Gaps in the data stay gaps. Axis labels are at least
 * 24 units (`axisSize`).
 */
export function lineChartGeometry(input: {
  series: readonly ChartPoint[];
  previous: readonly ChartPoint[] | null;
  width: number;
  height: number;
  showAxis: boolean;
  axisSize?: number;
  formatValue: (value: number) => string;
  bucketLabel: (bucket: string | undefined) => string | null;
}): LineChartGeometry | null {
  const values = finite(input.series);
  if (input.series.length < 2 || values.length === 0) {
    return null;
  }
  const previousValues = input.previous ? finite(input.previous) : [];
  const all = [...values, ...previousValues];
  const low = Math.min(0, ...all);
  let high = Math.max(...all);
  if (high <= low) high = low + 1;

  const axisSize = Math.max(input.axisSize ?? 0, STUDIO_TEXT_MINIMUMS.axis);
  const topText = input.formatValue(high);
  const bottomText = input.formatValue(low);
  const labelWidth = input.showAxis
    ? Math.max(
        estimateTextWidth(topText, axisSize),
        estimateTextWidth(bottomText, axisSize),
      ) + 12
    : 0;
  const top = input.showAxis ? axisSize * 0.6 : 4;
  const bottom = input.showAxis ? axisSize * LINE_HEIGHT + 8 : 4;
  const plot = {
    x: labelWidth,
    y: top,
    width: Math.max(1, input.width - labelWidth - 4),
    height: Math.max(1, input.height - top - bottom),
  };
  const count = input.series.length;
  const x = (index: number) => plot.x + (index / (count - 1)) * plot.width;
  const y = (value: number) =>
    plot.y + plot.height - ((value - low) / (high - low)) * plot.height;

  const currentRuns = runs(input.series, x, y);
  // The value axis always includes zero.
  const baseline = y(0);
  const area = currentRuns
    .filter((run) => run.length > 1)
    .map(
      (run) =>
        `${path(run)}L${run[run.length - 1]![0].toFixed(1)},${baseline.toFixed(1)}L${run[0]![0].toFixed(1)},${baseline.toFixed(1)}Z`,
    );
  const previous = input.previous
    ? runs(input.previous.slice(0, count), x, y).map(path)
    : [];

  let lastIndex = count - 1;
  while (lastIndex > 0 && input.series[lastIndex]!.value === null) {
    lastIndex -= 1;
  }
  const lastValue = input.series[lastIndex]!.value;

  const first = input.bucketLabel(input.series[0]!.bucket);
  const final = input.bucketLabel(input.series[count - 1]!.bucket);
  const xLabels: LineChartGeometry["xLabels"] = [];
  if (input.showAxis) {
    if (first) xLabels.push({ x: plot.x, text: first, anchor: "start" });
    if (final && final !== first) {
      xLabels.push({ x: plot.x + plot.width, text: final, anchor: "end" });
    }
  }

  return {
    plot,
    current: currentRuns.map(path),
    area,
    previous,
    last: lastValue === null ? null : { x: x(lastIndex), y: y(lastValue) },
    yLabels: input.showAxis
      ? [
          { y: plot.y, text: topText },
          { y: plot.y + plot.height, text: bottomText },
        ]
      : [],
    xLabels,
    axisSize,
  };
}

export interface BarEntry {
  label: string;
  value: number;
  /** "Others": the rest added up. */
  others?: boolean;
}

export interface BarRow {
  label: FittedLabel;
  value: number;
  valueText: string;
  /** Bar length as a share of the largest bar, 0–1. */
  ratio: number;
  others: boolean;
}

export interface BarLayout {
  rows: BarRow[];
  /** Label and value size in units. */
  size: number;
  /** Width of the value column in units. */
  valueWidth: number;
  /** Bar thickness in units. */
  barHeight: number;
  rowGap: number;
  /** Groups moved into "Others" because the widget was too small. */
  folded: number;
}

const BAR_ROW_GAP = 12;
const VALUE_GAP = 16;

function barHeight(size: number): number {
  return Math.max(12, Math.round(size * 0.45));
}

function rowsAt(
  entries: readonly BarEntry[],
  size: number,
  width: number,
  formatValue: (value: number) => string,
): { rows: BarRow[]; valueWidth: number; height: number; truncated: boolean } {
  const texts = entries.map((entry) => formatValue(entry.value));
  const valueWidth = Math.max(
    0,
    ...texts.map((text) => estimateTextWidth(text, size, "semibold")),
  );
  const labelWidth = Math.max(1, width - valueWidth - VALUE_GAP);
  const max = Math.max(0, ...entries.map((entry) => entry.value));
  const rows = entries.map((entry, index) => ({
    label: fitLabel(entry.label, labelWidth, { size, floor: size }),
    value: entry.value,
    valueText: texts[index]!,
    ratio: max > 0 ? Math.max(0, entry.value) / max : 0,
    others: entry.others ?? false,
  }));
  const height = rows.reduce(
    (sum, row, index) =>
      sum +
      row.label.lines * size * LINE_HEIGHT +
      4 +
      barHeight(size) +
      (index > 0 ? BAR_ROW_GAP : 0),
    0,
  );
  return {
    rows,
    valueWidth,
    height,
    truncated: rows.some((row) => row.label.truncated),
  };
}

/** The last named groups and "Others" added up into one "Others" row. */
function foldLast(
  entries: readonly BarEntry[],
  othersLabel: string,
): BarEntry[] {
  const named = entries.filter((entry) => !entry.others);
  const others = entries.find((entry) => entry.others);
  const kept = named.slice(0, -1);
  const moved = named[named.length - 1];
  return [
    ...kept,
    {
      label: others?.label ?? othersLabel,
      value: (others?.value ?? 0) + (moved?.value ?? 0),
      others: true,
    },
  ];
}

/**
 * The bars of a bar widget: one row per group, largest first, then
 * "Others". Each row is its label (up to two lines) with the value on the
 * right and the bar below. Labels start at the resource line's size and
 * shrink to the minimum; when the rows still do not fit, the smallest
 * groups are added to "Others" rather than drawn unreadably. A label that
 * needs more than two lines at the minimum is the last-resort ellipsis.
 */
export function barLayout(input: {
  groups: readonly BarEntry[];
  others: BarEntry | null;
  width: number;
  height: number;
  /** Starting label size in units (the resource size, font-scaled). */
  size: number;
  formatValue: (value: number) => string;
  othersLabel?: string;
}): BarLayout {
  const othersLabel = input.othersLabel ?? "Others";
  let entries: BarEntry[] = [
    ...input.groups.map((group) => ({ ...group, others: false })),
    ...(input.others ? [{ ...input.others, others: true }] : []),
  ];
  const floor = STUDIO_TEXT_MINIMUMS.any;
  const start = Math.max(floor, input.size);
  for (let size = start; size > floor; size -= 1) {
    const at = rowsAt(entries, size, input.width, input.formatValue);
    if (!at.truncated && at.height <= input.height) {
      return {
        rows: at.rows,
        size,
        valueWidth: at.valueWidth,
        barHeight: barHeight(size),
        rowGap: BAR_ROW_GAP,
        folded: 0,
      };
    }
  }
  let folded = 0;
  let at = rowsAt(entries, floor, input.width, input.formatValue);
  while (
    at.height > input.height &&
    entries.filter((entry) => !entry.others).length > 1
  ) {
    entries = foldLast(entries, othersLabel);
    folded += 1;
    at = rowsAt(entries, floor, input.width, input.formatValue);
  }
  return {
    rows: at.rows,
    size: floor,
    valueWidth: at.valueWidth,
    barHeight: barHeight(floor),
    rowGap: BAR_ROW_GAP,
    folded,
  };
}
