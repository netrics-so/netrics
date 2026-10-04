const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 minutes ago", "in 2 hours" — for sync state timestamps. */
export function relativeTime(iso: string | null): string {
  if (!iso) {
    return "never";
  }
  const deltaSeconds = Math.round((Date.parse(iso) - Date.now()) / 1000);
  const future = deltaSeconds > 0;
  const absolute = Math.abs(deltaSeconds);
  let text: string;
  if (absolute < 45) {
    text = "just now";
  } else if (absolute < HOUR) {
    const minutes = Math.round(absolute / MINUTE);
    text = `${minutes} minute${minutes === 1 ? "" : "s"}`;
  } else if (absolute < DAY) {
    const hours = Math.round(absolute / HOUR);
    text = `${hours} hour${hours === 1 ? "" : "s"}`;
  } else {
    const days = Math.round(absolute / DAY);
    text = `${days} day${days === 1 ? "" : "s"}`;
  }
  if (text === "just now") {
    return text;
  }
  return future ? `in ${text}` : `${text} ago`;
}

/**
 * "5 minutes ago", "vor 5 Minuten", "in 2 hours" with Intl in the given
 * language (ADR 0016 section 8); "now" within 45 seconds. Null without a
 * time.
 */
export function relativeTimeIn(
  iso: string | null,
  locale: string,
  now: number = Date.now(),
): string | null {
  if (!iso) {
    return null;
  }
  const deltaSeconds = Math.round((Date.parse(iso) - now) / 1000);
  const absolute = Math.abs(deltaSeconds);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (absolute < 45) {
    return format.format(0, "second");
  }
  const sign = deltaSeconds < 0 ? -1 : 1;
  if (absolute < HOUR) {
    return format.format(sign * Math.round(absolute / MINUTE), "minute");
  }
  if (absolute < DAY) {
    return format.format(sign * Math.round(absolute / HOUR), "hour");
  }
  return format.format(sign * Math.round(absolute / DAY), "day");
}

/** "every 5 minutes", "every 6 hours" — a poll interval in words. */
export function intervalLabel(seconds: number): string {
  const units: Array<[number, string]> = [
    [DAY, "day"],
    [HOUR, "hour"],
    [MINUTE, "minute"],
  ];
  for (const [size, name] of units) {
    if (seconds >= size && seconds % size === 0) {
      const count = seconds / size;
      return count === 1 ? `every ${name}` : `every ${count} ${name}s`;
    }
  }
  return `every ${seconds} seconds`;
}
