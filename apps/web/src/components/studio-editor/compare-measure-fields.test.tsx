import { afterEach, describe, expect, it } from "vitest";

import type {
  CompareMeasurePreview,
  CompareMeasureResponse,
  PublishedModelCatalog,
  WorkspaceMetric,
} from "@netrics/contracts";
import { COMPARE_MEASURE_REFUSALS } from "@netrics/domain";

import {
  boundErrorKey,
  boundMeasureOf,
  compareMeasureRequestOf,
  compareMeasureSource,
  compareRefusalOf,
  defaultMeasureName,
  readSavedMeasure,
  savedMeasureOf,
  unpinnedSides,
  writeSavedMeasure,
  type CompareWidget,
} from "@/lib/compare-measure";
import { renderI18n } from "@/lib/i18n/test-render";

import {
  CompareMeasureBoundView,
  CompareMeasureSaveView,
  type CompareMeasureSaveViewProps,
  type SaveFlow,
} from "./compare-measure-fields";
import { WidgetPanel } from "./widget-panel";

// "Save as measure" and the rebind of compare widgets (#508), state by
// state, in English and German.

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const noop = () => undefined;
const WORKSPACE = ID(1);
const MODEL = ID(30);

const signups = {
  connectionId: ID(9),
  connectionName: "Shop",
  key: "shop.signups",
  name: "Signups",
  description: "",
  kind: "delta",
  unit: "count",
  granularity: "day",
  dimensions: ["resource"],
  aggregations: ["sum", "avg"],
  better: "higher",
  role: "primary",
} as WorkspaceMetric;
const visits = { ...signups, key: "shop.visits", name: "Visits" };
const proceeds = {
  ...signups,
  key: "shop.proceeds",
  name: "Proceeds",
  unit: "currency_minor",
  dimensions: ["resource", "currency"],
} as WorkspaceMetric;

const widget: CompareWidget = {
  type: "compare",
  id: ID(20),
  x: 0,
  y: 0,
  w: 4,
  h: 3,
  title: null,
  connectionId: ID(9),
  metricKey: "shop.signups",
  aggregation: "sum",
  period: "last_7_days",
  dimensions: { resource: "app-1" },
  displayCurrency: null,
  resourceName: null,
  allResourcesName: null,
  denominator: {
    connectionId: ID(9),
    metricKey: "shop.visits",
    aggregation: "avg",
    dimensions: {},
    resourceName: null,
    allResourcesName: null,
  },
  options: { format: "percent", ratioLabel: "conversion", showChange: true },
};
const binding = {
  modelId: MODEL,
  dateDimensionId: "date",
  measureIds: {
    numerator: "numerator",
    denominator: "denominator",
    ratio: "ratio",
  },
};
const result: CompareMeasureResponse = {
  preparationId: ID(31),
  datasetId: `prepared:${ID(31)}:compare`,
  modelId: MODEL,
  modelVersion: 1,
  dateDimensionId: "date",
  measures: {
    numerator: "numerator",
    denominator: "denominator",
    ratio: "ratio",
    previous: "ratio_previous",
    change: "ratio_change",
  },
};
const saved = savedMeasureOf(result, widget, "Conversion");
const preview: CompareMeasurePreview = {
  preparation: {
    name: "Conversion",
    steps: [
      { id: "numerator_source", type: "source" },
      { id: "numerator_scope", type: "filter" },
      { id: "numerator_tag", type: "calculate" },
      { id: "denominator_source", type: "source" },
      { id: "denominator_tag", type: "calculate" },
      { id: "compare", type: "append" },
    ],
  },
  model: { name: "Conversion" },
  dateDimensionId: "date",
  measures: {
    numerator: { id: "numerator", name: "Signups" },
    denominator: { id: "denominator", name: "Visits" },
    ratio: { id: "ratio", name: "Conversion" },
    previous: { id: "ratio_previous", name: "Conversion · previous period" },
    change: { id: "ratio_change", name: "Conversion · change (pt)" },
  },
  currency: null,
};
const catalog: PublishedModelCatalog["models"] = [
  {
    modelId: MODEL,
    modelName: "Conversion",
    measures: [
      { id: "numerator", name: "Signups" },
      { id: "denominator", name: "Visits" },
      { id: "ratio", name: "Conversion" },
    ],
    dimensions: [{ id: "date", name: "Date", type: "date" }],
  },
];

function save(
  flow: SaveFlow,
  overrides: Partial<CompareMeasureSaveViewProps> = {},
  locale: "en" | "de" = "en",
) {
  return renderI18n(
    <CompareMeasureSaveView
      flow={flow}
      name="Conversion"
      canPublish
      workspaceId={WORKSPACE}
      published={null}
      currencies={null}
      pin=""
      onName={noop}
      onPreview={noop}
      onPin={noop}
      onCreate={noop}
      onBack={noop}
      onCheckAgain={noop}
      onBind={noop}
      {...overrides}
    />,
    locale,
  );
}
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");

describe("save as measure: states", () => {
  it("idle: names the measure and offers the preview", () => {
    const en = text(save({ step: "idle" }));
    expect(en).toContain("Reusable measure");
    expect(en).toContain("Measure name");
    expect(en).toContain("Save as measure…");
    expect(save({ step: "idle" })).toContain('value="Conversion"');
    const de = text(save({ step: "idle" }, {}, "de"));
    expect(de).toContain("Wiederverwendbare Kennzahl");
    expect(de).toContain("Als Kennzahl speichern…");
    // Without a name there is nothing to preview.
    expect(save({ step: "idle" }, { name: " " })).toMatch(
      /<button type="button" disabled="">Save as measure…/,
    );
  });

  it("checking: the button waits", () => {
    expect(save({ step: "checking", currency: null })).toMatch(
      /<button type="button" disabled="">Checking…/,
    );
    expect(
      text(save({ step: "checking", currency: null }, {}, "de")),
    ).toContain("Wird geprüft…");
  });

  it("preview: what will be created, before creating anything", () => {
    const flow: SaveFlow = { step: "preview", currency: null, preview };
    const en = text(save(flow));
    expect(en).toContain("This creates:");
    expect(en).toContain("Preparation “Conversion” (6 steps), published");
    expect(en).toContain("Model “Conversion”, saved as a draft");
    expect(en).toContain(
      "Measures: Signups, Visits, Conversion, Conversion · previous period, and Conversion · change (pt)",
    );
    expect(en).toContain("Works with every period");
    expect(en).toContain("Create the draft");
    expect(en).not.toContain("are counted");
    const de = text(save(flow, {}, "de"));
    expect(de).toContain("Das wird erstellt:");
    expect(de).toContain(
      "Aufbereitung „Conversion“ (6 Schritte), veröffentlicht",
    );
    expect(de).toContain("Modell „Conversion“, als Entwurf gespeichert");
    expect(de).toContain("Funktioniert mit jedem Zeitraum");
    expect(de).toContain("Entwurf erstellen");
    // While creating, nothing can be clicked twice.
    expect(save({ ...flow, creating: true })).toMatch(
      /<button type="button" class="primary" disabled="">Creating…/,
    );
  });

  it.each(COMPARE_MEASURE_REFUSALS)(
    "refusal %s: a translated reason",
    (code) => {
      const flow: SaveFlow = { step: "refused", code, currency: null };
      const en = text(save(flow, { currencies: ["EUR"], pin: "EUR" }));
      const de = text(save(flow, { currencies: ["EUR"], pin: "EUR" }, "de"));
      expect(en).toContain("This compare can’t be saved as a measure");
      expect(de).toContain(
        "Dieser Vergleich kann nicht als Kennzahl gespeichert werden",
      );
      const reason = {
        compare_aggregation_unsupported: [
          "Minimum, maximum and latest can’t be measures.",
          "Minimum, Maximum und letzter Wert können keine Kennzahlen sein.",
        ],
        compare_currency_unpinned: [
          "Pick one currency to count.",
          "Wähle eine Währung, die gezählt wird.",
        ],
        compare_granularity_unsupported: [
          "Only daily metrics can be measures",
          "Nur tägliche Metriken können Kennzahlen sein",
        ],
        compare_source_unavailable: [
          "has no data to build on yet",
          "hat noch keine Daten als Grundlage",
        ],
        compare_dimension_unknown: [
          "Remove the filter and try again.",
          "Entferne den Filter und versuche es erneut.",
        ],
        compare_units_incompatible: [
          "can’t form this ratio as a measure",
          "nicht als Kennzahl bilden",
        ],
      }[code];
      expect(en).toContain(reason[0]);
      expect(de).toContain(reason[1]);
      expect(save(flow)).toContain('role="alert"');
    },
  );

  it("pinned-currency retry: pick a currency and try again", () => {
    const flow: SaveFlow = {
      step: "refused",
      code: "compare_currency_unpinned",
      currency: null,
    };
    const html = save(flow, { currencies: ["EUR", "USD"], pin: "USD" });
    expect(html).toContain('<option value="EUR">EUR</option>');
    expect(html).toMatch(/<option value="USD" selected="">USD<\/option>/);
    expect(text(html)).toContain("Currency to count");
    expect(text(html)).toContain("Try again with USD");
    // The plain preview button gives way to the retry.
    expect(text(html)).not.toContain("Save as measure…");
    expect(
      text(save(flow, { currencies: ["EUR"], pin: "EUR" }, "de")),
    ).toContain("Mit EUR erneut versuchen");
    expect(text(save(flow, { currencies: null }))).toContain(
      "Loading currencies…",
    );
    expect(text(save(flow, { currencies: [] }, "de"))).toContain(
      "keine Beträge",
    );
    // The retry's preview says which currency is counted.
    const pinned = text(
      save({
        step: "preview",
        currency: "USD",
        preview: { ...preview, currency: "USD" },
      }),
    );
    expect(pinned).toContain("Only amounts in USD are counted");
    expect(
      text(
        save(
          {
            step: "preview",
            currency: "USD",
            preview: { ...preview, currency: "USD" },
          },
          {},
          "de",
        ),
      ),
    ).toContain("Nur Beträge in USD werden gezählt");
  });

  it("keeps the currency picker after a pinned retry is refused", () => {
    const flow: SaveFlow = {
      step: "refused",
      code: "compare_units_incompatible",
      currency: "USD",
    };
    const html = text(save(flow, { currencies: ["EUR", "USD"], pin: "EUR" }));
    expect(html).toContain("can’t form this ratio as a measure");
    expect(html).toContain("Currency to count");
    expect(html).toContain("Try again with EUR");
    // A refusal without a pin offers no picker.
    expect(
      text(
        save(
          { ...flow, currency: null },
          { currencies: ["EUR", "USD"], pin: "EUR" },
        ),
      ),
    ).not.toContain("Currency to count");
  });

  it("says when the currencies can't load, and offers to try again", () => {
    const flow: SaveFlow = {
      step: "refused",
      code: "compare_currency_unpinned",
      currency: null,
    };
    const html = text(
      save(flow, { currencies: null, currencyError: "Network down." }),
    );
    expect(html).toContain("Network down.");
    expect(html).not.toContain("Loading currencies…");
    expect(html).toContain("Load the currencies again");
    expect(
      text(save(flow, { currencies: null, currencyError: "Netz weg." }, "de")),
    ).toContain("Währungen erneut laden");
  });

  it("other failures: the API's message", () => {
    expect(
      text(save({ step: "failed", message: "Try again later." })),
    ).toContain("This compare couldn’t be checked (Try again later.)");
  });

  it("compiled draft: publish it in Data & measures", () => {
    const html = save({ step: "draft", saved });
    expect(text(html)).toContain("Draft model “Conversion” created");
    expect(text(html)).toContain("Open the model to publish it");
    expect(html).toContain(
      `href="/workspaces/${WORKSPACE}/data?model=${MODEL}"`,
    );
    expect(html).toContain('target="_blank"');
    expect(text(html)).toContain("I published it, check again");
    expect(text(html)).not.toContain("The model isn’t published yet.");
    expect(text(save({ step: "draft", saved, stillDraft: true }))).toContain(
      "The model isn’t published yet.",
    );
    const de = text(save({ step: "draft", saved }, {}, "de"));
    expect(de).toContain("Modellentwurf „Conversion“ erstellt");
    expect(de).toContain("Modell zum Veröffentlichen öffnen");
  });

  it("publish blocked without data:publish: says why", () => {
    const html = text(save({ step: "draft", saved }, { canPublish: false }));
    expect(html).toContain("You can’t publish models");
    expect(html).toContain("“publish data” permission");
    expect(html).not.toContain("Open the model to publish it");
    expect(
      text(save({ step: "draft", saved }, { canPublish: false }, "de")),
    ).toContain("Du kannst keine Modelle veröffentlichen");
    // Nor can such a member save one.
    const idle = text(save({ step: "idle" }, { canPublish: false }));
    expect(idle).toContain("Saving as a measure needs the “publish data”");
    expect(idle).not.toContain("Save as measure…");
    expect(text(save({ step: "idle" }, { canPublish: false }, "de"))).toContain(
      "brauchst du die Berechtigung „Daten veröffentlichen“",
    );
  });

  it("published: offers the rebind", () => {
    const flow: SaveFlow = { step: "draft", saved };
    const en = text(save(flow, { published: { modelName: "Conversion" } }));
    expect(en).toContain("Model “Conversion” is published");
    expect(en).toContain("Use the measure in this widget");
    expect(en).toContain("only after you save the dashboard");
    const de = text(
      save(flow, { published: { modelName: "Conversion" } }, "de"),
    );
    expect(de).toContain("Modell „Conversion“ ist veröffentlicht");
    expect(de).toContain("Kennzahl in diesem Widget nutzen");
  });
});

function bound(
  props: Partial<Parameters<typeof CompareMeasureBoundView>[0]> = {},
  locale: "en" | "de" = "en",
) {
  return renderI18n(
    <CompareMeasureBoundView
      workspaceId={WORKSPACE}
      modelId={MODEL}
      bound={boundMeasureOf(binding, catalog)}
      error={null}
      kept={{ numerator: "Signups", denominator: "Visits" }}
      onUnbind={noop}
      {...props}
    />,
    locale,
  );
}

describe("bound compare widgets", () => {
  it("bound: names the measure and links to its model", () => {
    const html = bound();
    expect(text(html)).toContain("Uses measure Conversion from Conversion");
    expect(html).toContain(
      `<a href="/workspaces/${WORKSPACE}/data?model=${MODEL}" target="_blank" rel="noopener">Conversion</a>`,
    );
    expect(text(html)).toContain("Kept: Signups / Visits");
    expect(html).not.toContain('role="alert"');
    const de = text(bound({}, "de"));
    expect(de).toContain("Nutzt die Kennzahl Conversion aus Conversion");
    expect(de).toContain("Erhalten: Signups / Visits");
  });

  it("unbind: brings back the inline definition", () => {
    const en = text(bound());
    expect(en).toContain("Use the metrics again");
    expect(en).toContain("shows its own metrics again");
    expect(text(bound({}, "de"))).toContain("Wieder die Metriken nutzen");
  });

  it("error states: unpublished, removed, and the reading's error", () => {
    const unpublished = bound({ bound: boundMeasureOf(binding, []) });
    expect(text(unpublished)).toContain("The model isn’t published");
    expect(unpublished).toContain('role="alert"');
    expect(text(unpublished)).toContain("Open the model");
    expect(text(bound({ bound: boundMeasureOf(binding, []) }, "de"))).toContain(
      "Das Modell ist nicht veröffentlicht",
    );
    const withoutRatio = [
      {
        ...catalog[0]!,
        measures: catalog[0]!.measures.filter((m) => m.id !== "ratio"),
      },
    ];
    const removed = bound({ bound: boundMeasureOf(binding, withoutRatio) });
    expect(text(removed)).toContain("A measure this widget uses was removed");
    expect(
      text(bound({ bound: boundMeasureOf(binding, withoutRatio) }, "de")),
    ).toContain("Eine Kennzahl dieses Widgets wurde");
    expect(
      text(bound({ error: "The published measures can’t form" })),
    ).toContain("The published measures can’t form");
    // The reading's specific error wins over the catalog's guess.
    const dimension = text(
      bound({
        bound: boundMeasureOf(binding, [{ ...catalog[0]!, dimensions: [] }]),
        error: "The model’s date dimension was removed.",
      }),
    );
    expect(dimension).toContain("The model’s date dimension was removed.");
    expect(dimension).not.toContain("A measure this widget uses was removed");
  });
});

describe("the inspector of a compare widget", () => {
  const panel = (w: CompareWidget, locale: "en" | "de" = "en") =>
    renderI18n(
      <WidgetPanel
        widget={w}
        workspaceId={WORKSPACE}
        metrics={[signups, visits]}
        images={[]}
        problems={[]}
        dispatch={noop}
        models={catalog}
        canPublishData
      />,
      locale,
    );

  it("offers “Save as measure” beside the metrics while unbound", () => {
    const html = text(panel(widget));
    expect(html).toContain("Numerator");
    expect(html).toContain("Denominator");
    expect(html).toContain("Save as measure…");
  });

  it("shows the binding instead of the metrics while bound, keeping the period", () => {
    const html = panel({ ...widget, measure: binding });
    expect(text(html)).toContain("Uses measure Conversion from Conversion");
    expect(text(html)).not.toContain("Numerator");
    expect(text(html)).not.toContain("Save as measure…");
    expect(html).toContain('id="widget-period"');
    expect(text(panel({ ...widget, measure: binding }, "de"))).toContain(
      "Wieder die Metriken nutzen",
    );
  });
});

describe("compare measure helpers", () => {
  // Node has no sessionStorage: a stand-in for this tab's.
  const store = new Map<string, string>();
  globalThis.sessionStorage ??= {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage;
  afterEach(() => sessionStorage.clear());

  it("asks for the widget's sides, period, format and pinned currency", () => {
    expect(compareMeasureRequestOf(widget, " Conversion ", "EUR")).toEqual({
      name: "Conversion",
      connectionId: ID(9),
      metricKey: "shop.signups",
      aggregation: "sum",
      period: "last_7_days",
      dimensions: { resource: "app-1" },
      denominator: {
        connectionId: ID(9),
        metricKey: "shop.visits",
        aggregation: "avg",
      },
      format: "percent",
      currency: "EUR",
    });
  });

  it("knows the refusal codes", () => {
    for (const code of COMPARE_MEASURE_REFUSALS)
      expect(compareRefusalOf(code)).toBe(code);
    expect(compareRefusalOf("forbidden")).toBeNull();
  });

  it("suggests a name", () => {
    expect(defaultMeasureName(widget, signups, visits)).toBe("conversion");
    expect(
      defaultMeasureName(
        { ...widget, options: { ...widget.options, ratioLabel: null } },
        signups,
        visits,
      ),
    ).toBe("Signups / Visits");
    expect(
      defaultMeasureName(
        { ...widget, title: "Shop conversion" },
        signups,
        visits,
      ),
    ).toBe("Shop conversion");
  });

  it("finds the sides that need a pinned currency", () => {
    expect(unpinnedSides(widget, proceeds, visits)).toEqual([
      { side: "numerator", metric: proceeds, resourceId: "app-1" },
    ]);
    expect(
      unpinnedSides(
        { ...widget, dimensions: { currency: "EUR" } },
        proceeds,
        visits,
      ),
    ).toEqual([]);
    // The same metric on both sides: the side, and its resource, decide.
    expect(
      unpinnedSides(
        {
          ...widget,
          dimensions: { currency: "EUR", resource: "app-1" },
          denominator: {
            ...widget.denominator,
            dimensions: { resource: "app-2" },
          },
        },
        proceeds,
        proceeds,
      ),
    ).toEqual([{ side: "denominator", metric: proceeds, resourceId: "app-2" }]);
  });

  it("keeps a compiled draft for the widget's sides only", () => {
    expect(readSavedMeasure(WORKSPACE, widget)).toBeNull();
    writeSavedMeasure(WORKSPACE, saved);
    expect(readSavedMeasure(WORKSPACE, widget)).toEqual(saved);
    // The id a new widget gets when the dashboard is saved keeps it.
    expect(readSavedMeasure(WORKSPACE, { ...widget, id: ID(21) })).toEqual(
      saved,
    );
    // Another period reads the same model.
    expect(
      readSavedMeasure(WORKSPACE, { ...widget, period: "this_month" }),
    ).toEqual(saved);
    expect(compareMeasureSource({ ...widget, period: "this_month" })).toBe(
      compareMeasureSource(widget),
    );
    // Filters come back from the database in another key order (JSONB).
    const twoFilters = (dimensions: Record<string, string>) => ({
      ...widget,
      dimensions,
      denominator: { ...widget.denominator, dimensions },
    });
    expect(
      compareMeasureSource(twoFilters({ resource: "app-1", currency: "EUR" })),
    ).toBe(
      compareMeasureSource(twoFilters({ currency: "EUR", resource: "app-1" })),
    );
    // Other sides do not.
    expect(
      readSavedMeasure(WORKSPACE, { ...widget, metricKey: "shop.orders" }),
    ).toBeNull();
    expect(readSavedMeasure(ID(2), widget)).toBeNull();
  });

  it("maps a binding's typed errors", () => {
    expect(boundErrorKey("data_model_not_published")).toBe("unpublished");
    expect(boundErrorKey("model_measure_not_found")).toBe("measureRemoved");
    expect(boundErrorKey("compare_measure_not_found")).toBe("measureRemoved");
    expect(boundErrorKey("model_dimension_not_found")).toBe("dimensionRemoved");
    expect(boundErrorKey("compare_measure_date_required")).toBe("dateRequired");
    expect(boundErrorKey("data_query_timeout")).toBeNull();
  });
});
