import { describe, expect, it } from "vitest";

import type { ConnectionFreshnessStream } from "@netrics/contracts";

import { freshnessLines } from "./connection-freshness";

// The connection page lists its streams (ADR 0025 section 8, #705).

const NOW = Date.parse("2026-11-16T12:50:00Z");
const TEN_MIN_AGO = "2026-11-16T12:40:00Z";

const entry = (
  extra: Partial<ConnectionFreshnessStream["entries"][number]> = {},
): ConnectionFreshnessStream["entries"][number] => ({
  resource: null,
  dataThrough: "2026-11-15",
  nextExpectedAt: "2026-11-16T20:00:00Z",
  checkedAt: TEN_MIN_AGO,
  advancedAt: TEN_MIN_AGO,
  late: false,
  overdue: false,
  ...extra,
});

const streams: ConnectionFreshnessStream[] = [
  {
    key: "sales",
    name: "Sales",
    kind: "periodic",
    period: "day",
    entries: [entry()],
  },
  {
    key: "analytics",
    name: "Analytics",
    kind: "periodic",
    period: "day",
    entries: [
      entry({
        resource: "2",
        dataThrough: "2026-11-13",
        nextExpectedAt: "2026-11-15T20:00:00Z",
        late: true,
        overdue: true,
      }),
      entry({ resource: "1", dataThrough: "2026-11-14" }),
    ],
  },
  {
    key: "reviews",
    name: "Reviews",
    kind: "continuous",
    period: "day",
    entries: [entry({ dataThrough: null, nextExpectedAt: null })],
  },
  {
    key: "listing_ratings",
    name: "Listing ratings",
    kind: "continuous",
    period: "day",
    entries: [],
  },
];

const plain = (text: string) => text.replace(/\u202f/g, " ");

describe("connection page freshness", () => {
  it("names each stream, per app, in the viewer's zone (en)", () => {
    const lines = freshnessLines(
      streams,
      "2026-11-16T13:30:00Z",
      { "1": "Wurfel", "2": "Paperstand" },
      { locale: "en", now: NOW, timeZone: "Europe/Berlin" },
    );
    expect(
      lines.map((line) => [line.resource, plain(line.text), line.overdue]),
    ).toEqual([
      [null, "Sales up to Nov 15 · next ~9:00 PM", false],
      ["Paperstand", "Analytics up to Nov 13 · Nov 14 not published yet", true],
      ["Wurfel", "Analytics up to Nov 14 · next ~9:00 PM", false],
      [null, "Reviews checked 10 min. ago · next check ~2:30 PM", false],
      [null, "Listing ratings not checked yet", false],
    ]);
  });

  it("promises no next check while the connection needs reconnecting", () => {
    const lateSales: ConnectionFreshnessStream = {
      ...streams[0]!,
      entries: [
        entry({
          dataThrough: "2026-11-14",
          nextExpectedAt: "2026-11-15T20:00:00Z",
          late: true,
        }),
      ],
    };
    for (const authState of ["auth_failed", "needs_reauthorization"] as const) {
      const lines = freshnessLines(
        [lateSales, streams[0]!, streams[2]!],
        // Still set: the scheduler skips the connection without clearing it.
        "2026-11-16T12:00:00Z",
        {},
        { locale: "en", now: NOW, timeZone: "Europe/Berlin" },
        authState,
      );
      expect(lines.map((line) => plain(line.text))).toEqual([
        "Sales up to Nov 14 · Nov 15 not published yet",
        "Sales up to Nov 15",
        "Reviews checked 10 min. ago",
      ]);
    }
  });

  it("in German, in Los Angeles", () => {
    const lines = freshnessLines(
      streams.slice(0, 1),
      null,
      {},
      { locale: "de", now: NOW, timeZone: "America/Los_Angeles" },
    );
    expect(lines.map((line) => line.text)).toEqual([
      "Sales bis 15. Nov. · nächste ~12:00",
    ]);
  });
});
