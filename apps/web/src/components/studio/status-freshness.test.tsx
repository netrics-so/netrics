import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectionFreshnessStream } from "@netrics/contracts";

import { renderI18n } from "@/lib/i18n/test-render";
import { streamFreshness, type StreamFreshness } from "@/lib/freshness";
import { statusWidgetLayout, type StatusItem } from "@/lib/studio-status";
import { ScrollStatusCard } from "@/components/scroll/scroll-widgets";

import { StatusWidgetView } from "./status-widget";

// The status board lists each source's streams (ADR 0025, #705): stream
// name, covered through, last fetch and next expected.

const NOW = Date.parse("2026-11-16T12:50:00Z");
const TEN_MIN_AGO = "2026-11-16T12:40:00Z";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const entry = (
  extra: Partial<ConnectionFreshnessStream["entries"][number]> = {},
): ConnectionFreshnessStream["entries"][number] => ({
  resource: null,
  dataThrough: "2026-11-15",
  nextExpectedAt: "2026-11-16T12:00:00Z",
  checkedAt: TEN_MIN_AGO,
  advancedAt: TEN_MIN_AGO,
  late: false,
  overdue: false,
  ...extra,
});

describe("streamFreshness: one line per stream", () => {
  it("is the least fresh entry: earliest day, then earliest next", () => {
    const summary = streamFreshness(
      {
        key: "analytics",
        name: "Analytics",
        kind: "periodic",
        period: "day",
        entries: [
          entry({ resource: "app-1", dataThrough: "2026-11-14" }),
          entry({
            resource: "app-2",
            dataThrough: "2026-11-13",
            nextExpectedAt: "2026-11-16T20:00:00Z",
            checkedAt: "2026-11-16T12:00:00Z",
          }),
          entry({
            resource: "app-3",
            dataThrough: "2026-11-13",
            nextExpectedAt: "2026-11-15T20:00:00Z",
            late: true,
          }),
        ],
      },
      "2026-11-16T13:30:00Z",
    );
    expect(summary).toEqual({
      freshness: {
        kind: "periodic",
        stream: "Analytics",
        fetchedAt: "2026-11-16T12:00:00Z",
        dataThrough: "2026-11-13",
        nextExpectedAt: "2026-11-15T20:00:00Z",
        late: true,
        nextCheckAt: "2026-11-16T13:30:00Z",
      },
      overdue: false,
    });
  });

  it("on the same day, a known next time wins over an unknown one, in any order", () => {
    const known = entry({
      resource: "app-1",
      nextExpectedAt: "2026-11-16T20:00:00Z",
    });
    const unknown = entry({ resource: "app-2", nextExpectedAt: null });
    const stream = (entries: (typeof known)[]): ConnectionFreshnessStream => ({
      key: "sales",
      name: "Sales",
      kind: "periodic",
      period: "day",
      entries,
    });
    for (const entries of [
      [unknown, known],
      [known, unknown],
    ])
      expect(
        streamFreshness(stream(entries), null)?.freshness.nextExpectedAt,
      ).toBe("2026-11-16T20:00:00Z");
  });

  it("monthly, continuous, overdue and empty streams", () => {
    expect(
      streamFreshness(
        {
          key: "earnings",
          name: "Earnings",
          kind: "periodic",
          period: "month",
          entries: [entry({ dataThrough: "2026-10-31", overdue: true })],
        },
        null,
      ),
    ).toMatchObject({
      freshness: { period: "month", dataThrough: "2026-10-31" },
      overdue: true,
    });
    expect(
      streamFreshness(
        {
          key: "reviews",
          name: "Reviews",
          kind: "continuous",
          period: "day",
          entries: [entry({ dataThrough: null, nextExpectedAt: null })],
        },
        "2026-11-16T13:30:00Z",
      ),
    ).toEqual({
      freshness: {
        kind: "continuous",
        stream: "Reviews",
        fetchedAt: TEN_MIN_AGO,
        nextCheckAt: "2026-11-16T13:30:00Z",
      },
      overdue: false,
    });
    expect(
      streamFreshness(
        {
          key: "sales",
          name: "Sales",
          kind: "periodic",
          period: "day",
          entries: [],
        },
        null,
      ),
    ).toBeNull();
  });
});

const sales: StreamFreshness = {
  freshness: {
    kind: "periodic",
    stream: "Sales",
    fetchedAt: TEN_MIN_AGO,
    dataThrough: "2026-11-15",
    nextExpectedAt: "2026-11-16T12:00:00Z",
  },
  overdue: false,
};
const reviews: StreamFreshness = {
  freshness: {
    kind: "continuous",
    stream: "Reviews",
    fetchedAt: TEN_MIN_AGO,
    nextCheckAt: "2026-11-16T12:49:00Z",
  },
  overdue: false,
};
const overdueSales: StreamFreshness = {
  freshness: {
    kind: "periodic",
    stream: "Sales",
    fetchedAt: TEN_MIN_AGO,
    dataThrough: "2026-11-14",
    nextExpectedAt: "2026-11-15T09:00:00Z",
    late: true,
  },
  overdue: true,
};

const items: StatusItem[] = [
  {
    connectionId: ID(1),
    name: "App Store Connect",
    status: "ok",
    lastSuccessAt: TEN_MIN_AGO,
  },
  {
    connectionId: ID(2),
    name: "Vercel",
    status: "ok",
    lastSuccessAt: TEN_MIN_AGO,
  },
];

const board = {
  label: "Sources",
  options: { showAge: true },
  items,
  streams: { [ID(1)]: [sales, reviews] },
  placement: { x: 0, y: 0, w: 8, h: 6 },
  showHeader: true,
  fontScale: 1,
};

/** The stream rows' texts. */
const streamRows = (html: string) =>
  [...html.matchAll(/class="sw-status-stream[^"]*"[^>]*>([^<]*)</g)].map(
    (match) => match[1]!.replace(/[\u202f\u00a0]/g, " "),
  );

describe("status board streams", () => {
  it("lists each source's streams under it when there is room", () => {
    const html = renderI18n(<StatusWidgetView {...board} />);
    expect(streamRows(html)).toEqual([
      "Sales up to Nov 15 · fetched 10 min. ago · next any minute",
      "Reviews checked 10 min. ago · next check any minute",
    ]);
    // Under its source, before the next one.
    expect(html.indexOf("App Store Connect")).toBeLessThan(
      html.indexOf("Sales up to"),
    );
    expect(html.indexOf("Reviews checked")).toBeLessThan(
      html.indexOf("Vercel"),
    );
    const de = renderI18n(<StatusWidgetView {...board} />, "de");
    expect(streamRows(de)[0]).toBe(
      "Sales bis 15. Nov. · abgerufen vor 10 Min. · nächste in Kürze",
    );
  });

  it("an overdue stream is in the warning style, with the late wording", () => {
    const html = renderI18n(
      <StatusWidgetView {...board} streams={{ [ID(1)]: [overdueSales] }} />,
    );
    expect(html).toContain('class="sw-status-stream stale"');
    expect(streamRows(html)).toEqual([
      "Sales up to Nov 14 · Nov 15 not published yet",
    ]);
  });

  it("sources keep their rows: streams only fill rows left over", () => {
    const layout = statusWidgetLayout({
      label: "Sources",
      items,
      streams: board.streams,
      showAge: true,
      placement: { x: 0, y: 0, w: 4, h: 2 },
      showHeader: true,
      fontScale: 1,
      now: NOW,
      locale: "en",
    });
    const rows = layout.rows.length;
    const streams = Object.values(layout.streams).flat().length;
    expect(rows).toBe(items.length);
    expect(rows + streams).toBeLessThanOrEqual(layout.status.rowCapacity);
    expect(layout.more).toBeNull();
  });

  it("a source that needs attention promises no next check", () => {
    const failing = [
      { ...items[0]!, status: "auth_failed" as const },
      items[1]!,
    ];
    const html = renderI18n(<StatusWidgetView {...board} items={failing} />);
    expect(streamRows(html)).toEqual([
      "Sales up to Nov 15 · fetched 10 min. ago",
      "Reviews checked 10 min. ago",
    ]);
    const card = renderI18n(
      <ScrollStatusCard {...board} items={failing} width={600} rootPx={16} />,
    );
    expect(streamRows(card)).toEqual([
      "Sales up to Nov 15 · fetched 10 min. ago",
      "Reviews checked 10 min. ago",
    ]);
  });

  it("without streams the board is as before", () => {
    const html = renderI18n(
      <StatusWidgetView {...board} streams={undefined} />,
    );
    expect(streamRows(html)).toEqual([]);
  });

  it("the scroll view's card lists them too", () => {
    const html = renderI18n(
      <ScrollStatusCard {...board} width={600} rootPx={16} />,
    );
    expect(streamRows(html)).toEqual([
      "Sales up to Nov 15 · fetched 10 min. ago · next any minute",
      "Reviews checked 10 min. ago · next check any minute",
    ]);
  });
});
