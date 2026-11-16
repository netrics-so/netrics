// Calendar helpers for the freshness entries the connectors report on a
// done sync (SDK 0.2.13, ADR 0025): provider days are calendar dates in the
// provider's zone, publication times are instants.

const DAY_MS = 24 * 60 * 60 * 1000;

/** The Pacific Time zone App Store Connect, Google Play and Search Console report in. */
export const PACIFIC_TIME_ZONE = "America/Los_Angeles";

/** A YYYY-MM-DD date `days` calendar days later (earlier when negative). */
export function addCalendarDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** The last day (YYYY-MM-DD) of the month of a YYYY-MM-DD date. */
export function lastDayOfMonth(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/** The calendar date (YYYY-MM-DD) of an instant in a time zone. */
export function dateInZone(instantMs: number, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(instantMs))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Offset of a zone from UTC at an instant, in milliseconds. */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(instantMs))
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * The instant (ISO, UTC) of a wall-clock time on a calendar date in a time
 * zone, e.g. 12:00 Pacific Time on 2026-11-16 → "2026-11-16T20:00:00.000Z".
 * Daylight saving time is the zone's at that time of that date. Callers use
 * hours outside the changeover hours (00:00 to 03:00), which exist exactly
 * once on every day.
 */
export function zonedInstant(
  date: string,
  hour: number,
  timeZone: string,
): string {
  const wall = Date.parse(`${date}T00:00:00.000Z`) + hour * 60 * 60 * 1000;
  // Two rounds settle the offset on either side of a changeover.
  let instant = wall - zoneOffsetMs(wall, timeZone);
  instant = wall - zoneOffsetMs(instant, timeZone);
  return new Date(instant).toISOString();
}
