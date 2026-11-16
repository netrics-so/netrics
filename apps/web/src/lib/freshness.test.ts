import { describe, expect, it } from "vitest";

import type { WidgetFreshness } from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import {
  expectedWhen,
  freshnessCandidates,
  freshnessNotice,
  freshnessParts,
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
    expect(freshnessCandidates(freshness, clock("de"))).toEqual([
      "Bis 15. Nov. · abgerufen vor 10 Min. · nächste ~21:00",
      "Bis 15. Nov. · abgerufen vor 10 Min.",
      "Bis 15. Nov.",
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
