import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CompareMeasureReading,
  ConnectionStateView,
  DeviceWidget,
  GoalReadResponse,
  MetricBreakdownResponse,
  MetricQueryResponse,
  WidgetFreshness,
} from "@netrics/contracts";

import { fetchGoal } from "@/lib/api";
import { renderI18n } from "@/lib/i18n/test-render";
import type { GaugeWidget } from "@/lib/studio-gauge";
import type { DataWidget, StudioEnv } from "@/lib/studio-widgets";

import { LiveBarWidget } from "./bar-widget";
import { LiveCompareWidget, type CompareWidget } from "./compare-widget";
import { DeviceWidgetView } from "./device-widget";
import { LiveGaugeWidget } from "./gauge-widget";
import { LiveLineWidget } from "./line-widget";
import { LiveMetricWidget, liveDataState } from "./metric-widget";
import { LiveTableWidget } from "./table-widget";
import { clearSharedLoads, metricRequest, sharedLoad } from "./use-widget-data";

// Signed-in live widgets show the freshness of their query (ADR 0025
// sections 7 and 8, #727), as screens do from the device payload; an
// overdue provider ("status": "stale") wins over the connection's "ok".

const NOW = Date.parse("2026-11-16T12:50:00Z");
const TEN_MIN_AGO = "2026-11-16T12:40:00Z";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  clearSharedLoads();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** The markup's text without tags, spaces plain and single. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[\u202f\u00a0]/g, " ")
    .replace(/\s+/g, " ");
}

const periodic: WidgetFreshness = {
  kind: "periodic",
  stream: "Sales",
  fetchedAt: TEN_MIN_AGO,
  dataThrough: "2026-11-15",
  // Already past and not late: "next any minute", in every zone.
  nextExpectedAt: "2026-11-16T12:00:00Z",
};
const overdue: WidgetFreshness = {
  kind: "periodic",
  stream: "Sales",
  fetchedAt: TEN_MIN_AGO,
  dataThrough: "2026-11-14",
  nextExpectedAt: "2026-11-15T09:00:00Z",
  late: true,
  nextCheckAt: "2026-11-16T12:45:00Z",
};
// The day is older than the day of the check: named where it fits (#791).
const FRESH_EN = "Last reporting day: Nov 15 · fetched 10 min. ago";
// A tile without room for it (the German gauge) keeps the line as it was.
const FRESH_DE =
  /(?:Letzter Berichtstag: 15\. Nov\.|Bis 15\. Nov\.) · abgerufen vor 10 Min\./;
const LATE_EN = "Up to Nov 14 · Nov 15 not published yet";

// A healthy connection that synced five minutes ago: "ok" by its state.
const state: ConnectionStateView = {
  health: "ok",
  authState: "ok",
  authReason: null,
  lastSuccessAt: "2026-11-16T12:45:00Z",
  nextDueAt: null,
  consecutiveFailures: 0,
  pollIntervalSeconds: 300,
};
const env: StudioEnv = {
  workspaceId: ID(1),
  timeZone: "UTC",
  fontScale: 1,
  showHeader: true,
  metrics: new Map(),
  connections: { [ID(9)]: { name: "Shop", state } },
  images: new Map(),
};

const binding = {
  id: ID(20),
  x: 0,
  y: 0,
  w: 8,
  h: 6,
  title: "Proceeds",
  connectionId: ID(9),
  metricKey: "shop.proceeds",
  aggregation: "sum",
  period: "last_7_days",
  dimensions: {},
  displayCurrency: null,
  resourceName: null,
  allResourcesName: null,
} as const;
const metricWidget = {
  ...binding,
  type: "metric",
  options: { showSparkline: false, showChange: true },
} as Extract<DataWidget, { type: "metric" }>;
const lineWidget = {
  ...binding,
  type: "line",
  options: { showPrevious: false, showAxis: false },
} as Extract<DataWidget, { type: "line" }>;
const barWidget = {
  ...binding,
  type: "bar",
  options: { groupBy: "territory", limit: 5 },
} as Extract<DataWidget, { type: "bar" }>;
const tableWidget = {
  ...binding,
  type: "table",
  options: {
    groupBy: "territory",
    limit: 5,
    showChange: false,
    showOthers: false,
  },
} as Extract<DataWidget, { type: "table" }>;
const compareWidget = {
  ...binding,
  type: "compare",
  denominator: {
    connectionId: ID(9),
    metricKey: "shop.visits",
    aggregation: "sum",
    dimensions: {},
    resourceName: null,
    allResourcesName: null,
  },
  options: { format: "percent", ratioLabel: "conversion", showChange: true },
} as CompareWidget;

const series = Array.from({ length: 7 }, (_, index) => ({
  bucket: `2026-11-${String(index + 9).padStart(2, "0")}T00:00:00.000Z`,
  value: index + 1,
}));
const query = (
  extra: Partial<MetricQueryResponse> = {},
  value = 1248,
): MetricQueryResponse =>
  ({
    metric: { name: "Proceeds", unit: "count", better: "higher" },
    value,
    previousValue: 1000,
    delta: value - 1000,
    ratio: (value - 1000) / 1000,
    series,
    previousSeries: series,
    timeZone: "UTC",
    currency: null,
    conversion: null,
    ...extra,
  }) as MetricQueryResponse;
const breakdown = (
  extra: Partial<MetricBreakdownResponse> = {},
): MetricBreakdownResponse =>
  ({
    metric: { name: "Proceeds", unit: "count", better: "higher" },
    groupByName: "Country",
    groups: [
      { key: "DE", label: "Germany", value: 812 },
      { key: "US", label: "United States", value: 400 },
    ],
    others: null,
    currency: null,
    conversion: null,
    ...extra,
  }) as MetricBreakdownResponse;

/** Seeds what a metric query hook shares, as a first page render reads it. */
async function seedMetric(widget: DataWidget, data: MetricQueryResponse) {
  await sharedLoad(
    `metric|${env.workspaceId}|${JSON.stringify(metricRequest(widget))}`,
    () => Promise.resolve(data),
  );
}
async function seedBreakdown(
  widget: Extract<DataWidget, { type: "bar" | "table" }>,
  data: MetricBreakdownResponse,
) {
  await sharedLoad(
    `breakdown|${env.workspaceId}|${JSON.stringify({
      ...metricRequest(widget),
      groupBy: widget.options.groupBy,
      limit: widget.options.limit,
      ...(widget.type === "table" && widget.options.showChange
        ? { withPrevious: true }
        : {}),
    })}`,
    () => Promise.resolve(data),
  );
}

/** The fresh line in English and German, and the stale warning. */
function expectFreshness(
  render: (extra: {
    freshness?: WidgetFreshness;
    status?: "stale";
  }) => Promise<[string, string]>,
) {
  return async () => {
    const [en, de] = await render({ freshness: periodic });
    expect(text(en)).toContain(FRESH_EN);
    expect(text(en)).not.toContain("updated");
    expect(text(de)).toMatch(FRESH_DE);
    expect(en).not.toContain("sw-notice--stale");

    clearSharedLoads();
    const [stale] = await render({ freshness: overdue, status: "stale" });
    expect(stale).toContain("sw-notice--stale");
    expect(text(stale)).toContain(LATE_EN);
    expect(text(stale)).not.toContain("checking again");
  };
}

describe("a table limited to some groups (#787)", () => {
  it("asks for its groupKeys only and heads its values with valueLabel", async () => {
    const limited = {
      ...tableWidget,
      options: {
        ...tableWidget.options,
        groupKeys: ["DE", "US"],
        valueLabel: "30-day total",
      },
    } as typeof tableWidget;
    // The request the hook shares carries the groups: only a load under
    // that key reaches the widget.
    await sharedLoad(
      `breakdown|${env.workspaceId}|${JSON.stringify({
        ...metricRequest(limited),
        groupBy: "territory",
        limit: 5,
        groups: ["DE", "US"],
      })}`,
      () => Promise.resolve(breakdown()),
    );
    const head = (value: string) => `sw-table-head-value">${value}<`;
    const html = renderI18n(<LiveTableWidget widget={limited} env={env} />);
    expect(text(html)).toContain("Germany");
    expect(html).toContain(head("30-day total"));
    expect(html).not.toContain(head("Proceeds"));
    // Without a head of its own: the metric's name, as before.
    clearSharedLoads();
    await seedBreakdown(tableWidget, breakdown());
    const plain = renderI18n(
      <LiveTableWidget widget={tableWidget} env={env} />,
    );
    expect(plain).toContain(head("Proceeds"));
  });
});

describe("live widgets show their query's freshness (#727)", () => {
  it(
    "metric",
    expectFreshness(async (extra) => {
      await seedMetric(metricWidget, query(extra));
      const ui = <LiveMetricWidget widget={metricWidget} env={env} />;
      return [renderI18n(ui), renderI18n(ui, "de")];
    }),
  );

  it(
    "line",
    expectFreshness(async (extra) => {
      await seedMetric(lineWidget, query(extra));
      const ui = <LiveLineWidget widget={lineWidget} env={env} />;
      return [renderI18n(ui), renderI18n(ui, "de")];
    }),
  );

  it(
    "bar",
    expectFreshness(async (extra) => {
      await seedBreakdown(barWidget, breakdown(extra));
      const ui = <LiveBarWidget widget={barWidget} env={env} />;
      return [renderI18n(ui), renderI18n(ui, "de")];
    }),
  );

  it(
    "table",
    expectFreshness(async (extra) => {
      await seedBreakdown(tableWidget, breakdown(extra));
      const ui = <LiveTableWidget widget={tableWidget} env={env} />;
      return [renderI18n(ui), renderI18n(ui, "de")];
    }),
  );

  it(
    "compare over two metrics",
    expectFreshness(async (extra) => {
      // The numerator carries the freshness; the denominator has none.
      await seedMetric(compareWidget, query(extra, 257));
      await seedMetric(
        { ...compareWidget, ...compareWidget.denominator },
        query({}, 1846),
      );
      const ui = <LiveCompareWidget widget={compareWidget} env={env} />;
      return [renderI18n(ui), renderI18n(ui, "de")];
    }),
  );

  it("compare over two metrics shows the less fresh side", async () => {
    await seedMetric(compareWidget, query({ freshness: periodic }, 257));
    await seedMetric(
      { ...compareWidget, ...compareWidget.denominator },
      query(
        {
          freshness: {
            ...periodic,
            stream: "Visits",
            dataThrough: "2026-11-13",
            fetchedAt: "2026-11-16T12:20:00Z",
          },
        },
        1846,
      ),
    );
    const html = renderI18n(
      <LiveCompareWidget widget={compareWidget} env={env} />,
    );
    expect(text(html)).toContain(
      "Last reporting day: Nov 13 · fetched 30 min. ago",
    );
  });

  it(
    "compare bound to measures",
    expectFreshness(async (extra) => {
      const measure = {
        modelId: ID(70),
        dateDimensionId: "date",
        measureIds: {
          numerator: "numerator",
          denominator: "denominator",
          ratio: "ratio",
        },
      };
      const widget = { ...compareWidget, measure } as CompareWidget;
      const reading: CompareMeasureReading = {
        widgetId: widget.id,
        // The reading's status already says "stale" (as on screens).
        status: extra.status ?? "ok",
        error: null,
        updatedAt: state.lastSuccessAt,
        expiresAt: null,
        sources: ["Shop"],
        numerator: { label: "Signups", value: 257, unit: "count" },
        denominator: { label: "Visits", value: 1846, unit: "count" },
        ratio: { value: 257 / 1846, previousValue: 0.143 },
        unit: null,
        dates: {
          current: { from: "2026-11-09", to: "2026-11-15" },
          previous: { from: "2026-11-02", to: "2026-11-08" },
        },
        ...(extra.freshness ? { freshness: extra.freshness } : {}),
      };
      await sharedLoad(
        `compare-measure|${env.workspaceId}|${widget.id}|${JSON.stringify({
          period: widget.period,
          measure,
          format: widget.options.format,
        })}`,
        () => Promise.resolve(reading),
      );
      const ui = <LiveCompareWidget widget={widget} env={env} />;
      return [renderI18n(ui), renderI18n(ui, "de")];
    }),
  );

  const gaugeWidget: GaugeWidget = {
    type: "gauge",
    id: ID(30),
    x: 0,
    y: 0,
    w: 6,
    h: 6,
    title: "Monthly proceeds",
    goalId: ID(40),
    goalName: "Monthly proceeds",
    options: { showTimeLeft: true },
  };
  const goal: GoalReadResponse["goal"] = {
    id: ID(40),
    name: "Monthly proceeds",
    connectionId: ID(9),
    metricKey: "shop.proceeds",
    aggregation: "sum",
    period: "this_month",
    dimensions: {},
    displayCurrency: null,
    target: 2000,
    version: 1,
    resourceName: null,
    allResourcesName: null,
    current: {
      value: 1248,
      target: 2000,
      progress: 0.624,
      reachedAt: null,
      periodEnd: "2026-12-01T00:00:00.000Z",
      currency: null,
      approximate: false,
    },
    dashboards: [],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };

  it(
    "gauge",
    expectFreshness(async (extra) => {
      await sharedLoad(`goal|${env.workspaceId}|${gaugeWidget.goalId}`, () =>
        Promise.resolve({ goal, ...extra }),
      );
      const ui = <LiveGaugeWidget widget={gaugeWidget} env={env} />;
      return [renderI18n(ui), renderI18n(ui, "de")];
    }),
  );

  it("a goal read keeps its freshness and status", async () => {
    const body = { goal, freshness: periodic, status: "stale" };
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );
    expect(await fetchGoal(env.workspaceId, goal.id)).toEqual(body);
  });

  it("without freshness keeps the 'updated … ago' footer", async () => {
    await seedMetric(metricWidget, query());
    const html = renderI18n(
      <LiveMetricWidget widget={metricWidget} env={env} />,
    );
    expect(text(html)).toContain("updated 5 min. ago");
    expect(text(html)).not.toContain("Up to");
  });
});

describe("liveDataState with a served status (#727)", () => {
  const connection = { state };
  const loaded = { error: null, loading: false, loaded: true, hasData: true };

  it("an overdue row turns the connection's ok into stale, with its notice", () => {
    expect(liveDataState({ ...loaded, stale: true }, connection, "en")).toEqual(
      { status: "stale", notice: "Last sync 5 minutes ago" },
    );
  });

  it("does not hide a failure or a data state", () => {
    expect(
      liveDataState({ ...loaded, error: "boom", stale: true }, connection, "en")
        .status,
    ).toBe("outage");
    expect(
      liveDataState(
        { ...loaded, hasData: false, stale: true },
        { state: { ...state, health: "pending", lastSuccessAt: null } },
        "en",
      ).status,
    ).toBe("backfilling");
  });
});

describe("paired screens list the status board's streams (#727)", () => {
  const board = (
    streams: NonNullable<
      Extract<
        DeviceWidget,
        { type: "status" }
      >["data"]["items"][number]["streams"]
    >,
  ): Extract<DeviceWidget, { type: "status" }> => ({
    type: "status",
    id: ID(50),
    x: 0,
    y: 0,
    w: 8,
    h: 6,
    label: "Sources",
    options: { showAge: true, connectionIds: null },
    data: {
      status: "ok",
      items: [
        {
          connectionId: ID(9),
          name: "Shop",
          status: "ok",
          lastSuccessAt: TEN_MIN_AGO,
          streams,
        },
        {
          connectionId: ID(10),
          name: "Vercel",
          status: "ok",
          lastSuccessAt: TEN_MIN_AGO,
        },
      ],
    },
  });
  /** The stream rows' texts and whether each is in the warning style. */
  const rows = (html: string) =>
    [...html.matchAll(/class="sw-status-stream( stale)?"[^>]*>([^<]*)</g)].map(
      (match) => ({
        text: match[2]!.replace(/[\u202f\u00a0]/g, " "),
        warning: match[1] !== undefined,
      }),
    );
  const render = (
    widget: Extract<DeviceWidget, { type: "status" }>,
    locale: "en" | "de" = "en",
  ) =>
    renderI18n(
      <DeviceWidgetView
        widget={widget}
        env={{
          timeZone: "UTC",
          showHeader: true,
          fontScale: 1,
          images: new Map(),
        }}
      />,
      locale,
    );

  it("lists each source's streams from the payload", () => {
    const widget = board([
      { key: "sales", ...periodic },
      {
        key: "reviews",
        kind: "continuous",
        stream: "Reviews",
        fetchedAt: TEN_MIN_AGO,
        nextCheckAt: "2026-11-16T12:49:00Z",
      },
    ]);
    expect(rows(render(widget))).toEqual([
      {
        text: "Sales up to Nov 15 · fetched 10 min. ago · next any minute",
        warning: false,
      },
      {
        text: "Reviews checked 10 min. ago · next check any minute",
        warning: false,
      },
    ]);
    expect(rows(render(widget, "de"))[0]!.text).toBe(
      "Sales bis 15. Nov. · abgerufen vor 10 Min. · nächste in Kürze",
    );
  });

  it("an overdue stream is in the warning style", () => {
    expect(
      rows(render(board([{ key: "sales", ...overdue, overdue: true }]))),
    ).toEqual([
      { text: "Sales up to Nov 14 · Nov 15 not published yet", warning: true },
    ]);
  });

  it("names no next or check time the payload leaves out", () => {
    const { nextExpectedAt: _n, ...unscheduled } = periodic;
    expect(rows(render(board([{ key: "sales", ...unscheduled }])))).toEqual([
      { text: "Sales up to Nov 15 · fetched 10 min. ago", warning: false },
    ]);
    expect(
      rows(
        render(
          board([
            {
              key: "reviews",
              kind: "continuous",
              stream: "Reviews",
              fetchedAt: TEN_MIN_AGO,
            },
          ]),
        ),
      ),
    ).toEqual([{ text: "Reviews checked 10 min. ago", warning: false }]);
  });
});
