import type { DashboardWidget } from "@netrics/contracts";
import { isDataWidgetType, periodLabel, type Locale } from "@netrics/domain";

import { webTranslator } from "./i18n/catalogs";
import type { UnreadableLabel } from "./studio-readability";
import { metricWidgetLayout } from "./studio-render";

// The inspector's fit check (design 3b): whether the selected widget's
// label (or a text widget's text) fits at 1080p, and for a metric how large
// its value is drawn. The verdict is the canvas's readability warning
// (studio-readability, studioLayout.labelFit): the check only says it in
// words, so the two never disagree.

export type FitCheck =
  { state: "fits"; text: string } | { state: "cut"; text: string };

/** A five-digit value stands in for the data the inspector does not load. */
const SAMPLE_VALUE = 12_345;

/**
 * The size in units (pixels at 1080p) of a metric widget's value at its
 * placement, for a typical value with the widget's options.
 */
export function metricValueSize(
  widget: Extract<DashboardWidget, { type: "metric" }>,
  label: string,
  fontScale: number,
  showHeader: boolean,
  locale: Locale,
): number {
  const sample = new Intl.NumberFormat(locale).format(SAMPLE_VALUE);
  const layout = metricWidgetLayout({
    label,
    value: { full: sample, compact: sample },
    periodText: periodLabel(widget.period, locale),
    change: widget.options.showChange
      ? { full: "▲ 12%", short: "▲ 12%", comparison: null }
      : null,
    noticeText: null,
    sourceText: null,
    placement: widget,
    showHeader,
    fontScale,
    showSparkline: widget.options.showSparkline,
  });
  return Math.round(layout.value.size);
}

/**
 * The fit check for a widget, or null for widgets without text to cut
 * (clock, image). `unreadable` is the canvas's warning for the widget.
 */
export function fitCheck(input: {
  widget: DashboardWidget;
  /** The label as screens show it (data widgets). */
  label: string;
  unreadable: UnreadableLabel | undefined;
  fontScale: number;
  showHeader: boolean;
  locale: Locale;
}): FitCheck | null {
  const { widget, unreadable, locale } = input;
  const t = webTranslator(locale, "studio.fit");
  if (unreadable) {
    return { state: "cut", text: unreadable.hint };
  }
  if (widget.type === "text") {
    return { state: "fits", text: t("textFits") };
  }
  if (!isDataWidgetType(widget.type)) {
    return null;
  }
  if (widget.type === "metric") {
    const size = metricValueSize(
      widget,
      input.label,
      input.fontScale,
      input.showHeader,
      locale,
    );
    return { state: "fits", text: t("labelFitsValue", { size }) };
  }
  return { state: "fits", text: t("labelFits") };
}
