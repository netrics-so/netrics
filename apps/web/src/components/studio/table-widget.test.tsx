import { describe, expect, it } from "vitest";

import type { DeviceWidget } from "@netrics/contracts";

import { renderI18n } from "@/lib/i18n/test-render";
import { rowRiseProgress } from "@/lib/enter-motion";
import { tableWidgetLayout, type TableReading } from "@/lib/studio-table";
import { ScrollTableCard } from "@/components/scroll/scroll-widgets";

import { DeviceWidgetView, deviceTableReading } from "./device-widget";
import { TableWidgetView } from "./table-widget";

// The table widget (ADR 0019 section 6, #332).

/** Every font size the markup sets, in units. */
function fontSizes(html: string): number[] {
  return [...html.matchAll(/font-size:calc\(var\(--u\) \* ([\d.]+)\)/g)].map(
    (match) => Number(match[1]),
  );
}

const routes = [
  "/pricing",
  "/",
  "/blog/how-we-built-a-dashboard-for-the-office-tv-and-why",
  "/docs",
  "/changelog",
  "/about",
  "/careers",
  "/legal",
];

const reading = (rows = 8): TableReading => ({
  unit: "count",
  better: "higher",
  columns: { label: "Route", value: "Page views" },
  rows: routes.slice(0, rows).map((label, index) => {
    const value = 8120 - index * 900;
    // Up 12 %, then less each row; row 2 is new, row 3 grew from zero.
    const previousValue =
      index === 2 ? null : index === 3 ? 0 : value / (1.12 - index * 0.05);
    return {
      label,
      value,
      previousValue,
      ratio: previousValue ? (value - previousValue) / previousValue : null,
    };
  }),
  others: null,
});

const props = {
  label: "Page views",
  period: "last_30_days" as const,
  options: { limit: 5, showChange: true, showOthers: false },
  reading: reading(),
  notice: null,
  placement: { x: 0, y: 0, w: 4, h: 4 },
  showHeader: true,
  fontScale: 1,
};

const labels = (html: string) =>
  [...html.matchAll(/class="sw-table-label"[^>]*>([^<]*)</g)].map(
    (match) => match[1],
  );

describe("table widget", () => {
  it("shows the top rows with column heads, values and the change", () => {
    const html = renderI18n(<TableWidgetView {...props} />);
    expect(html).toContain("Top 5 · Last 30 days");
    expect(html).toContain(">Route</span>");
    expect(html).toContain(">Page views</span>");
    expect(html).toContain(">Δ</span>");
    expect(labels(html)).toEqual(routes.slice(0, 5));
    expect(html).toContain(">8,120</span>");
    // +12 % in the good colour, "new" without a previous value or
    // against zero, a fall in the bad colour.
    expect(html).toContain('class="sw-table-change sw-change good">+12%<');
    expect(html.match(/>new</g)).toHaveLength(2);
    expect(html).toContain('class="sw-table-change sw-change bad">−8%<');
    // Rows rise on slide enter, in order.
    expect(html).toContain('data-rise="0"');
    expect(html).toContain('data-rise="4"');
    expect(Math.min(...fontSizes(html))).toBeGreaterThanOrEqual(24);
  });

  it("shows the rows that fit at font scale 1.3 and says how many", () => {
    const html = renderI18n(
      <TableWidgetView
        {...props}
        options={{ ...props.options, limit: 8 }}
        fontScale={1.3}
      />,
    );
    expect(html).toContain("Top 4 · Last 30 days");
    expect(labels(html)).toHaveLength(4);
  });

  it("shrinks a long row label, then ends it with an ellipsis", () => {
    const layout = tableWidgetLayout({
      ...props,
      limit: 5,
      showChange: true,
      locale: "en",
    });
    const long = layout.rows[2]!;
    expect(long.truncated).toBe(true);
    expect(long.labelSize).toBeCloseTo(24, 9);
    expect(layout.rows[0]).toMatchObject({ labelSize: 28, truncated: false });
    const html = renderI18n(<TableWidgetView {...props} />);
    expect(html).toContain('data-truncated="true"');
    expect(html).toContain(`title="${routes[2]}"`);
  });

  it("drops the Δ column without showChange and adds Others when asked", () => {
    const html = renderI18n(
      <TableWidgetView
        {...props}
        options={{ limit: 3, showChange: false, showOthers: true }}
        reading={{ ...reading(3), others: { label: "Others", value: 2015 } }}
      />,
    );
    expect(html).not.toContain("sw-table-change");
    expect(html).not.toContain(">Δ<");
    expect(labels(html)).toEqual([...routes.slice(0, 3), "Others"]);
    expect(html).toContain('class="sw-table-row others"');
    expect(html).toContain("Top 3 · Last 30 days");
  });

  it("speaks German", () => {
    const html = renderI18n(<TableWidgetView {...props} />, "de");
    expect(html).toContain("Top 5 · Letzte 30 Tage");
    expect(html).toContain(">neu<");
    expect(html).toContain(">8.120</span>");
  });

  it("shows the data states of metric widgets", () => {
    const html = renderI18n(
      <TableWidgetView {...props} reading={null} status="backfilling" />,
    );
    expect(html).toContain("sw-table sw--empty");
    expect(html).toContain("sw-skeleton");
    const stale = renderI18n(
      <TableWidgetView {...props} status="stale" notice="Last sync 3 h ago" />,
    );
    expect(stale).toContain("sw-table sw--stale");
    expect(stale).toContain("Last sync 3 h ago");
  });

  it("renders a payload table, and an unknown type safely", () => {
    const widget = {
      type: "table",
      id: "00000000-0000-4000-8000-000000000001",
      x: 0,
      y: 0,
      w: 4,
      h: 4,
      label: "Page views · netrics.so",
      options: {
        groupBy: "route",
        limit: 5,
        showChange: true,
        showOthers: false,
      },
      data: {
        period: "last_30_days",
        aggregation: "sum",
        unit: "count",
        conversion: null,
        kind: "delta",
        granularity: "day",
        better: "higher",
        status: "ok",
        updatedAt: "2026-10-04T09:00:00.000Z",
        groupBy: "route",
        columns: { label: "Route", value: "Page views" },
        rows: [
          {
            key: "/pricing",
            label: "/pricing",
            value: 8120,
            previousValue: 7250,
            ratio: 0.12,
          },
        ],
        others: null,
      },
    } as const satisfies DeviceWidget;
    expect(deviceTableReading(widget, "en").reading?.rows).toEqual([
      { label: "/pricing", value: 8120, previousValue: 7250, ratio: 0.12 },
    ]);
    const env = {
      timeZone: "UTC",
      fontScale: 1,
      showHeader: true,
      images: new Map(),
    };
    const html = renderI18n(<DeviceWidgetView widget={widget} env={env} />);
    expect(html).toContain("Top 1 · Last 30 days");
    expect(html).toContain(">+12%<");
    const later = renderI18n(
      <DeviceWidgetView
        widget={{ ...widget, type: "gauge" } as unknown as DeviceWidget}
        env={env}
      />,
    );
    expect(later).not.toContain("sw-table");
  });
});

describe("table card in scroll view", () => {
  it("shows all limit rows with full labels", () => {
    const html = renderI18n(
      <ScrollTableCard
        {...props}
        options={{ limit: 8, showChange: true, showOthers: false }}
        width={360}
        rootPx={16}
      />,
    );
    expect(html).toContain("Top 8 · Last 30 days");
    const shown = [
      ...html.matchAll(/class="scroll-table-label"[^>]*>([^<]*)</g),
    ].map((match) => match[1]);
    expect(shown).toEqual(routes);
  });
});

describe("row rise (ADR 0019 section 2)", () => {
  it("staggers rows by 90 ms, each over 400 ms, final at the end", () => {
    // 1200 ms enter: row 0 is done at 400 ms, row 2 starts at 180 ms.
    expect(rowRiseProgress(0, 0)).toBe(0);
    expect(rowRiseProgress(0, 400 / 1200)).toBeCloseTo(1, 9);
    expect(rowRiseProgress(2, 180 / 1200)).toBeCloseTo(0, 9);
    expect(rowRiseProgress(2, 380 / 1200)).toBeCloseTo(1 - (1 - 0.5) ** 3, 9);
    expect(rowRiseProgress(9, 0.99)).toBeLessThan(1);
    expect(rowRiseProgress(9, 1)).toBe(1);
  });
});
