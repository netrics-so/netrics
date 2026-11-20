import { describe, expect, it } from "vitest";
import type { DashboardWidgetData } from "@netrics/contracts";
import { renderI18n } from "@/lib/i18n/test-render";
import type { DashboardDataFilter } from "@netrics/domain";
import type { StudioEnv } from "@/lib/studio-widgets";
import {
  formatMeasureCell,
  liveInteraction,
  MeasureWidgetView,
  type MeasureWidget,
} from "./measure-widget";
const format = (
  value: unknown,
  type = "decimal",
  currency?: string,
  locale = "en",
  unit?: string,
) =>
  formatMeasureCell(
    value,
    type,
    currency,
    locale,
    "True",
    "False",
    unit,
    "UTC",
  );
describe("semantic value display", () => {
  it("preserves exact decimal amounts beyond IEEE-754 precision and localizes separators", () => {
    expect(format("9007199254740993.12", "decimal", "EUR")).toBe(
      "9,007,199,254,740,993.12 EUR",
    );
    expect(format("9007199254740993.12", "decimal", "EUR", "de")).toBe(
      "9.007.199.254.740.993,12 EUR",
    );
    expect(format("150", "decimal", "EUR")).toBe("150.00 EUR");
    expect(format(150, "integer", "EUR")).toBe("150.00 EUR");
  });
  it("scales minor units by the actual currency exponent exactly", () => {
    expect(format(150, "integer", "EUR", "en", "currency_minor")).toBe(
      "1.50 EUR",
    );
    expect(format(-1, "integer", "KWD", "en", "currency_minor")).toBe(
      "-0.001 KWD",
    );
    expect(format(150, "integer", "JPY", "en", "currency_minor")).toBe(
      "150 JPY",
    );
  });
  it("distinguishes missing, false and zero and shows rating/percent units", () => {
    expect(format(null)).toBe("—");
    expect(format(false, "boolean")).toBe("False");
    expect(format(0, "integer")).toBe("0");
    expect(format("4.5", "decimal", undefined, "en", "stars")).toBe("4.5 ★");
    expect(format("12.5", "decimal", undefined, "en", "percent")).toBe("12.5%");
  });
});

describe("locale dates and rounded ratings (#619)", () => {
  it("formats days and timestamps for the locale instead of ISO text", () => {
    expect(format("2026-01-07", "date", undefined, "de")).toBe("07.01.2026");
    expect(format("2026-01-07", "date", undefined, "en")).toBe("Jan 7, 2026");
    // In the viewer's zone, here UTC (#749).
    const at = new Intl.DateTimeFormat("de", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date("2026-01-07T09:15:00.000Z"));
    expect(
      format("2026-01-07T09:15:00.000Z", "timestamp", undefined, "de"),
    ).toBe(at);
    expect(at).not.toContain("T09");
  });
  it("rounds ratings to two decimals without touching other decimals", () => {
    expect(format("4.2857", "decimal", undefined, "de", "stars")).toBe(
      "4,29 ★",
    );
    expect(format("4.66667", "decimal", undefined, "en", "stars")).toBe(
      "4.67 ★",
    );
    expect(format(4.2857, "number", undefined, "en", "stars")).toBe("4.29 ★");
    expect(format("4.2857", "decimal", undefined, "en")).toBe("4.2857");
  });
  it("shows a rating table with units, rounding and locale days in en and de", () => {
    const props: Parameters<typeof MeasureWidgetView>[0] = {
      widget: {
        title: null,
        options: { view: "table", limit: 20 },
        binding: { measureIds: ["rating", "checked"], groupBy: ["day"] },
      },
      data: {
        widgetId: "00000000-0000-4000-8000-000000000001",
        status: "ok",
        error: null,
        exclusions: [],
        metadata: {
          modelId: "00000000-0000-4000-8000-000000000002",
          modelName: "Ratings",
          measures: [
            { id: "rating", name: "Rating" },
            { id: "checked", name: "Checked at" },
          ],
          dimensions: [{ id: "day", name: "Day", type: "date" }],
        },
        result: {
          releaseId: null,
          rows: [
            {
              dimensions: { day: "2026-01-07" },
              measures: {
                rating: {
                  value: "4.2857",
                  type: "decimal",
                  unit: "stars",
                  status: "ok",
                },
                checked: { value: "2026-01-06", type: "date", status: "ok" },
              },
            },
          ],
          warnings: [],
          operations: 1,
          provenance: [],
          appliedFilter: null,
          groupBy: [],
        },
      } as unknown as DashboardWidgetData,
    };
    const de = renderI18n(<MeasureWidgetView {...props} />, "de");
    expect(de).toContain("4,29 ★");
    expect(de).toContain("07.01.2026");
    expect(de).toContain("06.01.2026");
    expect(de).not.toContain("4,2857");
    expect(de).not.toContain("2026-01-0");
    const en = renderI18n(<MeasureWidgetView {...props} />);
    expect(en).toContain("4.29 ★");
    expect(en).toContain("Jan 6, 2026");
  });
});

describe("percent change measures", () => {
  const data = (
    view: "value" | "table",
  ): Parameters<typeof MeasureWidgetView>[0] => ({
    widget: {
      title: null,
      options: { view, limit: 20 },
      binding: {
        measureIds: ["pct"],
        groupBy: view === "table" ? ["day"] : [],
      },
    },
    data: {
      widgetId: "00000000-0000-4000-8000-000000000001",
      status: "ok",
      error: null,
      exclusions: [],
      metadata: {
        modelId: "00000000-0000-4000-8000-000000000002",
        modelName: "Sales",
        measures: [
          { id: "pct", name: "Units, change in %", percentChange: true },
        ],
        dimensions: [{ id: "day", name: "Day", type: "date" }],
      },
      result: {
        releaseId: null,
        rows: [
          {
            dimensions: view === "table" ? { day: "2026-10-02" } : {},
            measures: {
              pct: {
                value: "0.083333333333333333",
                type: "decimal",
                status: "ok",
              },
            },
          },
        ],
        warnings: [],
        operations: 1,
        provenance: [],
        appliedFilter: null,
        groupBy: [],
      },
    } as unknown as DashboardWidgetData,
  });
  it("shows a percent change as a signed percentage in every view", () => {
    for (const view of ["value", "table"] as const) {
      const html = renderI18n(<MeasureWidgetView {...data(view)} />);
      expect(html).toContain("+8.3%");
      expect(html).not.toContain("0.083333");
    }
  });
});

describe("declared chart-to-filter interactions", () => {
  const view = (
    interaction?: Parameters<typeof MeasureWidgetView>[0]["interaction"],
    chart: "bar" | "table" = "bar",
  ): Parameters<typeof MeasureWidgetView>[0] => ({
    widget: {
      title: "Income",
      options: { view: chart, limit: 20 },
      binding: { measureIds: ["income"], groupBy: ["country"] },
    },
    interaction,
    data: {
      widgetId: "00000000-0000-4000-8000-000000000001",
      status: "ok",
      error: null,
      exclusions: [],
      metadata: {
        modelId: "00000000-0000-4000-8000-000000000002",
        modelName: "Sales",
        measures: [{ id: "income", name: "Income" }],
        dimensions: [{ id: "country", name: "Country", type: "string" }],
      },
      result: {
        releaseId: null,
        rows: ["DE", "FR"].map((country, index) => ({
          dimensions: { country },
          dimensionLabels: { country: country === "DE" ? "Germany" : "France" },
          measures: {
            income: {
              value: String(100 - index),
              type: "decimal",
              status: "ok",
            },
          },
        })),
        warnings: [],
        operations: 1,
        provenance: [],
        appliedFilter: null,
        groupBy: ["country"],
      },
    } as unknown as DashboardWidgetData,
  });
  const interaction = {
    dimensionId: "country",
    filterName: "Market",
    selectable: () => true,
    selected: (value: unknown) => value === "FR",
    toggle: () => undefined,
  };
  it("renders the grouped values as pressed/unpressed filter buttons in en and de", () => {
    for (const chart of ["bar", "table"] as const) {
      const html = renderI18n(
        <MeasureWidgetView {...view(interaction, chart)} />,
      );
      expect(html).toContain("Select a value to filter by Market.");
      expect(html).toMatch(
        /<button[^>]*aria-pressed="false"[^>]*title="Filter by Market: Germany"[^>]*>Germany<\/button>/,
      );
      expect(html).toMatch(/aria-pressed="true"[^>]*>France<\/button>/);
    }
    expect(
      renderI18n(<MeasureWidgetView {...view(interaction)} />, "de"),
    ).toContain("Wähle einen Wert, um nach Market zu filtern.");
  });
  it("keeps undeclared and non-interactive widgets as plain text", () => {
    const html = renderI18n(<MeasureWidgetView {...view()} />);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("filter by");
  });
});

describe("viewer interaction state", () => {
  const filter: DashboardDataFilter = {
    id: "market",
    name: "Market",
    type: "string",
    mode: "values",
    mappings: [{ modelId: "model", dimensionId: "country" }],
    defaultValue: { kind: "values", values: ["DE"] },
  };
  const widget = {
    id: "00000000-0000-4000-8000-000000000003",
    type: "measure",
    title: null,
    x: 0,
    y: 0,
    w: 6,
    h: 4,
    binding: {
      modelId: "model",
      measureIds: ["income"],
      groupBy: ["country"],
      exclusions: [],
      interaction: { filterId: "market" },
    },
    options: { view: "bar", limit: 20 },
  } as MeasureWidget;
  const env = (
    filterValues: StudioEnv["filterValues"],
    calls: unknown[][] = [],
  ) =>
    ({
      dataFilters: [filter],
      filterValues,
      onFilterValue: (...args: unknown[]) => calls.push(args),
    }) as unknown as StudioEnv;
  it("sets the clicked value, then clears it back to the default or to all values", () => {
    const calls: unknown[][] = [];
    liveInteraction(widget, env({}, calls))!.toggle("FR");
    liveInteraction(
      widget,
      env({ market: { kind: "values", values: ["FR"] } }, calls),
    )!.toggle("FR");
    // The default is that very value: clicking it again shows all values.
    liveInteraction(widget, env({}, calls))!.toggle("DE");
    expect(calls).toEqual([
      ["market", { kind: "values", values: ["FR"] }],
      ["market", undefined],
      ["market", null],
    ]);
  });
  it("is absent where the environment is not interactive or the declaration does not apply", () => {
    expect(
      liveInteraction(widget, { ...env({}), onFilterValue: undefined }),
    ).toBeUndefined();
    expect(
      liveInteraction(
        { ...widget, binding: { ...widget.binding, groupBy: [] } },
        env({}),
      ),
    ).toBeUndefined();
    expect(
      liveInteraction(
        { ...widget, binding: { ...widget.binding, interaction: undefined } },
        env({}),
      ),
    ).toBeUndefined();
  });
});

describe("viewer interaction state with typed values", () => {
  it("clears an equivalent decimal default to all values instead of re-selecting it", () => {
    const filter: DashboardDataFilter = {
      id: "price",
      name: "Price",
      type: "decimal",
      mode: "values",
      mappings: [{ modelId: "model", dimensionId: "price" }],
      defaultValue: { kind: "values", values: ["1.0"] },
    };
    const calls: unknown[][] = [];
    const interaction = liveInteraction(
      {
        id: "00000000-0000-4000-8000-000000000004",
        type: "measure",
        title: null,
        x: 0,
        y: 0,
        w: 6,
        h: 4,
        binding: {
          modelId: "model",
          measureIds: ["income"],
          groupBy: ["price"],
          exclusions: [],
          interaction: { filterId: "price" },
        },
        options: { view: "bar", limit: 20 },
      } as MeasureWidget,
      {
        dataFilters: [filter],
        filterValues: {},
        onFilterValue: (...args: unknown[]) => calls.push(args),
      } as unknown as StudioEnv,
    )!;
    expect(interaction.selected("1.00")).toBe(true);
    interaction.toggle("1.00");
    expect(calls).toEqual([["price", null]]);
  });
});

describe("viewer wording on paired screens (#649)", () => {
  const props = (
    audience?: "editor" | "viewer",
  ): Parameters<typeof MeasureWidgetView>[0] => ({
    audience,
    widget: {
      title: "Downloads",
      options: { view: "table", limit: 20 },
      binding: { measureIds: ["downloads"], groupBy: ["app"] },
    },
    data: {
      widgetId: "00000000-0000-4000-8000-000000000001",
      status: "ok",
      error: null,
      exclusions: [],
      metadata: {
        modelId: "00000000-0000-4000-8000-000000000002",
        modelName: "Downloads",
        measures: [{ id: "downloads", name: "Downloads" }],
        dimensions: [{ id: "app", name: "App", type: "string" }],
      },
      result: {
        releaseId: null,
        rows: [],
        warnings: [{ code: "w", message: "w" }],
        operations: 1,
        provenance: [],
        appliedFilter: null,
        groupBy: [],
        stale: true,
      },
    } as unknown as DashboardWidgetData,
  });

  it("keeps editor instructions in the dashboard and Studio", () => {
    const html = renderI18n(<MeasureWidgetView {...props()} />);
    expect(html).toContain("No rows in this preview.");
    expect(html).toContain("1 data warning. Check the model preview.");
  });

  it("says what a wall screen can show, in English and German", () => {
    const en = renderI18n(<MeasureWidgetView {...props("viewer")} />);
    expect(en).toContain("No data yet");
    expect(en).toContain("1 data warning");
    expect(en).toContain("Last valid data");
    expect(en).not.toContain("preview");
    expect(en).not.toContain("Check");
    const de = renderI18n(<MeasureWidgetView {...props("viewer")} />, "de");
    expect(de).toContain("Noch keine Daten");
    expect(de).toContain("1 Datenhinweis");
    expect(de).toContain("Letzte gültige Daten");
    expect(de).not.toContain("Vorschau");
    expect(de).not.toContain("Prüfe");
  });

  it("says when a source's history is still loading (#635)", () => {
    const loading = (audience?: "editor" | "viewer") => {
      const base = props(audience);
      return {
        ...base,
        data: {
          ...base.data!,
          result: {
            ...base.data!.result!,
            warnings: ["source_history_incomplete"],
          },
        },
      };
    };
    const editor = renderI18n(<MeasureWidgetView {...loading()} />);
    expect(editor).toContain(
      "History incomplete: a source is still loading earlier days, so they may be missing.",
    );
    // Its own note, not counted as another warning.
    expect(editor).not.toContain("data warning");
    const viewer = renderI18n(<MeasureWidgetView {...loading("viewer")} />);
    expect(viewer).toContain(
      "History incomplete. Earlier days may be missing.",
    );
    const de = renderI18n(<MeasureWidgetView {...loading("viewer")} />, "de");
    expect(de).toContain("Verlauf unvollständig. Frühere Tage können fehlen.");
    expect(de).not.toContain("Datenhinweis");
  });

  /** The same tile with a data error, or sources needing attention. */
  const failing = (
    error: string | null,
    audience?: "editor" | "viewer",
  ): Parameters<typeof MeasureWidgetView>[0] => {
    const base = props(audience);
    return {
      ...base,
      data: {
        ...base.data!,
        error,
        result: error ? null : base.data!.result,
        sourceHealth: [
          {
            connectionId: ID(31),
            name: "Apple team",
            status: "needs_reauthorization",
          },
          { connectionId: ID(32), name: "Play account", status: "auth_failed" },
          { connectionId: ID(33), name: "Second Play", status: "outage" },
        ],
      } as unknown as DashboardWidgetData,
    };
  };
  const ID = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  /** Editor instructions, in either language. */
  const INSTRUCTION =
    /Check|Reconnect|Update access|Try again|Prüfe|Verbinde|Aktualisiere|Versuche/;

  it("keeps errors and source states free of instructions on wall screens", () => {
    // The editor still gets the remedy.
    const editor = renderI18n(
      <MeasureWidgetView {...failing("data_source_pending")} />,
    );
    expect(editor).toContain("Reconnect Apple team");
    expect(editor).toMatch(INSTRUCTION);
    for (const locale of ["en", "de"] as const) {
      for (const error of [
        "data_source_pending",
        "data_source_not_found",
        "internal_error",
        null,
      ]) {
        const html = renderI18n(
          <MeasureWidgetView {...failing(error, "viewer")} />,
          locale,
        );
        expect(html, `${locale} ${error}`).not.toMatch(INSTRUCTION);
      }
    }
    const en = (error: string | null) =>
      renderI18n(<MeasureWidgetView {...failing(error, "viewer")} />);
    expect(en("data_source_pending")).toContain("Data not available yet");
    expect(en("data_source_not_found")).toContain("Data not available");
    expect(en("internal_error")).toContain("Data not available");
    expect(en(null)).toContain("Imports from Apple team are paused.");
    expect(en(null)).toContain("Imports from Play account are paused.");
    expect(en(null)).toContain("Imports from Second Play are interrupted.");
    const de = renderI18n(
      <MeasureWidgetView {...failing("data_source_pending", "viewer")} />,
      "de",
    );
    expect(de).toContain("Daten noch nicht verfügbar");
    expect(de).toContain("Die Importe von Apple team sind pausiert.");
  });
});

describe("loading on screens and viewers (#768)", () => {
  const loading = (audience?: "editor" | "viewer") => (
    <MeasureWidgetView
      audience={audience}
      loading
      data={null}
      widget={{
        title: "Downloads",
        options: { view: "table", limit: 20 },
        binding: { measureIds: ["downloads"], groupBy: [] },
      }}
    />
  );

  it("says it is loading, not that a preview is", () => {
    for (const audience of ["editor", "viewer"] as const) {
      const en = renderI18n(loading(audience));
      expect(en, audience).toContain("Loading…");
      expect(en, audience).not.toContain("preview");
      const de = renderI18n(loading(audience), "de");
      expect(de, audience).toContain("Wird geladen…");
      expect(de, audience).not.toContain("Vorschau");
    }
  });
});

describe("the oldest source refresh next to the freshness line (#769)", () => {
  const fetchedAt = new Date(Date.now() - 600_000).toISOString();
  const periodic = {
    kind: "periodic",
    stream: "Sales",
    fetchedAt,
    dataThrough: "2026-11-15",
  } as const;
  const continuous = {
    kind: "continuous",
    stream: "Reviews",
    fetchedAt,
  } as const;
  const view = (
    withFreshness: boolean | typeof periodic | typeof continuous,
    locale: "en" | "de" = "en",
    state: Partial<DashboardWidgetData> = {},
  ) =>
    renderI18n(
      <MeasureWidgetView
        widget={{
          title: "Downloads",
          options: { view: "value", limit: 20 },
          binding: { measureIds: ["downloads"], groupBy: [] },
        }}
        data={
          {
            widgetId: "00000000-0000-4000-8000-000000000001",
            status: "ok",
            error: null,
            exclusions: [],
            freshness:
              withFreshness === true ? periodic : withFreshness || undefined,
            metadata: {
              modelId: "00000000-0000-4000-8000-000000000002",
              modelName: "Downloads",
              measures: [{ id: "downloads", name: "Downloads" }],
              dimensions: [],
            },
            result: {
              releaseId: null,
              receivedAt: "2026-11-15T11:08:00.000Z",
              rows: [
                {
                  dimensions: {},
                  measures: {
                    downloads: { value: 3, type: "integer", status: "ok" },
                  },
                },
              ],
              warnings: [],
              operations: 1,
              provenance: [],
              appliedFilter: null,
              groupBy: [],
            },
            ...state,
          } as unknown as DashboardWidgetData
        }
      />,
      locale,
    );

  it("shows only the freshness line when the widget has one, as on tvOS", () => {
    const en = view(true);
    expect(en).toContain("Up to Nov 15");
    expect(en).not.toContain("Oldest source refresh");
    const de = view(true, "de");
    expect(de).toContain("Bis 15. Nov.");
    expect(de).not.toContain("Älteste Quellenaktualisierung");
  });

  it("keeps the oldest source refresh without freshness", () => {
    expect(view(false)).toContain("Oldest source refresh: Nov 15, 2026");
    expect(view(false, "de")).toContain("Älteste Quellenaktualisierung");
  });

  it("keeps it where the freshness line does not render", () => {
    const failing = (status: string) => ({
      sourceHealth: [
        {
          connectionId: "00000000-0000-4000-8000-000000000031",
          name: "Apple team",
          status,
          lastSuccessAt: null,
        },
      ],
    });
    // A continuous stream under a warning shows no line, so the refresh
    // age stays the widget's only time.
    for (const state of [
      { status: "outage" },
      failing("auth_failed"),
      failing("needs_reauthorization"),
      failing("outage"),
    ] as Partial<DashboardWidgetData>[]) {
      const html = view(continuous, "en", state);
      expect(html, JSON.stringify(state)).not.toContain("sw-measure-freshness");
      expect(html, JSON.stringify(state)).toContain("Oldest source refresh");
    }
    // A continuous stream that is fine has its line instead.
    expect(view(continuous)).toContain("Checked");
    expect(view(continuous)).not.toContain("Oldest source refresh");
    // A periodic stream with its covered day and ok: the line only.
    const ok = view(periodic, "en", { status: "ok" });
    expect(ok).toContain("Up to Nov 15");
    expect(ok).not.toContain("Oldest source refresh");
  });
});

describe("a measure table fits its tile (#768)", () => {
  const data = (count: number, totalRows = count) =>
    ({
      widgetId: "00000000-0000-4000-8000-000000000001",
      status: "ok",
      error: null,
      exclusions: [],
      metadata: {
        modelId: "00000000-0000-4000-8000-000000000002",
        modelName: "Downloads",
        measures: [{ id: "downloads", name: "Downloads" }],
        dimensions: [{ id: "app", name: "App", type: "string" }],
      },
      result: {
        releaseId: null,
        rows: Array.from({ length: count }, (_, index) => ({
          dimensions: { app: `App ${index + 1}` },
          measures: {
            downloads: { value: 100 - index, type: "integer", status: "ok" },
          },
        })),
        totalRows,
        warnings: [],
        operations: 1,
        provenance: [],
        appliedFilter: null,
        groupBy: [],
      },
    }) as unknown as DashboardWidgetData;
  const view = (rows: number, placement?: { w: number; h: number }) =>
    renderI18n(
      <MeasureWidgetView
        widget={{
          title: "Downloads",
          options: { view: "table", limit: 20 },
          binding: { measureIds: ["downloads"], groupBy: ["app"] },
        }}
        data={data(rows)}
        {...(placement
          ? { placement: { x: 0, y: 0, ...placement }, showHeader: true }
          : {})}
      />,
    );
  const shownRows = (html: string) => html.match(/<tr>/g)!.length - 1;

  it("shows the rows that fit and says how many of all", () => {
    const html = view(20, { w: 4, h: 4 });
    const shown = shownRows(html);
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(20);
    expect(html).toContain(`Showing ${shown} of 20 groups.`);
    // A taller tile shows more.
    expect(shownRows(view(20, { w: 4, h: 8 }))).toBeGreaterThan(shown);
  });

  it("shows every row, without the line, when they fit", () => {
    const html = view(2, { w: 4, h: 8 });
    expect(shownRows(html)).toBe(2);
    expect(html).not.toContain("Showing");
  });

  it("shows no column heads when not even a row fits, and says so", () => {
    const html = view(20, { w: 4, h: 2 });
    expect(html).not.toContain("<table");
    expect(html).toContain("Showing 0 of 20 groups.");
  });

  it("shows every row where cards grow with their content (scroll view)", () => {
    expect(shownRows(view(20))).toBe(20);
  });
});

describe("a total with its split, and freshness per source (#784)", () => {
  const sources: NonNullable<DashboardWidgetData["freshness"]>["sources"] = [
    {
      source: "App Store",
      kind: "periodic",
      stream: "Sales",
      fetchedAt: new Date(Date.now() - 600_000).toISOString(),
      dataThrough: "2026-11-17",
      nextExpectedAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    {
      source: "Google Play",
      kind: "periodic",
      stream: "Installs",
      fetchedAt: new Date(Date.now() - 600_000).toISOString(),
      dataThrough: "2026-11-11",
    },
  ];
  const data = (extra: Partial<DashboardWidgetData> = {}) =>
    ({
      widgetId: "00000000-0000-4000-8000-000000000001",
      status: "ok",
      error: null,
      exclusions: [],
      scope: ["App: Focus"],
      metadata: {
        modelId: "00000000-0000-4000-8000-000000000002",
        modelName: "Downloads",
        measures: [{ id: "downloads", name: "Downloads" }],
        dimensions: [{ id: "store", name: "Store", type: "string" }],
      },
      result: {
        releaseId: null,
        rows: [
          ["apple", "App Store", 412],
          ["google", "Google Play", 223],
        ].map(([store, label, value]) => ({
          dimensions: { store },
          dimensionLabels: { store: label },
          measures: { downloads: { value, type: "integer", status: "ok" } },
        })),
        totalRows: 2,
        warnings: [],
        operations: 1,
        provenance: [],
        appliedFilter: null,
        groupBy: ["store"],
      },
      totals: [{ value: 635, type: "integer", status: "ok" }],
      freshness: {
        kind: "periodic",
        stream: "Installs",
        fetchedAt: sources[1]!.fetchedAt,
        dataThrough: "2026-11-11",
        sources,
      },
      ...extra,
    }) as unknown as DashboardWidgetData;
  const view = (
    value: DashboardWidgetData,
    placement?: { w: number; h: number },
    locale: "en" | "de" = "en",
  ) =>
    renderI18n(
      <MeasureWidgetView
        widget={{
          title: "Downloads and user installs",
          options: { view: "value", limit: 2 },
          binding: { measureIds: ["downloads"], groupBy: ["store"] },
        }}
        data={value}
        {...(placement
          ? { placement: { x: 0, y: 0, ...placement }, showHeader: true }
          : {})}
      />,
      locale,
    );
  const text = (html: string) =>
    html
      .replace(/<[^>]+>/g, "|")
      .replace(/\|+/g, "|")
      .replace(/\u202f/g, " ");

  it("shows the total and a line per store", () => {
    const html = text(view(data(), { w: 4, h: 3 }));
    expect(html).toContain("|635|");
    expect(html).toContain("|App Store| |412|");
    expect(html).toContain("|Google Play| |223|");
    expect(html).not.toContain("Showing");
  });

  it("shows the stores alone where a total makes no sense", () => {
    const html = text(view(data({ totals: undefined }), { w: 4, h: 3 }));
    expect(html).not.toContain("sw-measure-total");
    expect(html).toContain("|App Store| |412|");
  });

  it("lists every store's day in the freshness line, in the form that fits", () => {
    // A wide tile: each store's day and next time.
    const wide = text(view(data(), { w: 12, h: 3 }));
    expect(wide).toMatch(
      /App Store up to Nov 17 · next (?:tomorrow )?~[^|]+ · Google Play up to Nov 11/,
    );
    // A third of the width: the days only, or shorter, never a store less.
    const narrow = text(view(data(), { w: 4, h: 3 }, "de"));
    expect(narrow).toContain("App Store bis");
    expect(narrow).toContain("Google Play bis");
    expect(narrow).not.toContain("nächste");
  });

  it("counts every freshness line when a table fits its rows", () => {
    const table = (value: DashboardWidgetData, w: number) =>
      renderI18n(
        <MeasureWidgetView
          widget={{
            title: "Downloads",
            options: { view: "table", limit: 20 },
            binding: { measureIds: ["downloads"], groupBy: ["store"] },
          }}
          data={value}
          placement={{ x: 0, y: 0, w, h: 3 }}
          showHeader
        />,
        "de",
      );
    // A narrow tile puts each store on its own line: two freshness lines.
    const narrow = table(data(), 3);
    expect(narrow.match(/sw-measure-freshness/g)?.length).toBe(2);
  });
});
