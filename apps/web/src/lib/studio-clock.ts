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

/** "14:05" (or "2:05 PM") and "Sat 4 Oct". */
export function clockText(
  date: Date,
  options: { timeZone: string; hour12?: boolean; showDate?: boolean },
): ClockText {
  const time = options.hour12
    ? format(date, "en-US", options.timeZone, {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      })
    : format(date, "en-GB", options.timeZone, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
  const day = options.showDate
    ? format(date, "en-GB", options.timeZone, {
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
