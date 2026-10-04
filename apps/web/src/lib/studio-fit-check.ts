import type { DashboardWidget } from "@netrics/contracts";
import {
  clockLayout,
  countdownLayout,
  countdownUnits,
  isDataWidgetType,
  zonedInstant,
  periodLabel,
  type Locale,
} from "@netrics/domain";

import { webTranslator } from "./i18n/catalogs";
import { countdownTargetLine } from "./studio-countdown";
import type { UnreadableLabel } from "./studio-readability";
import { contentBox, metricWidgetLayout } from "./studio-render";

// The inspector's fit check (design 3b): whether the selected widget's
// label (or a text widget's text) fits at 1080p, and for a metric how large
// its value is drawn. The verdict is the canvas's readability warning
// (studio-readability, studioLayout.labelFit): the check only says it in
// words, so the two never disagree.

export type FitCheck =
  | { state: "fits"; text: string }
  | { state: "cut"; text: string }
  /** Something is left out by design (a clock's lines): info, not a fault. */
  | { state: "partial"; text: string };

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
 * (image, a time-only clock). `unreadable` is the canvas's warning for the
 * widget. A clock says which of its lines are left out for room
 * (`clock_parts_hidden`).
 */
export function fitCheck(input: {
  widget: DashboardWidget;
  /** The label as screens show it (data widgets). */
  label: string;
  unreadable: UnreadableLabel | undefined;
  fontScale: number;
  showHeader: boolean;
  locale: Locale;
  /** The workspace's time zone, for a clock or countdown without its own. */
  timeZone?: string;
  /** Now, for a countdown whose target has passed (default: the call's). */
  now?: Date;
}): FitCheck | null {
  const { widget, unreadable, locale } = input;
  const t = webTranslator(locale, "studio.fit");
  if (unreadable) {
    return { state: "cut", text: unreadable.hint };
  }
  if (widget.type === "clock") {
    const options = widget.options;
    if (!options.showDate && !options.showZone) return null;
    const layout = clockLayout({
      placement: widget,
      box: contentBox(widget, input.showHeader),
      fontScale: input.fontScale,
      showHeader: input.showHeader,
      time: options.hour12 ? "12:00 PM" : "00:00",
      showDate: options.showDate,
      dateStyle: options.dateStyle,
      zone: options.showZone
        ? (options.timeZone ?? input.timeZone ?? "UTC")
        : null,
    });
    if (!layout.hidden) return { state: "fits", text: t("clockFits") };
    const dateHidden = options.showDate && layout.date === null;
    const zoneHidden = options.showZone && layout.zone === null;
    const hidden =
      dateHidden && zoneHidden ? "both" : dateHidden ? "date" : "zone";
    return { state: "partial", text: t("clockPartsHidden", { hidden }) };
  }
  if (widget.type === "countdown") {
    // ADR 0019 section 8: a past target saves; the inspector says what
    // screens show, and whether the target line has room.
    const now = input.now ?? new Date();
    const timeZone = widget.options.timeZone ?? input.timeZone ?? "UTC";
    const targetAt = zonedInstant(widget.options.target, timeZone);
    if (targetAt !== null && targetAt.getTime() <= now.getTime()) {
      return { state: "partial", text: t("countdownPassed") };
    }
    if (widget.options.showTarget && targetAt !== null) {
      const units = countdownUnits(locale);
      const layout = countdownLayout({
        placement: widget,
        box: contentBox(widget, input.showHeader),
        fontScale: input.fontScale,
        showHeader: input.showHeader,
        label: input.label,
        groups: [
          { value: "0", unit: units.d },
          { value: "00", unit: units.h },
          { value: "00", unit: units.m },
        ],
        target: countdownTargetLine(targetAt, timeZone, locale, now),
        doneText: null,
      });
      if (!layout.showTarget) {
        return { state: "partial", text: t("countdownTargetHidden") };
      }
    }
    return { state: "fits", text: t("labelFits") };
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
