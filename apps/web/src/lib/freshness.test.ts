import { describe, expect, it } from "vitest";

import type { WidgetFreshness } from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import {
  expectedWhen,
  freshnessCandidates,
  freshnessNotice,
  freshnessParts,
  freshnessSourceForms,
  freshnessSourceLevels,
  plainTwin,
  reportingDayBeforeCheck,
  type FreshnessClock,
} from "./freshness";

// Intl separates "9:00" and "PM" with a narrow no-break space.
const plain = (text: string | null) => text?.replace(/\u202f/g, " ") ?? null;
const line = (parts: readonly string[]) => plain(parts.join(" · "));

const BERLIN = "Europe/Berlin";
const LOS_ANGELES = "America/Los_Angeles";
/** Monday, 16 Nov 2026, 13:50 in Berlin, 04:50 in Los Angeles. */
const NOW = Date.parse("2026-11-16T12:50:00Z");
const TEN_MIN_AGO = "2026-11-16T12:40:00Z";

function clock(
  locale: Locale,
  timeZone = BERLIN,
  now: number = NOW,
): FreshnessClock {
  return { locale, timeZone, now };
}

function periodic(extra: Partial<WidgetFreshness> = {}): WidgetFreshness {
  return {
    kind: "periodic",
    stream: "Sales",
    fetchedAt: TEN_MIN_AGO,
    dataThrough: "2026-11-15",
    ...extra,
  };
}

describe("freshness wording (ADR 0025 section 8)", () => {
  it("periodic with the next period known", () => {
    const freshness = periodic({ nextExpectedAt: "2026-11-16T20:00:00Z" });
    expect(line(freshnessParts(freshness, clock("en")))).toBe(
      "Up to Nov 15 · fetched 10 min. ago · next ~9:00 PM",
    );
    expect(line(freshnessParts(freshness, clock("de")))).toBe(
      "Bis 15. Nov. · abgerufen vor 10 Min. · nächste ~21:00",
    );
  });

  it("periodic without a next period", () => {
    const freshness = periodic({ dataThrough: "2026-11-13" });
    expect(line(freshnessParts(freshness, clock("en")))).toBe(
      "Up to Nov 13 · fetched 10 min. ago",
    );
    expect(line(freshnessParts(freshness, clock("de")))).toBe(
      "Bis 13. Nov. · abgerufen vor 10 Min.",
    );
  });

  it("a monthly stream names the month, with the year when not the current", () => {
    const freshness = periodic({
      dataThrough: "2026-10-31",
      period: "month",
      nextExpectedAt: "2026-11-30T09:00:00Z",
    });
    expect(line(freshnessParts(freshness, clock("en")))).toBe(
      "Up to October · fetched 10 min. ago · next ~Nov 30",
    );
    expect(line(freshnessParts(freshness, clock("de")))).toBe(
      "Bis Oktober · abgerufen vor 10 Min. · nächste ~30. Nov.",
    );
    const lastYear = periodic({ dataThrough: "2025-12-31", period: "month" });
    expect(line(freshnessParts(lastYear, clock("en")))).toBe(
      "Up to December 2025 · fetched 10 min. ago",
    );
    expect(line(freshnessParts(lastYear, clock("de")))).toBe(
      "Bis Dezember 2025 · abgerufen vor 10 Min.",
    );
  });

  it("a late provider: not published yet, checking again", () => {
    const freshness = periodic({
      dataThrough: "2026-11-14",
      nextExpectedAt: "2026-11-15T20:00:00Z",
      late: true,
      nextCheckAt: "2026-11-16T14:10:00Z",
    });
    expect(line(freshnessParts(freshness, clock("en")))).toBe(
      "Up to Nov 14 · Nov 15 not published yet · checking again ~3:10 PM",
    );
    expect(line(freshnessParts(freshness, clock("de")))).toBe(
      "Bis 14. Nov. · 15. Nov. noch nicht veröffentlicht · erneut prüfen ~15:10",
    );
    // A late month names the next month; a check already due is "any minute".
    const month = periodic({
      dataThrough: "2026-09-30",
      period: "month",
      late: true,
      nextCheckAt: "2026-11-16T12:45:00Z",
    });
    expect(line(freshnessParts(month, clock("en")))).toBe(
      "Up to September · October not published yet · checking again any minute",
    );
    expect(line(freshnessParts(month, clock("de")))).toBe(
      "Bis September · Oktober noch nicht veröffentlicht · erneut prüfen in Kürze",
    );
  });

  it("continuous streams", () => {
    const freshness: WidgetFreshness = {
      kind: "continuous",
      stream: "Reviews",
      fetchedAt: TEN_MIN_AGO,
      nextCheckAt: "2026-11-16T13:30:00Z",
    };
    expect(line(freshnessParts(freshness, clock("en")))).toBe(
      "Checked 10 min. ago · next check ~2:30 PM",
    );
    expect(line(freshnessParts(freshness, clock("de")))).toBe(
      "Geprüft vor 10 Min. · nächste Prüfung ~14:30",
    );
    const due = { ...freshness, nextCheckAt: "2026-11-16T12:49:00Z" };
    expect(line(freshnessParts(due, clock("en")))).toBe(
      "Checked 10 min. ago · next check any minute",
    );
    expect(line(freshnessParts(due, clock("de")))).toBe(
      "Geprüft vor 10 Min. · nächste Prüfung in Kürze",
    );
  });

  it("an expected time already past and not late reads 'next any minute'", () => {
    const freshness = periodic({ nextExpectedAt: "2026-11-16T12:00:00Z" });
    expect(line(freshnessParts(freshness, clock("en")))).toBe(
      "Up to Nov 15 · fetched 10 min. ago · next any minute",
    );
    expect(line(freshnessParts(freshness, clock("de")))).toBe(
      "Bis 15. Nov. · abgerufen vor 10 Min. · nächste in Kürze",
    );
  });

  it("a fetch a day or more ago is a date", () => {
    const freshness = periodic({ fetchedAt: "2026-11-14T08:00:00Z" });
    expect(line(freshnessParts(freshness, clock("en")))).toBe(
      "Up to Nov 15 · fetched Nov 14",
    );
    expect(line(freshnessParts(freshness, clock("de")))).toBe(
      "Bis 15. Nov. · abgerufen am 14. Nov.",
    );
    const continuous: WidgetFreshness = {
      kind: "continuous",
      stream: "Reviews",
      fetchedAt: "2026-11-14T08:00:00Z",
    };
    expect(line(freshnessParts(continuous, clock("de")))).toBe(
      "Geprüft am 14. Nov.",
    );
  });

  it("dataThrough is the provider's day, the same in every viewer zone", () => {
    const freshness = periodic({ nextExpectedAt: "2026-11-16T20:00:00Z" });
    // 12:00 in Los Angeles: the same instant, the viewer's clock.
    expect(line(freshnessParts(freshness, clock("en", LOS_ANGELES)))).toBe(
      "Up to Nov 15 · fetched 10 min. ago · next ~12:00 PM",
    );
    expect(line(freshnessParts(freshness, clock("de", LOS_ANGELES)))).toBe(
      "Bis 15. Nov. · abgerufen vor 10 Min. · nächste ~12:00",
    );
  });
});

describe("expectedWhen: today, tomorrow, weekday, date", () => {
  const when = (iso: string, c: FreshnessClock) => plain(expectedWhen(iso, c));

  it.each([
    // [instant, en Berlin, de Berlin]
    ["2026-11-16T20:00:00Z", "~9:00 PM", "~21:00"],
    // Local midnight is the boundary, not 24 hours.
    ["2026-11-16T22:59:00Z", "~11:59 PM", "~23:59"],
    ["2026-11-16T23:00:00Z", "tomorrow ~12:00 AM", "morgen ~00:00"],
    ["2026-11-17T08:00:00Z", "tomorrow ~9:00 AM", "morgen ~09:00"],
    ["2026-11-18T08:00:00Z", "Wed ~9:00 AM", "Mi ~09:00"],
    // Six days ahead is still within the week.
    ["2026-11-22T08:00:00Z", "Sun ~9:00 AM", "So ~09:00"],
    ["2026-11-23T08:00:00Z", "~Nov 23", "~23. Nov."],
  ])("%s in Berlin", (iso, en, de) => {
    expect(when(iso, clock("en"))).toBe(en);
    expect(when(iso, clock("de"))).toBe(de);
  });

  it("the same instant is today in Berlin and tomorrow in Los Angeles", () => {
    // 08:30 on Monday in Berlin; 23:30 on Sunday in Los Angeles.
    const now = Date.parse("2026-11-16T07:30:00Z");
    const iso = "2026-11-16T20:00:00Z";
    expect(when(iso, clock("en", BERLIN, now))).toBe("~9:00 PM");
    expect(when(iso, clock("en", LOS_ANGELES, now))).toBe("tomorrow ~12:00 PM");
    expect(when(iso, clock("de", LOS_ANGELES, now))).toBe("morgen ~12:00");
  });

  it("an instant already past is null (the caller says 'any minute')", () => {
    expect(expectedWhen("2026-11-16T12:49:00Z", clock("en"))).toBeNull();
  });

  it("across the end of daylight saving time in Berlin", () => {
    // Saturday 24 Oct 2026, 22:00 CEST; the clocks go back on Sunday.
    const now = Date.parse("2026-10-24T20:00:00Z");
    // 26.5 hours later, Sunday 23:30 CET: still tomorrow.
    expect(when("2026-10-25T22:30:00Z", clock("en", BERLIN, now))).toBe(
      "tomorrow ~11:30 PM",
    );
    expect(when("2026-10-25T22:30:00Z", clock("de", BERLIN, now))).toBe(
      "morgen ~23:30",
    );
    // 12:00 UTC is 14:00 CEST before and 13:00 CET after the change.
    expect(when("2026-10-24T21:00:00Z", clock("de", BERLIN, now))).toBe(
      "~23:00",
    );
    expect(when("2026-10-25T12:00:00Z", clock("de", BERLIN, now))).toBe(
      "morgen ~13:00",
    );
  });

  it("across the end of daylight saving time in Los Angeles", () => {
    // Saturday 31 Oct 2026, 00:30 PDT; standard time from Sunday 02:00.
    const now = Date.parse("2026-10-31T07:30:00Z");
    expect(when("2026-10-31T19:00:00Z", clock("en", LOS_ANGELES, now))).toBe(
      "~12:00 PM",
    );
    // 20:00 UTC on Sunday is 12:00 PST, not 13:00 PDT.
    expect(when("2026-11-01T20:00:00Z", clock("en", LOS_ANGELES, now))).toBe(
      "tomorrow ~12:00 PM",
    );
  });
});

describe("narrow widgets and lists", () => {
  it("candidates drop parts from the end, longest first", () => {
    const freshness = periodic({ nextExpectedAt: "2026-11-16T20:00:00Z" });
    // The day is older than the day of the check (#791): each candidate
    // with the day named right before the same one as it was.
    expect(freshnessCandidates(freshness, clock("de"))).toEqual([
      "Letzter Berichtstag: 15. Nov. · abgerufen vor 10 Min. · nächste ~21:00",
      "Bis 15. Nov. · abgerufen vor 10 Min. · nächste ~21:00",
      "Letzter Berichtstag: 15. Nov. · abgerufen vor 10 Min.",
      "Bis 15. Nov. · abgerufen vor 10 Min.",
      "Letzter Berichtstag: 15. Nov.",
      "Bis 15. Nov.",
    ]);
    // A list that names the stream stays as it was.
    expect(
      freshnessCandidates(freshness, clock("de"), { stream: true }),
    ).toEqual([
      "Sales bis 15. Nov. · abgerufen vor 10 Min. · nächste ~21:00",
      "Sales bis 15. Nov. · abgerufen vor 10 Min.",
      "Sales bis 15. Nov.",
    ]);
  });

  it("lists prefix the stream name", () => {
    const sales = periodic({ nextExpectedAt: "2026-11-16T20:00:00Z" });
    expect(
      line(
        freshnessParts(sales, clock("en"), { stream: true, fetched: false }),
      ),
    ).toBe("Sales up to Nov 15 · next ~9:00 PM");
    expect(
      line(
        freshnessParts(sales, clock("de"), { stream: true, fetched: false }),
      ),
    ).toBe("Sales bis 15. Nov. · nächste ~21:00");
    const reviews: WidgetFreshness = {
      kind: "continuous",
      stream: "Reviews",
      fetchedAt: TEN_MIN_AGO,
      nextCheckAt: "2026-11-16T13:30:00Z",
    };
    expect(line(freshnessParts(reviews, clock("en"), { stream: true }))).toBe(
      "Reviews checked 10 min. ago · next check ~2:30 PM",
    );
    expect(line(freshnessParts(reviews, clock("de"), { stream: true }))).toBe(
      "Reviews geprüft vor 10 Min. · nächste Prüfung ~14:30",
    );
  });
});

describe("warnings first (precedence 1)", () => {
  const late = periodic({
    dataThrough: "2026-11-14",
    nextExpectedAt: "2026-11-15T09:00:00Z",
    late: true,
    nextCheckAt: "2026-11-16T14:10:00Z",
  });

  it("a warning keeps only the covered day, and drops 'next'", () => {
    const freshness = periodic({ nextExpectedAt: "2026-11-16T20:00:00Z" });
    expect(freshnessParts(freshness, clock("en"), { warning: true })).toEqual([
      "Up to Nov 15",
    ]);
    expect(freshnessParts(late, clock("en"), { warning: true })).toEqual([
      "Up to Nov 14",
      "Nov 15 not published yet",
    ]);
    const continuous: WidgetFreshness = {
      kind: "continuous",
      stream: "Reviews",
      fetchedAt: TEN_MIN_AGO,
    };
    expect(freshnessParts(continuous, clock("en"), { warning: true })).toEqual(
      [],
    );
  });

  it("an overdue provider is the stale warning in the late wording", () => {
    expect(
      freshnessNotice("Last sync 2 hr. ago", "stale", late, clock("en")),
    ).toBe("Up to Nov 14 · Nov 15 not published yet");
    expect(
      freshnessNotice("Zuletzt synchronisiert", "stale", late, clock("de")),
    ).toBe("Bis 14. Nov. · 15. Nov. noch nicht veröffentlicht");
  });

  it("a failing connection keeps its notice and adds the covered day", () => {
    const freshness = periodic({ nextExpectedAt: "2026-11-16T20:00:00Z" });
    expect(
      freshnessNotice("Source unreachable", "outage", freshness, clock("en")),
    ).toBe("Source unreachable · Up to Nov 15");
    expect(
      freshnessNotice("Last sync 3 hr. ago", "stale", freshness, clock("en")),
    ).toBe("Last sync 3 hr. ago · Up to Nov 15");
  });

  it("without a warning, or without freshness, the notice is unchanged", () => {
    expect(freshnessNotice(null, "ok", late, clock("en"))).toBeNull();
    expect(
      freshnessNotice("Source unreachable", "outage", undefined, clock("en")),
    ).toBe("Source unreachable");
  });
});

describe("freshness per source (#784)", () => {
  const twoStores = (extra: Partial<WidgetFreshness> = {}): WidgetFreshness =>
    periodic({
      dataThrough: "2026-11-11",
      sources: [
        {
          source: "App Store",
          kind: "periodic",
          stream: "Sales",
          fetchedAt: TEN_MIN_AGO,
          dataThrough: "2026-11-15",
          // 21:00 in Berlin.
          nextExpectedAt: "2026-11-16T20:00:00Z",
        },
        {
          source: "Google Play",
          kind: "periodic",
          stream: "Installs",
          fetchedAt: TEN_MIN_AGO,
          dataThrough: "2026-11-11",
        },
      ],
      ...extra,
    });

  it("lists every source, longest form first, then degrades", () => {
    expect(
      freshnessSourceForms(twoStores(), clock("de")).map((form) =>
        form.lines.map(plain),
      ),
    ).toEqual([
      [
        "App Store bis 15. Nov. · nächste ~21:00 · Google Play bis 11. Nov. · abgerufen vor 10 Min.",
      ],
      ["App Store bis 15. Nov. · nächste ~21:00 · Google Play bis 11. Nov."],
      ["App Store bis 15. Nov. · Google Play bis 11. Nov."],
      ["App Store bis 15.11. · Google Play bis 11.11."],
      ["App Store 15.11. · Google Play 11.11."],
      ["App Store bis 15.11.", "Google Play bis 11.11."],
    ]);
    expect(
      freshnessSourceForms(twoStores(), clock("en")).map((form) =>
        form.lines.map(plain),
      ),
    ).toEqual([
      [
        "App Store up to Nov 15 · next ~9:00 PM · Google Play up to Nov 11 · fetched 10 min. ago",
      ],
      ["App Store up to Nov 15 · next ~9:00 PM · Google Play up to Nov 11"],
      ["App Store up to Nov 15 · Google Play up to Nov 11"],
      ["App Store up to 11/15 · Google Play up to 11/11"],
      ["App Store 11/15 · Google Play 11/11"],
      ["App Store up to 11/15", "Google Play up to 11/11"],
    ]);
  });

  it("keeps only the days under a warning, and a late source's note", () => {
    const late = twoStores();
    late.sources![1] = {
      ...late.sources![1]!,
      late: true,
      nextExpectedAt: "2026-11-16T08:00:00Z",
    };
    expect(
      freshnessSourceForms(late, clock("en"), {
        warning: true,
      })[0]!.lines.map(plain),
    ).toEqual([
      "App Store up to Nov 15 · Google Play up to Nov 11 · Nov 12 not published yet",
    ]);
  });

  it("names a continuous source by its check", () => {
    const mixed = twoStores();
    mixed.sources![1] = {
      source: "Vercel",
      kind: "continuous",
      stream: "Traffic",
      fetchedAt: TEN_MIN_AGO,
    };
    expect(plain(freshnessSourceForms(mixed, clock("en"))[2]!.lines[0]!)).toBe(
      "App Store up to Nov 15 · Vercel checked 10 min. ago",
    );
    // Only the store's day is named (#791); Vercel has no reporting day.
    expect(plain(freshnessSourceForms(mixed, clock("en"))[2]!.named![0]!)).toBe(
      "App Store last reporting day: Nov 15 · Vercel checked 10 min. ago",
    );
  });

  it("has no forms for one source", () => {
    expect(freshnessSourceLevels(periodic(), clock("en"))).toEqual([]);
  });
});

// #791: on 19 Nov the App Store's reports reach 17 Nov and Google Play's
// 11 Nov, both checked minutes ago. "Up to Nov 11" alone reads as if
// netrics had not checked since; the day is named where a tile has room.
describe("last reporting day (#791)", () => {
  /** Thursday, 19 Nov 2026, 10:00 in Berlin. */
  const NOV_19 = Date.parse("2026-11-19T09:00:00Z");
  const CHECKED = "2026-11-19T08:50:00Z";
  const at = (locale: Locale, timeZone = BERLIN) =>
    clock(locale, timeZone, NOV_19);
  const appStore: WidgetFreshness = {
    kind: "periodic",
    stream: "Sales",
    fetchedAt: CHECKED,
    dataThrough: "2026-11-17",
    // 21:00 in Berlin.
    nextExpectedAt: "2026-11-19T20:00:00Z",
  };
  const play: WidgetFreshness = {
    kind: "periodic",
    stream: "Installs",
    fetchedAt: CHECKED,
    dataThrough: "2026-11-11",
  };
  const lines = (candidates: string[]) => candidates.map(plain);

  it("App Store: reports up to 17 Nov, checked on 19 Nov", () => {
    expect(lines(freshnessCandidates(appStore, at("en")))).toEqual([
      "Last reporting day: Nov 17 · fetched 10 min. ago · next ~9:00 PM",
      "Up to Nov 17 · fetched 10 min. ago · next ~9:00 PM",
      "Last reporting day: Nov 17 · fetched 10 min. ago",
      "Up to Nov 17 · fetched 10 min. ago",
      "Last reporting day: Nov 17",
      "Up to Nov 17",
    ]);
    expect(lines(freshnessCandidates(appStore, at("de")))).toEqual([
      "Letzter Berichtstag: 17. Nov. · abgerufen vor 10 Min. · nächste ~21:00",
      "Bis 17. Nov. · abgerufen vor 10 Min. · nächste ~21:00",
      "Letzter Berichtstag: 17. Nov. · abgerufen vor 10 Min.",
      "Bis 17. Nov. · abgerufen vor 10 Min.",
      "Letzter Berichtstag: 17. Nov.",
      "Bis 17. Nov.",
    ]);
  });

  it("Google Play: reports up to 11 Nov, checked on 19 Nov", () => {
    expect(lines(freshnessCandidates(play, at("en")))).toEqual([
      "Last reporting day: Nov 11 · fetched 10 min. ago",
      "Up to Nov 11 · fetched 10 min. ago",
      "Last reporting day: Nov 11",
      "Up to Nov 11",
    ]);
    expect(lines(freshnessCandidates(play, at("de")))).toEqual([
      "Letzter Berichtstag: 11. Nov. · abgerufen vor 10 Min.",
      "Bis 11. Nov. · abgerufen vor 10 Min.",
      "Letzter Berichtstag: 11. Nov.",
      "Bis 11. Nov.",
    ]);
  });

  it("a day that is the day of the check leaves the line as it was", () => {
    // A source whose reports reach today (an ad account's running day).
    const today: WidgetFreshness = {
      ...appStore,
      stream: "Ads",
      dataThrough: "2026-11-19",
    };
    for (const locale of ["en", "de"] as const) {
      expect(reportingDayBeforeCheck(today, at(locale))).toBe(false);
      const parts = freshnessParts(today, at(locale));
      expect(freshnessCandidates(today, at(locale))).toEqual(
        parts.map((_, index) =>
          parts.slice(0, parts.length - index).join(" · "),
        ),
      );
      expect(freshnessParts(today, at(locale), { reportingDay: true })).toEqual(
        parts,
      );
    }
    expect(lines(freshnessCandidates(today, at("en")))).toEqual([
      "Up to Nov 19 · fetched 10 min. ago · next ~9:00 PM",
      "Up to Nov 19 · fetched 10 min. ago",
      "Up to Nov 19",
    ]);
    expect(lines(freshnessCandidates(today, at("de")))).toEqual([
      "Bis 19. Nov. · abgerufen vor 10 Min. · nächste ~21:00",
      "Bis 19. Nov. · abgerufen vor 10 Min.",
      "Bis 19. Nov.",
    ]);
  });

  it("compares the provider's day with the check's day where the viewer is", () => {
    // Checked at 08:50 UTC on 19 Nov: still 18 Nov in Honolulu.
    const yesterday = { ...appStore, dataThrough: "2026-11-18" };
    expect(reportingDayBeforeCheck(yesterday, at("en", BERLIN))).toBe(true);
    expect(
      reportingDayBeforeCheck(yesterday, at("en", "Pacific/Honolulu")),
    ).toBe(false);
    // A check days ago: the day of that check counts, not today.
    expect(
      reportingDayBeforeCheck(
        { ...appStore, fetchedAt: "2026-11-17T10:00:00Z" },
        at("en"),
      ),
    ).toBe(false);
  });

  it("is not for months, continuous streams or a stream without a day", () => {
    const monthly: WidgetFreshness = {
      ...play,
      dataThrough: "2026-10-31",
      period: "month",
    };
    expect(lines(freshnessCandidates(monthly, at("en")))).toEqual([
      "Up to October · fetched 10 min. ago",
      "Up to October",
    ]);
    const continuous: WidgetFreshness = {
      kind: "continuous",
      stream: "Traffic",
      fetchedAt: CHECKED,
    };
    expect(lines(freshnessCandidates(continuous, at("en")))).toEqual([
      "Checked 10 min. ago",
    ]);
    const { dataThrough: _day, ...noDay } = play;
    expect(lines(freshnessCandidates(noDay, at("en")))).toEqual([
      "fetched 10 min. ago",
    ]);
  });

  it("late and under a warning the day is named the same way", () => {
    const late: WidgetFreshness = {
      ...appStore,
      late: true,
      nextExpectedAt: "2026-11-18T20:00:00Z",
      nextCheckAt: "2026-11-19T09:20:00Z",
    };
    expect(lines(freshnessCandidates(late, at("en")))).toEqual([
      "Last reporting day: Nov 17 · Nov 18 not published yet · checking again ~10:20 AM",
      "Up to Nov 17 · Nov 18 not published yet · checking again ~10:20 AM",
      "Last reporting day: Nov 17 · Nov 18 not published yet",
      "Up to Nov 17 · Nov 18 not published yet",
      "Last reporting day: Nov 17",
      "Up to Nov 17",
    ]);
    expect(
      lines(freshnessCandidates(appStore, at("de"), { warning: true })),
    ).toEqual(["Letzter Berichtstag: 17. Nov.", "Bis 17. Nov."]);
    // The warning notice keeps its words.
    expect(
      freshnessNotice("Source unreachable", "outage", appStore, at("en")),
    ).toBe("Source unreachable · Up to Nov 17");
  });

  it("knows the plain line a named footer falls back to when drawn cut", () => {
    for (const locale of ["en", "de"] as const) {
      const candidates = freshnessCandidates(appStore, at(locale));
      // Each named candidate: the same parts right after it.
      expect(plainTwin(candidates, candidates[0]!, locale)).toBe(candidates[1]);
      expect(plainTwin(candidates, candidates[4]!, locale)).toBe(candidates[5]);
      // A plain one has none, nor has a line that is not a candidate.
      expect(plainTwin(candidates, candidates[1]!, locale)).toBeNull();
      expect(plainTwin(candidates, candidates[5]!, locale)).toBeNull();
      expect(plainTwin(candidates, null, locale)).toBeNull();
      expect(plainTwin([], candidates[0]!, locale)).toBeNull();
    }
    // A footer without freshness never falls back to its shorter form.
    const updated = [
      "updated 2 min. ago · Stripe",
      "updated 2 min. ago",
      "Stripe",
    ];
    for (const line of updated)
      expect(plainTwin(updated, line, "en")).toBeNull();
  });

  const product: WidgetFreshness = {
    ...play,
    sources: [
      { source: "App Store", ...appStore },
      { source: "Google Play", ...play },
    ],
  };

  it("a product slide over both stores names each store's day", () => {
    expect(
      freshnessSourceLevels(product, at("en")).map((level) => level.map(plain)),
    ).toEqual([
      [
        "App Store last reporting day: Nov 17 · next ~9:00 PM · Google Play last reporting day: Nov 11 · fetched 10 min. ago",
      ],
      [
        "App Store up to Nov 17 · next ~9:00 PM · Google Play up to Nov 11 · fetched 10 min. ago",
      ],
      [
        "App Store last reporting day: Nov 17 · next ~9:00 PM · Google Play last reporting day: Nov 11",
      ],
      ["App Store up to Nov 17 · next ~9:00 PM · Google Play up to Nov 11"],
      [
        "App Store last reporting day: Nov 17 · Google Play last reporting day: Nov 11",
      ],
      ["App Store up to Nov 17 · Google Play up to Nov 11"],
      ["App Store up to 11/17 · Google Play up to 11/11"],
      ["App Store 11/17 · Google Play 11/11"],
      ["App Store up to 11/17", "Google Play up to 11/11"],
    ]);
    expect(
      freshnessSourceLevels(product, at("de")).map((level) => level.map(plain)),
    ).toEqual([
      [
        "App Store letzter Berichtstag: 17. Nov. · nächste ~21:00 · Google Play letzter Berichtstag: 11. Nov. · abgerufen vor 10 Min.",
      ],
      [
        "App Store bis 17. Nov. · nächste ~21:00 · Google Play bis 11. Nov. · abgerufen vor 10 Min.",
      ],
      [
        "App Store letzter Berichtstag: 17. Nov. · nächste ~21:00 · Google Play letzter Berichtstag: 11. Nov.",
      ],
      ["App Store bis 17. Nov. · nächste ~21:00 · Google Play bis 11. Nov."],
      [
        "App Store letzter Berichtstag: 17. Nov. · Google Play letzter Berichtstag: 11. Nov.",
      ],
      ["App Store bis 17. Nov. · Google Play bis 11. Nov."],
      ["App Store bis 17.11. · Google Play bis 11.11."],
      ["App Store 17.11. · Google Play 11.11."],
      ["App Store bis 17.11.", "Google Play bis 11.11."],
    ]);
  });

  it("names only the sources whose day is older than their check", () => {
    const mixed: WidgetFreshness = {
      ...play,
      sources: [
        { source: "Apple Ads", ...appStore, dataThrough: "2026-11-19" },
        { source: "Google Play", ...play },
      ],
    };
    expect(plain(freshnessSourceForms(mixed, at("en"))[2]!.named![0]!)).toBe(
      "Apple Ads up to Nov 19 · Google Play last reporting day: Nov 11",
    );
    // No source's day is older: the forms are the ones before, alone.
    const same: WidgetFreshness = {
      ...play,
      dataThrough: "2026-11-19",
      sources: [
        { source: "Apple Ads", ...appStore, dataThrough: "2026-11-19" },
        { source: "Google Play", ...play, dataThrough: "2026-11-19" },
      ],
    };
    const forms = freshnessSourceForms(same, at("en"));
    expect(forms.every((form) => form.named === undefined)).toBe(true);
    expect(freshnessSourceLevels(same, at("en"))).toEqual(
      forms.map((form) => form.lines),
    );
    expect(plain(forms[0]!.lines[0]!)).toBe(
      "Apple Ads up to Nov 19 · next ~9:00 PM · Google Play up to Nov 19 · fetched 10 min. ago",
    );
  });
});
