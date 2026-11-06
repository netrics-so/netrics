import type { MetricBetter, MetricPeriod } from "@netrics/contracts";
import {
  periodLabel,
  tableChangeKind,
  tableLayout,
  tableRowLabel,
  tableRowsShown,
  type Locale,
  type TableLayout,
} from "@netrics/domain";

import {
  formatChange,
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

// How the web lays out a table widget (ADR 0019 section 6): the domain's
// `tableLayout` (shared with tvOS through the studio-layout vectors) for
// the rows that fit, the column widths and the row label sizes; the
// numbers formatted for the viewer.

export interface TableRowReading {
  label: string;
  value: number;
  previousValue: number | null;
  ratio: number | null;
}

export interface TableReading {
  unit: string;
  better: MetricBetter;
  /** Column heads: the dimension and the metric, in the viewer's language. */
  columns: { label: string; value: string };
  /** Largest first, at most `limit`. */
  rows: TableRowReading[];
  /** The rest added up, when the widget shows "Others"; else null. */
  others: { label: string; value: number } | null;
  /** Converted amounts: values read "≈ …". */
  approximate?: boolean;
}

export interface TableRowText {
  label: string;
  /** The value in full and compact form ("≈ " first when converted). */
  value: { full: string; compact: string };
  /** The Δ text ("+12%", "new", "–"); "" for Others, null without Δ. */
  change: string | null;
  tone: ChangeTone;
  others: boolean;
}

/**
 * Every row a table asks for, then Others, as text: the value in both
 * forms and the change against the previous window ("+12%", "−3%"; "new"
 * when there was nothing before; "–" without both), toned by `better`.
 */
export function tableRowTexts(
  reading: TableReading,
  options: { limit: number; showChange: boolean },
  locale: Locale,
): TableRowText[] {
  const t = webTranslator(locale, "screen.widget");
  const approx = reading.approximate ? "≈ " : "";
  const value = (amount: number) => ({
    full: `${approx}${formatValue(amount, reading.unit, locale)}`,
    compact: `${approx}${formatCompactValue(amount, reading.unit, locale)}`,
  });
  const rows: TableRowText[] = reading.rows
    .slice(0, options.limit)
    .map((row) => {
      const kind = tableChangeKind(row);
      const change =
        kind === "ratio" && row.previousValue !== null
          ? formatChange(
              row.value - row.previousValue,
              row.ratio,
              reading.unit,
              reading.better,
              locale,
            )
          : null;
      return {
        label: row.label,
        value: value(row.value),
        change: !options.showChange
          ? null
          : change
            ? change.text
            : kind === "new"
              ? t("tableNew")
              : t("tableNoChange"),
        tone: options.showChange ? (change?.tone ?? "neutral") : "neutral",
        others: false,
      };
    });
  if (reading.others) {
    rows.push({
      label: reading.others.label,
      value: value(reading.others.value),
      change: options.showChange ? "" : null,
      tone: "neutral",
      others: true,
    });
  }
  return rows;
}

/** "Top 5 · Last 30 days". */
export function tableSubtitle(
  shown: number,
  period: MetricPeriod,
  locale: Locale,
): string {
  const t = webTranslator(locale, "screen.widget");
  return `${t("tableTop", { count: shown })} · ${periodLabel(period, locale)}`;
}

export interface TableRowView extends Omit<TableRowText, "value"> {
  /** The value as shown: full, or compact when the layout says so. */
  value: string;
  /** The label's size in units, and whether it ends with an ellipsis. */
  labelSize: number;
  truncated: boolean;
}

export interface TableWidgetLayout {
  label: WidgetLabelLayout;
  table: TableLayout;
  /** "Top 5 · Last 30 days". */
  subtitle: string;
  /** min(limit, rows, capacity) rows, then Others when a row is left. */
  rows: TableRowView[];
  /** Data rows shown (Others not counted). */
  shown: number;
}

/**
 * A table widget at its size: the label, the subtitle with how many rows
 * it shows, and the rows that fit (ADR 0019 section 6). Nothing is dropped
 * silently: the subtitle says how many, and the Studio warns `rows_cut`.
 */
export function tableWidgetLayout(input: {
  label: string;
  period: MetricPeriod;
  limit: number;
  showChange: boolean;
  reading: TableReading | null;
  placement: ScreenPlacement;
  showHeader: boolean;
  fontScale: number;
  locale: Locale;
}): TableWidgetLayout {
  const { locale, reading } = input;
  const box = contentBox(input.placement, input.showHeader);
  const texts = reading ? tableRowTexts(reading, input, locale) : [];
  const base = {
    label: input.label,
    width: box.width,
    height: box.height,
    fontScale: input.fontScale,
    showChange: input.showChange,
  };
  // The capacity does not depend on the values; the column widths do, on
  // the rows actually shown (and Others when it gets a row), as on tvOS.
  const capacity = tableLayout(base).rowCapacity;
  const shown = reading
    ? tableRowsShown(input.limit, reading.rows.length, capacity)
    : 0;
  const shownTexts = [
    ...texts.filter((row) => !row.others).slice(0, shown),
    ...(shown < capacity ? texts.filter((row) => row.others) : []),
  ];
  const table = tableLayout({
    ...base,
    values: shownTexts.map((row) => row.value),
  });
  const sizes = typeScaleFor(
    "table",
    input.placement,
    input.fontScale,
    input.showHeader,
  );
  const view = (row: TableRowText): TableRowView => {
    const fitted = tableRowLabel(row.label, table.columns.label, table.sizes);
    return {
      ...row,
      value: table.compact ? row.value.compact : row.value.full,
      labelSize: fitted.size,
      truncated: fitted.truncated,
    };
  };
  const rows = shownTexts.map(view);
  return {
    label: labelLayout(input.label, box.width, sizes),
    table,
    subtitle: tableSubtitle(shown, input.period, locale),
    rows,
    shown,
  };
}
