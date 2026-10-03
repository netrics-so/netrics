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
