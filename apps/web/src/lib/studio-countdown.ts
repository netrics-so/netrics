// The countdown widget (ADR 0019 section 8): the time left from the
// viewer's clock to the target, with the unit letters and the target line
// in the screen's language, laid out by the domain's countdownLayout (the
// same answers tvOS gets from the studio-layout vectors).

import {
  countdownDoneText,
  countdownLayout,
  countdownParts,
  countdownText,
  countdownUnits,
  zonedInstant,
  type CountdownLayout,
  type Locale,
} from "@netrics/domain";

import { clockText } from "./studio-clock";
import { contentBox, type ScreenPlacement } from "./studio-render";

/** The year of an instant in a zone (UTC for a zone the runtime lacks). */
function yearIn(date: Date, timeZone: string, locale: Locale): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      year: "numeric",
    }).format(date);
  } catch {
    return String(date.getUTCFullYear());
  }
}

/**
 * The target line: "Tue 7 Oct · 10:00" ("Di., 7. Okt. · 10:00"), the date
 * and time of the target in its zone; with the year when it is not this
 * year ("Thu 7 Oct 2027 · 10:00").
 */
export function countdownTargetLine(
  targetAt: Date,
  timeZone: string,
  locale: Locale,
  now: Date,
): string {
  const text = clockText(targetAt, { timeZone, showDate: true, locale });
  const year = yearIn(targetAt, timeZone, locale);
  const date =
    year === yearIn(now, timeZone, locale) ? text.date : `${text.date} ${year}`;
  return `${date} · ${text.time}`;
}

/** The target as an instant: the payload's, else resolved here. */
export function countdownTargetAt(input: {
  targetAt?: string | null;
  target: string;
  timeZone: string;
}): Date | null {
  if (input.targetAt) {
    const parsed = new Date(input.targetAt);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return zonedInstant(input.target, input.timeZone);
}

export interface CountdownView {
  done: boolean;
  /** The numbers with their unit letters: "14" "h". Empty once done. */
  groups: Array<{ value: string; unit: string }>;
  /** "2 d 14 h 05 m", for assistive technology. */
  text: string;
  /** The text when reached, once done; else null. */
  doneText: string | null;
  /** The target line, or null when it is off (or there is no target). */
  target: string | null;
  layout: CountdownLayout;
}

/** What a countdown shows at `now` at its size. */
export function countdownView(input: {
  now: Date;
  label: string;
  targetAt: Date | null;
  timeZone: string;
  options: { showTarget: boolean; doneText: string | null };
  placement: ScreenPlacement;
  showHeader: boolean;
  fontScale: number;
  locale: Locale;
}): CountdownView {
  const units = countdownUnits(input.locale);
  const parts = input.targetAt
    ? countdownParts(input.now, input.targetAt)
    : { done: false, groups: [] };
  const groups = parts.groups.map((group) => ({
    value: group.value,
    unit: units[group.unit],
  }));
  const doneText = parts.done
    ? countdownDoneText(input.options.doneText, input.locale)
    : null;
  const target =
    input.options.showTarget && input.targetAt
      ? countdownTargetLine(
          input.targetAt,
          input.timeZone,
          input.locale,
          input.now,
        )
      : null;
  const layout = countdownLayout({
    placement: input.placement,
    box: contentBox(input.placement, input.showHeader),
    fontScale: input.fontScale,
    showHeader: input.showHeader,
    label: input.label,
    groups,
    target,
    doneText,
  });
  return {
    done: parts.done,
    groups,
    text: countdownText(parts.groups, units),
    doneText,
    target,
    layout,
  };
}
