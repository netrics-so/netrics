import type {
  ConnectionFreshnessStream,
  DeviceStatusStream,
  DeviceTileStatus,
  WidgetFreshness,
} from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import { webTranslator } from "./i18n/catalogs";
import { relativeTimeIn } from "./relative-time";

// How far a widget's numbers reach, in words (ADR 0025 section 8). The
// payload carries instants and the provider's day; everything here is
// worded on the client, in the viewer's time zone, from the client clock.

/** Who reads it, and when: the viewer's language, zone and clock. */
export interface FreshnessClock {
  locale: Locale;
  now: number;
  /**
   * IANA zone of the viewer (`useViewerTimeZone`, #749): always given, so a
   * server render never words a time in the server's zone.
   */
  timeZone: string;
}

const SEPARATOR = " · ";
const DAY_MS = 86_400_000;

/** The calendar day of an instant in a zone, as days since 1970-01-01. */
function localDay(instant: number, clock: FreshnessClock): number {
  // Numeric parts in Latin digits, whatever the language writes.
  const parts = new Intl.DateTimeFormat(clock.locale, {
    timeZone: clock.timeZone,
    numberingSystem: "latn",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(instant);
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(value("year"), value("month") - 1, value("day")) / DAY_MS;
}

/** A provider's day (YYYY-MM-DD) as a UTC instant, to format as itself. */
function providerDay(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

/**
 * A provider's day ("Nov 15", "15. Nov.") or, for a monthly stream, its
 * month ("October", "October 2025" when not the current year). Never
 * converted to the viewer's zone: it is the provider's label.
 */
function periodText(
  date: string,
  monthly: boolean,
  clock: FreshnessClock,
): string {
  const day = providerDay(date);
  if (!monthly) {
    return new Intl.DateTimeFormat(clock.locale, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(day);
  }
  const currentYear = new Date(
    localDay(clock.now, clock) * DAY_MS,
  ).getUTCFullYear();
  return new Intl.DateTimeFormat(clock.locale, {
    month: "long",
    ...(day.getUTCFullYear() !== currentYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(day);
}

/** The period after a provider's day: the next day, or the next month. */
function nextPeriod(date: string, monthly: boolean): string {
  const day = providerDay(date);
  const next = monthly
    ? new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 1))
    : new Date(day.getTime() + DAY_MS);
  return next.toISOString().slice(0, 10);
}

/**
 * An expected instant in the viewer's zone: "~9:00 PM" today, "tomorrow
 * ~9:00 AM", "Wed ~9:00 AM" within a week, "~Nov 23" beyond. Null when it
 * is already past (the caller says "any minute") or does not parse.
 */
export function expectedWhen(
  iso: string,
  clock: FreshnessClock,
): string | null {
  const instant = Date.parse(iso);
  if (Number.isNaN(instant) || instant <= clock.now) return null;
  const t = webTranslator(clock.locale, "screen.freshness");
  const { locale, timeZone } = clock;
  const days = localDay(instant, clock) - localDay(clock.now, clock);
  const time = new Intl.DateTimeFormat(locale, {
    timeStyle: "short",
    timeZone,
  }).format(instant);
  if (days <= 0) return t("at", { time });
  if (days === 1) {
    const day = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
      1,
      "day",
    );
    return t("dayAt", { day, time });
  }
  if (days < 7) {
    const day = new Intl.DateTimeFormat(locale, {
      weekday: "short",
      timeZone,
    }).format(instant);
    return t("dayAt", { day, time });
  }
  const date = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    timeZone,
  }).format(instant);
  return t("onDate", { date });
}

/** "10 min. ago" under a day, else the date ("Nov 14"); null: unknown. */
function fetchedTime(
  iso: string,
  clock: FreshnessClock,
): { time: string } | { date: string } | null {
  const instant = Date.parse(iso);
  if (Number.isNaN(instant)) return null;
  if (clock.now - instant < DAY_MS) {
    const time = relativeTimeIn(iso, clock.locale, clock.now, "short");
    return time ? { time } : null;
  }
  return {
    date: new Intl.DateTimeFormat(clock.locale, {
      month: "short",
      day: "numeric",
      timeZone: clock.timeZone,
    }).format(instant),
  };
}

/**
 * Whether the last day a report covers is older than the day netrics last
 * checked (#791, ADR 0025 section 8): the provider's day, as written,
 * against the calendar day of `fetchedAt` in the viewer's zone. A report
 * that lags by its normal cadence counts. Never for a continuous stream,
 * a monthly one (it names a month) or a stream without a day yet.
 */
export function reportingDayBeforeCheck(
  freshness: Pick<
    WidgetFreshness,
    "kind" | "dataThrough" | "period" | "fetchedAt"
  >,
  clock: FreshnessClock,
): boolean {
  if (
    freshness.kind !== "periodic" ||
    !freshness.dataThrough ||
    freshness.period === "month"
  ) {
    return false;
  }
  const checked = Date.parse(freshness.fetchedAt);
  const day = providerDay(freshness.dataThrough).getTime() / DAY_MS;
  if (Number.isNaN(checked) || Number.isNaN(day)) return false;
  return day < localDay(checked, clock);
}

export interface FreshnessPartsOptions {
  /** Prefix the stream's name, for lists of several streams. */
  stream?: boolean;
  /**
   * Word the day as "Last reporting day: Nov 17" where it is older than
   * the day of the last check (`reportingDayBeforeCheck`, #791); the other
   * parts are the same.
   */
  reportingDay?: boolean;
  /** Say when netrics last read a periodic stream; default true. */
  fetched?: boolean;
  /**
   * Under a warning (failing or stale connection): only the covered day,
   * with the late wording when late; no "fetched", no "next".
   */
  warning?: boolean;
  /**
   * Syncs are paused until the connection is reconnected (the scheduler
   * skips it): no "next", "checking again" or "next check".
   */
  paused?: boolean;
}

/**
 * The parts of a freshness line, most important first, so a narrow widget
 * drops them from the end: "Up to Nov 15", "fetched 10 min. ago",
 * "next ~9:00 PM"; for a late provider "Up to Nov 14", "Nov 15 not
 * published yet", "checking again ~3:10 PM"; for a continuous stream
 * "Checked 10 min. ago", "next check ~2:30 PM".
 */
export function freshnessParts(
  freshness: WidgetFreshness,
  clock: FreshnessClock,
  options: FreshnessPartsOptions = {},
): string[] {
  const t = webTranslator(clock.locale, "screen.freshness");
  const stream = options.stream ? freshness.stream : null;
  const parts: string[] = [];
  if (freshness.kind === "continuous") {
    if (options.warning) return [];
    const fetched = fetchedTime(freshness.fetchedAt, clock);
    if (fetched) {
      parts.push(
        "time" in fetched
          ? stream
            ? t("streamChecked", { stream, time: fetched.time })
            : t("checked", { time: fetched.time })
          : stream
            ? t("streamCheckedOn", { stream, date: fetched.date })
            : t("checkedOn", { date: fetched.date }),
      );
    }
    if (freshness.nextCheckAt && !options.paused) {
      const when = expectedWhen(freshness.nextCheckAt, clock);
      parts.push(when ? t("nextCheck", { when }) : t("nextCheckSoon"));
    }
    return parts;
  }
  const monthly = freshness.period === "month";
  if (freshness.dataThrough) {
    const date = periodText(freshness.dataThrough, monthly, clock);
    const named =
      options.reportingDay === true &&
      reportingDayBeforeCheck(freshness, clock);
    parts.push(
      named
        ? stream
          ? t("streamReportingDay", { stream, date })
          : t("reportingDay", { date })
        : stream
          ? t("streamUpTo", { stream, date })
          : t("upTo", { date }),
    );
  }
  if (freshness.late && freshness.dataThrough) {
    parts.push(
      t("notPublished", {
        period: periodText(
          nextPeriod(freshness.dataThrough, monthly),
          monthly,
          clock,
        ),
      }),
    );
    if (options.warning) return parts;
    if (freshness.nextCheckAt && !options.paused) {
      const when = expectedWhen(freshness.nextCheckAt, clock);
      parts.push(when ? t("checkingAgain", { when }) : t("checkingSoon"));
    }
    return parts;
  }
  if (options.warning) return parts;
  if (options.fetched ?? true) {
    const fetched = fetchedTime(freshness.fetchedAt, clock);
    if (fetched) {
      parts.push(
        "time" in fetched
          ? t("fetched", { time: fetched.time })
          : t("fetchedOn", { date: fetched.date }),
      );
    }
  }
  if (freshness.nextExpectedAt && !options.paused) {
    const when = expectedWhen(freshness.nextExpectedAt, clock);
    parts.push(when ? t("next", { when }) : t("nextSoon"));
  }
  return parts;
}

/** A provider's day in short numbers ("11/17", "17.11."), never converted. */
function numericDay(date: string, clock: FreshnessClock): string {
  return new Intl.DateTimeFormat(clock.locale, {
    month: "numeric",
    day: "numeric",
    timeZone: "UTC",
  }).format(providerDay(date));
}

/** One form of a several-source line: its lines, and the same with the days named. */
export interface FreshnessSourceForm {
  lines: string[];
  /**
   * The form with "last reporting day" for every source whose day is
   * older than its last check (#791); absent when no source's is, and for
   * the short forms.
   */
  named?: string[];
}

/**
 * The forms of a freshness line that lists several sources (#784, ADR 0025
 * sections 7 and 8), longest first, each one or more lines; empty without
 * `sources`. Every source's day and next time and the fetch
 * ("App Store up to Nov 17 · next ~9:00 PM · Google Play up to Nov 11 ·
 * fetched 10 min. ago"); without the fetch; the days only; the days in
 * short numbers ("App Store up to 11/17 · Google Play up to 11/11"); the
 * stores and their days alone ("App Store 11/17 · Google Play 11/11");
 * and last the short days on a line each. A source is never left out. Under a warning
 * every form has the days (and "not published yet") only.
 *
 * The first three forms also come `named` (#791): "App Store last
 * reporting day: Nov 17 · …" for each source whose day is older than the
 * day of its last check.
 */
export function freshnessSourceForms(
  freshness: WidgetFreshness,
  clock: FreshnessClock,
  options: Pick<FreshnessPartsOptions, "warning" | "paused"> = {},
): FreshnessSourceForm[] {
  const sources = freshness.sources ?? [];
  if (sources.length < 2) return [];
  const t = webTranslator(clock.locale, "screen.freshness");
  const named = sources.map((source) => {
    const line = { ...source, stream: source.source };
    const parts = freshnessParts(line, clock, {
      stream: true,
      fetched: false,
      ...options,
    });
    // Under a warning a continuous source still names its check.
    const all = parts.length
      ? parts
      : freshnessParts(line, clock, { stream: true }).slice(0, 1);
    const first = all.slice(0, 1);
    // The day named (#791): only the first part differs, if any.
    const day = freshnessParts(line, clock, {
      stream: true,
      fetched: false,
      reportingDay: true,
      ...options,
    }).slice(0, 1);
    const dayNamed = day.length === 1 && day[0] !== first[0];
    const short =
      source.kind === "periodic" &&
      source.dataThrough &&
      source.period !== "month"
        ? [
            t("streamUpTo", {
              stream: source.source,
              date: numericDay(source.dataThrough, clock),
            }),
          ]
        : first;
    // Shortest: the store and its day alone ("App Store 11/17").
    const shortest =
      source.kind === "periodic" &&
      source.dataThrough &&
      source.period !== "month"
        ? [`${source.source} ${numericDay(source.dataThrough, clock)}`]
        : short;
    const shown = options.warning ? all.slice(0, source.late ? 2 : 1) : all;
    return {
      all: shown,
      first,
      namedAll: dayNamed ? [...day, ...shown.slice(1)] : shown,
      namedFirst: dayNamed ? day : first,
      dayNamed,
      short,
      shortest,
    };
  });
  const join = (parts: string[]) => parts.join(SEPARATOR);
  const fetched = fetchedTime(freshness.fetchedAt, clock);
  const fetchedPart =
    options.warning || !fetched
      ? null
      : "time" in fetched
        ? t("fetched", { time: fetched.time })
        : t("fetchedOn", { date: fetched.date });
  const anyNamed = named.some((source) => source.dayNamed);
  const full = named.flatMap((source) => source.all);
  const namedFull = named.flatMap((source) => source.namedAll);
  const form = (lines: string[], other?: string[]): FreshnessSourceForm =>
    anyNamed && other ? { lines, named: other } : { lines };
  return [
    ...(fetchedPart
      ? [
          form(
            [join([...full, fetchedPart])],
            [join([...namedFull, fetchedPart])],
          ),
        ]
      : []),
    form([join(full)], [join(namedFull)]),
    form(
      [join(named.flatMap((source) => source.first))],
      [join(named.flatMap((source) => source.namedFirst))],
    ),
    form([join(named.flatMap((source) => source.short))]),
    form([join(named.flatMap((source) => source.shortest))]),
    form(named.map((source) => join(source.short))),
  ];
}

/**
 * The forms as the levels a screen picks from, the first that fits one
 * line (`freshnessLevelFit`): each form with the days named (#791) right
 * before the same form without. Naming the day so never costs a part a
 * tile shows today: it is the first thing a narrower tile drops.
 */
export function freshnessSourceLevels(
  freshness: WidgetFreshness,
  clock: FreshnessClock,
  options: Pick<FreshnessPartsOptions, "warning" | "paused"> = {},
): string[][] {
  return freshnessSourceForms(freshness, clock, options).flatMap((form) =>
    form.named ? [form.named, form.lines] : [form.lines],
  );
}

/** Every prefix of the parts, longest first: footer candidates. */
export function partsCandidates(parts: readonly string[]): string[] {
  return parts.map((_, index) =>
    parts.slice(0, parts.length - index).join(SEPARATOR),
  );
}

/**
 * A widget's freshness parts with the day named (#791): "Last reporting
 * day: Nov 17" in place of "Up to Nov 17", the rest the same. Null where
 * the day is not older than the day of the last check, and for lists that
 * name the stream (a connection's page, a status board), which stay as
 * they are.
 */
export function reportingDayParts(
  freshness: WidgetFreshness,
  clock: FreshnessClock,
  options: FreshnessPartsOptions = {},
): string[] | null {
  if (options.stream || !reportingDayBeforeCheck(freshness, clock)) {
    return null;
  }
  return freshnessParts(freshness, clock, { ...options, reportingDay: true });
}

/**
 * The freshness line's candidates, longest first (ADR 0018 section 5).
 * Where the last reporting day is older than the day of the last check
 * (#791), each candidate comes with the day named right before it: "Last
 * reporting day: Nov 17 · fetched 10 min. ago", then "Up to Nov 17 ·
 * fetched 10 min. ago". A widget that has no room for the longer wording
 * shows exactly what it showed before.
 */
export function freshnessCandidates(
  freshness: WidgetFreshness,
  clock: FreshnessClock,
  options: FreshnessPartsOptions = {},
): string[] {
  const plain = partsCandidates(freshnessParts(freshness, clock, options));
  const named = reportingDayParts(freshness, clock, options);
  if (!named || named.length !== plain.length) return plain;
  const namedCandidates = partsCandidates(named);
  return plain.flatMap((line, index) => [namedCandidates[index]!, line]);
}

/** The statuses whose warning notice comes before the freshness line. */
export function isWarningStatus(status: DeviceTileStatus | undefined): boolean {
  return status === "stale" || status === "outage" || status === "auth_failed";
}

/**
 * A widget's warning notice with its freshness (precedence 1): a provider
 * overdue by a day (a stale widget whose stream is late) says so in the
 * late wording; any other warning keeps its notice and adds the covered
 * day. Without a warning or freshness the notice is unchanged.
 */
export function freshnessNotice(
  notice: string | null,
  status: DeviceTileStatus | undefined,
  freshness: WidgetFreshness | null | undefined,
  clock: FreshnessClock,
): string | null {
  if (!freshness || !isWarningStatus(status)) return notice;
  const parts = freshnessParts(freshness, clock, { warning: true });
  if (parts.length === 0) return notice;
  if (status === "stale" && freshness.late) return parts.join(SEPARATOR);
  return notice ? [notice, parts[0]!].join(SEPARATOR) : parts.join(SEPARATOR);
}

/** One stream of a connection as a line: its freshness, and whether overdue. */
export interface StreamFreshness {
  freshness: WidgetFreshness;
  /** Late by a day or more: the warning style (ADR 0025 section 7). */
  overdue: boolean;
}

type FreshnessEntry = ConnectionFreshnessStream["entries"][number];

/** One entry of a connection's stream (`GET /connections/:id`) as a line. */
export function entryFreshness(
  stream: Pick<ConnectionFreshnessStream, "name" | "kind" | "period">,
  entry: FreshnessEntry,
  nextCheckAt: string | null,
): StreamFreshness {
  return {
    freshness: {
      kind: stream.kind,
      stream: stream.name,
      fetchedAt: entry.checkedAt,
      ...(stream.kind === "periodic"
        ? {
            ...(entry.dataThrough ? { dataThrough: entry.dataThrough } : {}),
            ...(stream.period === "month" ? { period: "month" as const } : {}),
            ...(entry.nextExpectedAt
              ? { nextExpectedAt: entry.nextExpectedAt }
              : {}),
            ...(entry.late ? { late: true as const } : {}),
          }
        : {}),
      ...(nextCheckAt ? { nextCheckAt } : {}),
    },
    overdue: entry.overdue,
  };
}

/**
 * A status board stream from a device payload (#727) as a line: the
 * server summarized it already; it names no next times when the source is
 * not scheduled.
 */
export function deviceStreamFreshness(
  stream: DeviceStatusStream,
): StreamFreshness {
  const { key: _key, overdue, ...freshness } = stream;
  return { freshness, overdue: overdue === true };
}

/**
 * Whether `a` is less fresh than `b`, as the server decides it for widgets:
 * an unknown day first, else the earlier day; on the same day the earlier
 * known next time (a known time wins over an unknown one).
 */
function lessFresh(a: FreshnessEntry, b: FreshnessEntry): boolean {
  if (a.dataThrough !== b.dataThrough) {
    if (a.dataThrough === null) return true;
    if (b.dataThrough === null) return false;
    return a.dataThrough < b.dataThrough;
  }
  const ea = a.nextExpectedAt === null ? null : Date.parse(a.nextExpectedAt);
  const eb = b.nextExpectedAt === null ? null : Date.parse(b.nextExpectedAt);
  if (ea === eb || ea === null) return false;
  if (eb === null) return true;
  return ea < eb;
}

/**
 * A connection's stream as one line, by the rule widgets and screens'
 * status boards follow (ADR 0025 section 7, #727), over every entry the
 * connection detail lists. The server already filtered those to the
 * selected resources' rows and the connection entry, a superset of the
 * rows screens use, so the line can understate but never claim fresher
 * data. The least fresh entry (the earliest day, ties broken by the
 * earliest next), late when any entry with that day is, overdue when any
 * entry is; fetched at the oldest check. Null before any run reported it.
 */
export function streamFreshness(
  stream: ConnectionFreshnessStream,
  nextCheckAt: string | null,
): StreamFreshness | null {
  const used = stream.entries;
  const [first, ...rest] = used;
  if (!first) return null;
  const least = rest.reduce(
    (worst, entry) => (lessFresh(entry, worst) ? entry : worst),
    first,
  );
  const same = used.filter((entry) => entry.dataThrough === least.dataThrough);
  const oldest = used.reduce(
    (min, entry) => (entry.checkedAt < min ? entry.checkedAt : min),
    first.checkedAt,
  );
  return entryFreshness(
    stream,
    {
      ...least,
      checkedAt: oldest,
      late: same.some((entry) => entry.late),
      overdue: used.some((entry) => entry.overdue),
    },
    nextCheckAt,
  );
}

/**
 * The least fresh of several widget freshness lines, by the rule the
 * server summarizes rows with (ADR 0025 section 7): periodic before
 * continuous; among periodic the earliest day (an unknown one first), ties
 * broken by the earliest known next time, late when any with that day is;
 * fetched at the oldest; the earliest next check. For a widget over two
 * queries (an unbound compare). Null without any.
 */
export function leastFresh(
  lines: readonly (WidgetFreshness | null | undefined)[],
): WidgetFreshness | null {
  const known = lines.filter((line): line is WidgetFreshness => !!line);
  const [first] = known;
  if (!first || known.length === 1) return first ?? null;
  const asEntry = (line: WidgetFreshness): FreshnessEntry => ({
    resource: null,
    dataThrough: line.dataThrough ?? null,
    nextExpectedAt: line.nextExpectedAt ?? null,
    checkedAt: line.fetchedAt,
    advancedAt: null,
    late: line.late ?? false,
    overdue: false,
  });
  const periodic = known.filter((line) => line.kind === "periodic");
  const chosen =
    periodic.length > 0
      ? periodic.reduce((least, line) =>
          lessFresh(asEntry(line), asEntry(least)) ? line : least,
        )
      : known.reduce((least, line) =>
          Date.parse(line.fetchedAt) < Date.parse(least.fetchedAt)
            ? line
            : least,
        );
  const late = periodic.some(
    (line) =>
      line.late &&
      chosen.kind === "periodic" &&
      line.dataThrough === chosen.dataThrough,
  );
  const fetchedAt = known.reduce(
    (min, line) =>
      Date.parse(line.fetchedAt) < Date.parse(min) ? line.fetchedAt : min,
    first.fetchedAt,
  );
  const nextCheckAt = known.reduce<string | null>(
    (min, line) =>
      line.nextCheckAt &&
      (min === null || Date.parse(line.nextCheckAt) < Date.parse(min))
        ? line.nextCheckAt
        : min,
    null,
  );
  const { late: _late, nextCheckAt: _check, ...rest } = chosen;
  return {
    ...rest,
    fetchedAt,
    ...(late ? { late: true as const } : {}),
    ...(nextCheckAt ? { nextCheckAt } : {}),
  };
}
