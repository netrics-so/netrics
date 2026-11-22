import { describe, expect, it } from "vitest";
import type {
  DashboardWidget,
  PublishedModelCatalog,
} from "@netrics/contracts";
import {
  measureBindingGrains,
  measureFixedGrainDimensions,
} from "@netrics/domain";
import { renderI18n } from "@/lib/i18n/test-render";
import {
  bindingWithStartingGrains,
  LINE_VIEW_LIMIT,
  limitForView,
  MeasureFields,
  optionsForModel,
  groupByForView,
  patchForView,
  valueViewMeasureId,
} from "./measure-fields";

const models: PublishedModelCatalog["models"] = [
  {
    modelId: "00000000-0000-4000-8000-000000000010",
    modelName: "Sales",
    measures: [
      { id: "revenue", name: "Revenue" },
      {
        id: "revenue7",
        name: "Revenue, 7 days",
        requiredDimensions: ["day"],
        perDateDimensions: ["day"],
      },
      // Kept per day, but a filter on one day gives one value.
      { id: "daily", name: "Daily revenue", requiredDimensions: ["day"] },
      { id: "byApp", name: "Revenue per app", requiredDimensions: ["app"] },
    ],
    dimensions: [
      { id: "day", name: "Day", type: "date" },
      { id: "app", name: "App", type: "string" },
    ],
  },
];
const widget = (
  view: "value" | "table" | "bar" | "line",
  measureIds: string[],
  groupBy: string[] = view === "table" ? ["day"] : [],
): Extract<DashboardWidget, { type: "measure" }> =>
  ({
    type: "measure",
    id: "00000000-0000-4000-8000-000000000020",
    x: 0,
    y: 0,
    w: 6,
    h: 3,
    title: null,
    binding: {
      modelId: models[0]!.modelId,
      measureIds,
      groupBy,
      exclusions: [],
    },
    options: { view, limit: 20 },
  }) as Extract<DashboardWidget, { type: "measure" }>;
const render = (
  view: "value" | "table" | "bar" | "line",
  measureIds: string[],
  locale: "en" | "de" = "en",
  groupBy?: string[],
) =>
  renderI18n(
    <MeasureFields
      widget={widget(view, measureIds, groupBy)}
      models={models}
      filters={[]}
      dispatch={() => {}}
      workspaceId="workspace"
    />,
    locale,
  );
const radio = (html: string, name: string) =>
  html.match(new RegExp(`<input[^>]*>(?=${name}<)`))?.[0] ?? "";

describe("measure binding fields", () => {
  it("explains measures shown per date in the single-value view", () => {
    const html = render("value", ["revenue"]);
    expect(radio(html, "Revenue, 7 days")).toContain('disabled=""');
    // A scope on another dimension can still be fixed by a filter.
    expect(radio(html, "Revenue per app")).not.toContain('disabled=""');
    expect(radio(html, "Daily revenue")).not.toContain('disabled=""');
    expect(html).not.toContain("Daily revenue has one value per date");
    expect(radio(html, "Revenue")).not.toContain('disabled=""');
    expect(html).toContain(
      "Revenue, 7 days has one value per date. Show it as a table or chart grouped by Day.",
    );
    expect(render("value", ["revenue"], "de")).toContain(
      "Revenue, 7 days hat einen Wert pro Datum. Zeige die Kennzahl als Tabelle oder Diagramm nach Day.",
    );
    // Tables and charts offer them.
    expect(
      radio(render("table", ["revenue"]), "Revenue, 7 days"),
    ).not.toContain('disabled=""');
  });

  it("keeps a measure with a date grain when switching to a single value", () => {
    expect(valueViewMeasureId(models[0], ["daily", "revenue"])).toBe("daily");
    expect(valueViewMeasureId(models[0], ["revenue7", "byApp"])).toBe("byApp");
    expect(valueViewMeasureId(models[0], ["revenue7"])).toBe("revenue");
  });
});

describe("a value view's grouping (#788)", () => {
  const fieldset = (html: string, legend: string) =>
    html.match(
      new RegExp(`<fieldset[^>]*><legend>${legend}</legend>.*?</fieldset>`),
    )?.[0] ?? "";

  it("shows what a value view is split by, and offers every dimension", () => {
    const html = render("value", ["revenue"], "en", ["app"]);
    const split = fieldset(html, "Split by");
    expect(radio(split, "App")).toContain('type="checkbox"');
    expect(radio(split, "App")).toContain('checked=""');
    expect(radio(split, "Day")).toContain('type="checkbox"');
    expect(radio(split, "Day")).not.toContain('checked=""');
    expect(split).toContain(
      "Shows a line for each group, under their total where the measure adds up. Choose none for a single value.",
    );
    // Its lines are limited as a table's rows are.
    expect(html).toContain("Maximum rows");
    const german = render("value", ["revenue"], "de", ["app"]);
    expect(fieldset(german, "Aufteilen nach")).toContain(
      "Zeigt eine Zeile pro Gruppe, darüber die Summe, wenn sich die Kennzahl addieren lässt. Ohne Auswahl bleibt es ein einzelner Wert.",
    );
  });

  it("offers the split for a plain value, which has no rows to limit", () => {
    const html = render("value", ["revenue"]);
    expect(radio(fieldset(html, "Split by"), "App")).not.toContain(
      'checked=""',
    );
    expect(html).not.toContain("Maximum rows");
  });

  it("keeps tables and charts as they were", () => {
    const table = fieldset(render("table", ["revenue"]), "Group by");
    expect(radio(table, "Day")).toContain('type="checkbox"');
    expect(table).not.toContain("Shows a line for each group");
    const line = fieldset(
      render("line", ["revenue"], "en", ["day"]),
      "Group by",
    );
    expect(radio(line, "Day")).toContain('type="radio"');
    // A line chart runs over dates only.
    expect(line).not.toContain("App<");
  });

  it("keeps the grouping across view switches where the view can show it", () => {
    expect(groupByForView("value", ["app", "day"], models[0])).toEqual([
      "app",
      "day",
    ]);
    expect(groupByForView("table", ["app"], models[0])).toEqual(["app"]);
    expect(groupByForView("bar", ["app", "day"], models[0])).toEqual(["app"]);
    expect(groupByForView("table", ["a", "b", "c", "d"], models[0])).toEqual([
      "a",
      "b",
      "c",
    ]);
    // A plain value stays plain; a table or chart needs a grouping.
    expect(groupByForView("value", [], models[0])).toEqual([]);
    expect(groupByForView("table", [], models[0])).toEqual(["day"]);
    expect(groupByForView("bar", [], models[0])).toEqual(["day"]);
    expect(
      groupByForView("line", [], {
        ...models[0]!,
        dimensions: [...models[0]!.dimensions].reverse(),
      }),
    ).toEqual(["day"]);
  });

  it("gives a template's split tile back after a switch to another view", () => {
    // The total with a line per store (#784): two lines, its own period.
    const split = widget("value", ["revenue"], ["app"]);
    split.options = {
      view: "value",
      limit: 2,
      period: "last_30_days",
      labels: { app: "Store" },
    };
    for (const view of ["table", "bar", "line"] as const) {
      const other = { ...split, ...patchForView(split, view, models[0]) };
      expect(other.options.view).toBe(view);
      expect(other.binding.groupBy).toEqual(["app"]);
      const back = { ...other, ...patchForView(other, "value", models[0]) };
      expect(back.binding).toEqual(split.binding);
      expect(back.options).toEqual(split.options);
    }
  });
});

describe("switching the model (#784)", () => {
  it("drops the old model's period, order and labels", () => {
    expect(
      optionsForModel(
        {
          view: "value",
          limit: 2,
          period: "last_30_days",
          order: { measureId: "downloads", direction: "desc" },
          labels: { downloads: "Downloads" },
        },
        models[0]!,
      ),
    ).toEqual({ view: "value", limit: 2 });
    // A measure that needs a grouping opens as a table.
    expect(
      optionsForModel(
        { view: "value", limit: 20 },
        {
          measures: [{ id: "byApp", requiredDimensions: ["app"] }],
        },
      ).view,
    ).toBe("table");
  });
});

describe("a line chart's maximum rows (#835)", () => {
  it("shows a year of points when switched to with the default untouched", () => {
    expect(limitForView("line", 20)).toBe(LINE_VIEW_LIMIT);
    expect(LINE_VIEW_LIMIT).toBeGreaterThanOrEqual(365);
    // A chosen limit stays.
    expect(limitForView("line", 31)).toBe(31);
    // Leaving the line chart restores the default it set.
    expect(limitForView("bar", LINE_VIEW_LIMIT)).toBe(20);
    expect(limitForView("table", 50)).toBe(50);
  });
});

describe("a time grain next to a grouped time dimension (#838)", () => {
  const photos: PublishedModelCatalog["models"] = [
    {
      modelId: "00000000-0000-4000-8000-000000000011",
      modelName: "Photos",
      measures: [{ id: "photos", name: "Photos" }],
      dimensions: [
        { id: "taken", name: "Taken", type: "timestamp" },
        { id: "day", name: "Day", type: "date" },
        { id: "album", name: "Album", type: "string" },
      ],
    },
  ];
  const grouped = (
    view: "value" | "table" | "bar" | "line",
    groupBy: string[],
    groupByGrain?: Record<string, "day" | "week" | "month">,
  ) => {
    const base = widget(view, ["photos"], groupBy);
    return {
      ...base,
      binding: {
        ...base.binding,
        modelId: photos[0]!.modelId,
        ...(groupByGrain ? { groupByGrain } : {}),
      },
    };
  };
  const html = (
    measure: ReturnType<typeof grouped>,
    locale: "en" | "de" = "en",
  ) =>
    renderI18n(
      <MeasureFields
        widget={measure}
        models={photos}
        filters={[]}
        dispatch={() => {}}
        workspaceId="workspace"
      />,
      locale,
    );
  const grain = (markup: string, label: string) =>
    markup.match(
      new RegExp(`<select aria-label="${label}"[^>]*>.*?</select>`),
    )?.[0] ?? "";

  it("offers day, week and month for a grouped timestamp", () => {
    const markup = html(grouped("table", ["taken", "album"]));
    const select = grain(markup, "Taken: one group per");
    expect(select).toContain('<option value="" selected="">Each time</option>');
    expect(select).toContain('<option value="day">Day</option>');
    expect(select).toContain('<option value="week">Week</option>');
    expect(select).toContain('<option value="month">Month</option>');
    // Only time dimensions the widget groups by have one.
    expect(markup.match(/<select aria-label="[^"]*: one group per"/g)).toEqual([
      '<select aria-label="Taken: one group per"',
    ]);
    const chosen = grain(
      html(grouped("line", ["taken"], { taken: "day" })),
      "Taken: one group per",
    );
    expect(chosen).toContain('<option value="day" selected="">Day</option>');
  });

  it("offers week and month for a date, which is its own day", () => {
    const select = grain(
      html(grouped("table", ["day"], { day: "week" })),
      "Day: one group per",
    );
    expect(select).toContain('<option value="">Day</option>');
    expect(select).not.toContain('value="day"');
    expect(select).toContain('<option value="week" selected="">Week</option>');
  });

  it("words the choice in German", () => {
    const select = grain(
      html(grouped("value", ["taken"], { taken: "month" }), "de"),
      "Taken: eine Gruppe pro",
    );
    expect(select).toContain('<option value="">Zeitpunkt</option>');
    expect(select).toContain('<option value="day">Tag</option>');
    expect(select).toContain('<option value="week">Woche</option>');
    expect(select).toContain(
      '<option value="month" selected="">Monat</option>',
    );
  });

  it("keeps the grain across view switches, with its dimension", () => {
    const table = grouped("table", ["taken", "album"], { taken: "day" });
    for (const view of ["value", "bar", "line"] as const) {
      const other = { ...table, ...patchForView(table, view, photos[0]) };
      expect(other.binding.groupBy[0]).toBe("taken");
      expect(other.binding.groupByGrain).toEqual({ taken: "day" });
      const back = { ...other, ...patchForView(other, "table", photos[0]) };
      expect(back.binding.groupByGrain).toEqual({ taken: "day" });
    }
    // A chart shows the first dimension only: the second's grain goes with it.
    const two = grouped("table", ["album", "taken"], { taken: "week" });
    const bar = patchForView(two, "bar", photos[0]);
    expect(bar.binding.groupBy).toEqual(["album"]);
    expect("groupByGrain" in bar.binding).toBe(false);
  });

  // A model whose measures are read per value of a date (review 2 of #852).
  const windowed: PublishedModelCatalog["models"] = [
    {
      modelId: "00000000-0000-4000-8000-000000000012",
      modelName: "Sales",
      measures: [
        { id: "revenue", name: "Revenue" },
        {
          id: "revenue7",
          name: "Revenue, 7 days",
          requiredDimensions: ["day"],
          perDateDimensions: ["day"],
          fixedGrainDimensions: ["day"],
        },
        // A comparison with the previous month: groupable by its date or
        // not, but never by weeks or months of it.
        {
          id: "previous",
          name: "Revenue, previous month",
          fixedGrainDimensions: ["day"],
        },
        {
          id: "perSale",
          name: "Revenue per sale",
          requiredDimensions: ["sold"],
          fixedGrainDimensions: ["sold"],
        },
      ],
      dimensions: [
        { id: "day", name: "Day", type: "date" },
        { id: "sold", name: "Sold at", type: "timestamp" },
      ],
    },
  ];
  const sales = (
    measureIds: string[],
    groupBy: string[],
    groupByGrain?: Record<string, "day" | "week" | "month">,
  ) => {
    const base = widget("table", measureIds, groupBy);
    return {
      ...base,
      binding: {
        ...base.binding,
        modelId: windowed[0]!.modelId,
        ...(groupByGrain ? { groupByGrain } : {}),
      },
    };
  };
  const salesHtml = (
    measure: ReturnType<typeof sales>,
    locale: "en" | "de" = "en",
  ) =>
    renderI18n(
      <MeasureFields
        widget={measure}
        models={windowed}
        filters={[]}
        dispatch={() => {}}
        workspaceId="workspace"
      />,
      locale,
    );

  it("offers only the grains the chosen measures can be grouped by", () => {
    // Without a windowed measure: every grain.
    const free = grain(
      salesHtml(sales(["revenue"], ["day"])),
      "Day: one group per",
    );
    expect(free).toContain('<option value="week">Week</option>');
    expect(free).toContain('<option value="month">Month</option>');
    for (const measureId of ["revenue7", "previous"]) {
      const markup = salesHtml(sales(["revenue", measureId], ["day"]));
      const select = grain(markup, "Day: one group per");
      expect(select, measureId).toContain(
        '<option value="" selected="">Day</option>',
      );
      expect(select, measureId).toContain(
        '<option value="week" disabled="">Week</option>',
      );
      expect(select, measureId).toContain(
        '<option value="month" disabled="">Month</option>',
      );
      expect(markup, measureId).toContain(
        "The chosen measures are calculated for each value of Day, so it cannot be grouped into larger periods.",
      );
    }
    // A timestamp a measure is read per value of takes no grain at all.
    const sold = grain(
      salesHtml(sales(["perSale"], ["sold"])),
      "Sold at: one group per",
    );
    expect(sold).toContain('<option value="" selected="">Each time</option>');
    for (const value of ["day", "week", "month"])
      expect(sold).toContain(`<option value="${value}" disabled=""`);
    expect(salesHtml(sales(["revenue", "revenue7"], ["day"]), "de")).toContain(
      "Die gewählten Kennzahlen werden für jeden Wert von Day berechnet; größere Zeiträume sind deshalb nicht möglich.",
    );
  });

  it("drops a grain the measures no longer allow when one is added", () => {
    const markup = renderI18n(
      <MeasureFields
        widget={sales(["revenue"], ["day"], { day: "week" })}
        models={windowed}
        filters={[]}
        dispatch={() => {}}
        workspaceId="workspace"
      />,
    );
    expect(grain(markup, "Day: one group per")).toContain(
      '<option value="week" selected="">Week</option>',
    );
    // What ticking "Revenue, 7 days" dispatches.
    const next = measureBindingGrains(
      {
        ...sales(["revenue"], ["day"], { day: "week" }).binding,
        measureIds: ["revenue", "revenue7"],
      },
      {
        dimensions: windowed[0]!.dimensions,
        reset: measureFixedGrainDimensions(windowed[0]!.measures, [
          "revenue",
          "revenue7",
        ]),
      },
    );
    expect("groupByGrain" in next).toBe(false);
    // A view switch that keeps a windowed measure does the same.
    const switched = patchForView(
      sales(["revenue7"], ["day"], { day: "month" }),
      "line",
      windowed[0],
    );
    expect("groupByGrain" in switched.binding).toBe(false);
    // A date stored per day reads as the date it is.
    const perDay = patchForView(
      sales(["revenue"], ["day"], { day: "day" }),
      "bar",
      windowed[0],
    );
    expect("groupByGrain" in perDay.binding).toBe(false);
  });

  describe("a newly grouped timestamp starts per day (#853)", () => {
    it("selects Day for a ticked timestamp, in English and German", () => {
      // What ticking "Taken" dispatches for a table grouped by "Album".
      const before = grouped("table", ["album"]);
      const binding = bindingWithStartingGrains(
        { ...before.binding, groupBy: ["album", "taken"] },
        before.binding.groupBy,
        photos[0],
      );
      expect(binding.groupByGrain).toEqual({ taken: "day" });
      const ticked = { ...before, binding };
      const en = grain(html(ticked), "Taken: one group per");
      expect(en).toContain('<option value="day" selected="">Day</option>');
      // "Each time" stays a choice.
      expect(en).toContain('<option value="">Each time</option>');
      const de = grain(html(ticked, "de"), "Taken: eine Gruppe pro");
      expect(de).toContain('<option value="day" selected="">Tag</option>');
      expect(de).toContain('<option value="">Zeitpunkt</option>');
    });

    it("leaves a timestamp the widget already groups by as it is", () => {
      // A saved or API-made widget per instant: ticking another dimension,
      // or choosing "Each time", is no new grouping of the timestamp.
      const saved = grouped("table", ["taken"]);
      const more = bindingWithStartingGrains(
        { ...saved.binding, groupBy: ["taken", "album"] },
        saved.binding.groupBy,
        photos[0],
      );
      expect("groupByGrain" in more).toBe(false);
      expect(
        grain(html(saved), "Taken: one group per"),
        "opened in Studio",
      ).toContain('<option value="" selected="">Each time</option>');
      const weekly = grouped("table", ["taken"], { taken: "week" });
      expect(
        bindingWithStartingGrains(
          { ...weekly.binding, groupBy: ["taken", "album"] },
          weekly.binding.groupBy,
          photos[0],
        ).groupByGrain,
      ).toEqual({ taken: "week" });
      // Each view keeps it too.
      for (const view of ["value", "bar", "line"] as const)
        expect(
          "groupByGrain" in patchForView(saved, view, photos[0]).binding,
          view,
        ).toBe(false);
    });

    it("has no grain to start a date or another dimension with", () => {
      const before = grouped("table", []);
      const binding = bindingWithStartingGrains(
        { ...before.binding, groupBy: ["day", "album"] },
        [],
        photos[0],
      );
      expect("groupByGrain" in binding).toBe(false);
    });

    it("starts per day again once unticked and ticked again", () => {
      const unticked = grouped("table", ["album"]);
      expect(
        bindingWithStartingGrains(
          { ...unticked.binding, groupBy: ["album", "taken"] },
          unticked.binding.groupBy,
          photos[0],
        ).groupByGrain,
      ).toEqual({ taken: "day" });
      // A chart's choice replaces the one before it.
      const bar = grouped("bar", ["album"]);
      expect(
        bindingWithStartingGrains(
          { ...bar.binding, groupBy: ["taken"] },
          bar.binding.groupBy,
          photos[0],
        ).groupByGrain,
      ).toEqual({ taken: "day" });
    });

    it("groups the timestamp a view starts with per day", () => {
      // A line chart of a plain value takes the model's first time
      // dimension; a table or bar chart its first dimension.
      const value = grouped("value", []);
      for (const view of ["table", "bar", "line"] as const) {
        const next = patchForView(value, view, photos[0]);
        expect(next.binding.groupBy, view).toEqual(["taken"]);
        expect(next.binding.groupByGrain, view).toEqual({ taken: "day" });
      }
    });

    it("follows what the chosen measures accept", () => {
      // "Revenue per sale" is read per value of "Sold at": no grain.
      const perSale = sales(["perSale"], []);
      const fixed = bindingWithStartingGrains(
        { ...perSale.binding, groupBy: ["sold"] },
        [],
        windowed[0],
      );
      expect("groupByGrain" in fixed).toBe(false);
      expect(
        grain(
          salesHtml({ ...perSale, binding: fixed }),
          "Sold at: one group per",
        ),
      ).toContain('<option value="" selected="">Each time</option>');
      // With a measure that leaves it free, it starts per day.
      const free = sales(["revenue"], []);
      expect(
        bindingWithStartingGrains(
          { ...free.binding, groupBy: ["sold"] },
          [],
          windowed[0],
        ).groupByGrain,
      ).toEqual({ sold: "day" });
      // Adding the measure afterwards takes the day back (#838).
      const added = patchForView(
        sales(["perSale"], ["sold"], { sold: "day" }),
        "table",
        windowed[0],
      );
      expect("groupByGrain" in added.binding).toBe(false);
    });

    it("leaves the dimension a click filters by ungrouped into days", () => {
      // A declared click-to-filter reads the dimension's own values; a
      // bucketed one is refused, so the default stays out of its way.
      const filters = [
        {
          id: "when",
          name: "When",
          mappings: [{ modelId: photos[0]!.modelId, dimensionId: "taken" }],
        },
      ] as unknown as Parameters<typeof bindingWithStartingGrains>[3];
      const before = grouped("table", ["album"]);
      const binding = bindingWithStartingGrains(
        {
          ...before.binding,
          groupBy: ["album", "taken"],
          interaction: { filterId: "when" },
        },
        before.binding.groupBy,
        photos[0],
        filters,
      );
      expect("groupByGrain" in binding).toBe(false);
    });

    it("changes nothing without the widget's model", () => {
      const before = grouped("table", []);
      const binding = { ...before.binding, groupBy: ["taken"] };
      expect(bindingWithStartingGrains(binding, [], undefined)).toBe(binding);
    });
  });
});
