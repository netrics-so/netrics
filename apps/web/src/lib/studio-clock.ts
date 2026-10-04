// The clock widget and the slide header's clock (ADR 0015, section 2): the
// time, and optionally the date, in the workspace's time zone or the
// widget's own.

export interface ClockText {
  time: string;
  date: string | null;
}

function format(
  date: Date,
  locale: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): string {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone, ...options }).format(
      date,
    );
  } catch {
    // An unknown zone (an old browser's tz data): UTC, labelled as such by
    // the caller's settings; never a blank clock.
    return new Intl.DateTimeFormat(locale, {
      timeZone: "UTC",
      ...options,
    }).format(date);
  }
}

/**
 * "14:05" (or "2:05 PM") and "Sat 4 Oct" ("Sa., 4. Okt." in German): the
 * date in the screen's language (ADR 0016); English when none is given.
 */
export function clockText(
  date: Date,
  options: {
    timeZone: string;
    hour12?: boolean;
    showDate?: boolean;
    locale?: string;
  },
): ClockText {
  const locale = options.locale ?? "en";
  // English keeps its regional habits: 12-hour in the US form, 24-hour and
  // the date in the British one ("Sat 4 Oct").
  const time = options.hour12
    ? format(date, locale === "en" ? "en-US" : locale, options.timeZone, {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      })
    : format(date, locale === "en" ? "en-GB" : locale, options.timeZone, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
  const day = options.showDate
    ? format(date, locale === "en" ? "en-GB" : locale, options.timeZone, {
        weekday: "short",
        day: "numeric",
        month: "short",
      })
    : null;
  return { time, date: day };
}

/** Milliseconds until the next minute starts: the clock ticks on it. */
export function msUntilNextMinute(now: number): number {
  return 60_000 - (now % 60_000);
}
