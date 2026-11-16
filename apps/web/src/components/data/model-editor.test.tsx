import { describe, expect, it, vi } from "vitest";
import type { DataImpact } from "@netrics/contracts";
import {
  emptyVisualModel,
  type ModelMeasure,
  type SemanticModelDefinition,
} from "@netrics/domain";
import type { ExpressionDraft } from "@/lib/expression-draft";
import { renderI18n } from "@/lib/i18n/test-render";
import type { DataSource, ModelDraft } from "@/lib/data-api";
import { startHistory } from "@/lib/edit-history";
import {
  changeModelDefinition,
  ModelEditor,
  modelEditorState,
  modelImpact,
  dimensionLabels,
  measureLabels,
  newAggregateMeasure,
  newDimension,
  PreviewScopeHint,
  renameMeasure,
} from "./model-editor";
import { changeAggregateOperation, unfitAggregateField } from "./fields";

const source: DataSource = {
  id: "sales",
  name: "Sales",
  kind: "source",
  fields: [
    { id: "date", name: "Date", type: "date", nullable: false },
    { id: "at", name: "Ordered at", type: "timestamp", nullable: false },
    { id: "app", name: "App", type: "string", nullable: false },
    { id: "amount", name: "Amount", type: "decimal", nullable: true },
  ],
  generationId: null,
  rowCount: null,
  schemaVersion: 1,
  aggregated: false,
  expiresAt: null,
  connectionId: null,
};
const definition = (
  measures: SemanticModelDefinition["measures"],
): SemanticModelDefinition => ({
  version: 1,
  datasets: ["sales"],
  relationships: [],
  dimensions: [
    { id: "app", name: "App dimension", datasetId: "sales", fieldId: "app" },
    {
      id: "day",
      name: "Reporting day",
      datasetId: "sales",
      fieldId: "date",
      timeAlignment: "reporting_date",
    },
    {
      id: "moment",
      name: "Order moment",
      datasetId: "sales",
      fieldId: "at",
      timeAlignment: "instant",
    },
  ],
  measures,
});
const revenue = {
  id: "revenue",
  name: "Revenue",
  kind: "aggregate",
  datasetId: "sales",
  aggregate: { id: "revenue", name: "Revenue", op: "sum", fieldId: "amount" },
} as const;
const ratio = {
  id: "ratio",
  name: "Ratio formula",
  kind: "formula",
  expression: { kind: "literal", type: "integer", value: 1 },
} as const;
const rolling = {
  id: "rolling",
  name: "Revenue 7 days",
  kind: "rolling",
  baseMeasureId: "revenue",
  timeDimensionId: "day",
  window: { unit: "week", length: 2 },
} as const;
const previous = {
  id: "previous",
  name: "Revenue last week",
  kind: "period_offset",
  baseMeasureId: "rolling",
  timeDimensionId: "day",
  offset: { unit: "week", length: 1 },
  output: "value",
} as const;
const draft = (measures: SemanticModelDefinition["measures"]): ModelDraft => ({
  id: "00000000-0000-4000-8000-000000000001",
  name: "Sales model",
  definition: definition(measures),
  projectId: null,
  version: 1,
  publishedVersion: null,
  hasUnpublishedChanges: false,
  inputsDiffer: false,
  updatedAt: "2026-11-01T00:00:00.000Z",
});
const render = (
  measures: SemanticModelDefinition["measures"],
  locale: "en" | "de" = "en",
) =>
  renderI18n(
    <ModelEditor
      workspaceId="workspace"
      sources={[source]}
      initial={draft(measures)}
      onSaved={() => {}}
      onClose={() => {}}
      onDirty={() => {}}
    />,
    locale,
  );
/** The markup of the measure card whose name input holds `name`. */
function card(html: string, name: string) {
  const start = html.lastIndexOf(
    '<div class="data-measure">',
    html.indexOf(`value="${name}"`),
  );
  const next = html.indexOf('<div class="data-measure">', start + 1);
  const end = next < 0 ? html.indexOf("</section>", start) : next;
  return html.slice(start, end);
}
/** The <option> labels of the select labelled `label` inside `html`. */
function options(html: string, label: string) {
  const at = html.indexOf(`>${label}</label>`);
  const select = html.slice(
    html.indexOf("<select", at),
    html.indexOf("</select>", at),
  );
  return [...select.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map(
    (m) => m[1],
  );
}
function selected(html: string, label: string) {
  const at = html.indexOf(`>${label}</label>`);
  const select = html.slice(
    html.indexOf("<select", at),
    html.indexOf("</select>", at),
  );
  return select.match(/<option[^>]*selected=""[^>]*>([^<]*)<\/option>/)?.[1];
}

describe("model editor windowed measures", () => {
  it.each([
    [
      "en",
      {
        rolling: "Rolling",
        offset: "Compared with earlier period",
        base: "Based on measure",
        time: "Date dimension",
        compare: "Compare with",
        output: "Show",
        presets: [
          "Previous day",
          "Previous week",
          "Previous month",
          "Same period last year",
          "Previous period of equal length",
          "Custom shift",
        ],
        outputs: ["Earlier value", "Change", "Change in %"],
        add: "Add change measures",
        length: "Window length",
        unit: "Unit",
        weeks: "weeks",
      },
    ],
    [
      "de",
      {
        rolling: "Gleitender Zeitraum",
        offset: "Vergleich mit früherem Zeitraum",
        base: "Ausgangskennzahl",
        time: "Datumsdimension",
        compare: "Vergleichen mit",
        output: "Anzeigen",
        presets: [
          "Vortag",
          "Vorwoche",
          "Vormonat",
          "Gleicher Zeitraum im Vorjahr",
          "Vorheriger Zeitraum gleicher Länge",
          "Eigene Verschiebung",
        ],
        outputs: ["Früherer Wert", "Veränderung", "Veränderung in %"],
        add: "Veränderungen als Kennzahlen hinzufügen",
        length: "Fensterlänge",
        unit: "Einheit",
        weeks: "Wochen",
      },
    ],
  ] as const)("edits rolling and comparison measures in %s", (locale, l) => {
    const html = render([revenue, ratio, rolling, previous], locale);
    expect(html).not.toContain("undefined");
    expect(html).not.toMatch(/data\.[a-zA-Z]+\./);
    const rollingCard = card(html, rolling.name);
    expect(rollingCard).toContain(
      `<option value="rolling" selected="">${l.rolling}`,
    );
    expect(rollingCard).toContain(`<option value="period_offset">${l.offset}`);
    // Rolling re-aggregates rows: formulas and other windows are not offered.
    expect(options(rollingCard, l.base).slice(1)).toEqual(["Revenue"]);
    // Only the date dimension on the reporting date anchors a window.
    expect(options(rollingCard, l.time).slice(1)).toEqual(["Reporting day"]);
    expect(rollingCard).toContain('max="53"');
    expect(rollingCard).toContain('value="2"');
    expect(rollingCard).toContain(l.length);
    expect(selected(rollingCard, l.unit)).toBe(l.weeks);
    expect(rollingCard).not.toContain(l.compare);
    expect(rollingCard).not.toContain(l.add);

    const offsetCard = card(html, previous.name);
    expect(options(offsetCard, l.base).slice(1)).toEqual([
      "Revenue",
      "Ratio formula",
      "Revenue 7 days",
    ]);
    expect(options(offsetCard, l.compare)).toEqual(l.presets);
    expect(selected(offsetCard, l.compare)).toBe(l.presets[1]);
    // A preset hides the custom length and unit inputs.
    expect(offsetCard).not.toContain('type="number"');
    expect(options(offsetCard, l.output)).toEqual(l.outputs);
    expect(offsetCard).toContain(`<button type="button">${l.add}</button>`);
  });

  it("shows the custom shift for offsets outside the presets", () => {
    const html = render([
      revenue,
      {
        ...previous,
        baseMeasureId: "revenue",
        offset: { unit: "day", length: 3 },
      },
    ]);
    const offsetCard = card(html, previous.name);
    expect(selected(offsetCard, "Compare with")).toBe("Custom shift");
    expect(offsetCard).toContain("Shift back by");
    expect(offsetCard).toContain('value="3"');
    expect(offsetCard).toContain('max="366"');
    expect(selected(offsetCard, "Unit")).toBe("days");
  });

  it("selects the preset that matches each stored offset", () => {
    for (const [unit, label] of [
      ["day", "Previous day"],
      ["month", "Previous month"],
      ["year", "Same period last year"],
      ["range", "Previous period of equal length"],
    ] as const) {
      const html = render([
        revenue,
        { ...previous, baseMeasureId: "revenue", offset: { unit, length: 1 } },
      ]);
      expect(selected(card(html, previous.name), "Compare with")).toBe(label);
    }
  });

  it("blocks removing a base measure or anchor date and explains why", () => {
    const html = render([revenue, rolling, previous]);
    const revenueCard = card(html, revenue.name);
    expect(revenueCard).toContain(
      `<button type="button" disabled="" aria-describedby="revenue-in-use">Remove</button>`,
    );
    expect(revenueCard).toContain(
      "Used as the base of Revenue 7 days. Remove or change those measures first.",
    );
    expect(card(html, rolling.name)).toContain(
      "Used as the base of Revenue last week.",
    );
    // The top of the chain can be removed.
    expect(card(html, previous.name)).not.toContain('disabled=""');
    expect(html).toContain(
      'aria-describedby="day-in-use">Remove</button><p class="help" id="day-in-use">Used as the date of Revenue 7 days, Revenue last week.',
    );
    const de = render([revenue, rolling], "de");
    expect(card(de, revenue.name)).toContain(
      "Dient als Ausgangskennzahl für Revenue 7 days.",
    );
  });

  it("keeps rolling bases aggregates and anchor dates on their column", () => {
    const html = render([revenue, rolling, previous]);
    const revenueCard = card(html, revenue.name);
    // A rolling base can only stay an aggregate; the reason is the one shown
    // for blocked removal.
    for (const kind of ["formula", "rolling", "period_offset"])
      expect(revenueCard).toMatch(
        new RegExp(`<option value="${kind}" disabled="">`),
      );
    expect(revenueCard).toMatch(
      /<select aria-describedby="revenue-in-use"[^>]*>/,
    );
    // The rolling measure is only an offset's base: any kind remains possible.
    expect(card(html, rolling.name)).not.toContain(
      '<option value="formula" disabled="">',
    );
    // The anchor date's source and column cannot change while in use.
    const row = html.slice(
      html.lastIndexOf(
        '<div class="data-model-row',
        html.indexOf('value="Reporting day"'),
      ),
      html.indexOf('id="day-in-use"'),
    );
    expect(row.match(/<select[^>]*disabled=""/g)).toHaveLength(2);
    expect(row.match(/aria-describedby="day-in-use"/g)?.length).toBe(3);
  });

  it("shows the length limit and flags lengths beyond it", () => {
    const html = render([
      revenue,
      { ...rolling, window: { unit: "day", length: 400 } },
    ]);
    const rollingCard = card(html, rolling.name);
    // The typed length is kept, not clamped, and explained.
    expect(rollingCard).toContain('value="400"');
    expect(rollingCard).toContain('aria-invalid="true"');
    expect(rollingCard).toContain("Enter 1 to 366 days.");
    expect(rollingCard).toMatch(
      /<p class="error"[^>]*>Enter 1 to 366 days\.<\/p>/,
    );
    const valid = card(render([revenue, rolling]), rolling.name);
    expect(valid).toContain("Up to 53 weeks.");
    expect(valid).not.toContain('aria-invalid="true"');
    expect(
      card(
        render(
          [revenue, { ...rolling, window: { unit: "month", length: 13 } }],
          "de",
        ),
        rolling.name,
      ),
    ).toContain("Gib 1 bis 12 Monate ein.");
  });

  it("disables the change helper once both siblings exist", () => {
    const html = render([
      revenue,
      rolling,
      previous,
      { ...previous, id: "chg", name: "Change sibling", output: "change" },
      {
        ...previous,
        id: "pct",
        name: "Percent sibling",
        output: "percent_change",
      },
    ]);
    expect(card(html, previous.name)).toContain(
      '<button type="button" disabled="">Add change measures</button>',
    );
  });

  it("explains how to anchor a window when no date dimension exists", () => {
    const html = renderI18n(
      <ModelEditor
        workspaceId="workspace"
        sources={[source]}
        initial={{
          ...draft([revenue, { ...rolling, timeDimensionId: "" }]),
          definition: {
            ...definition([revenue, { ...rolling, timeDimensionId: "" }]),
            dimensions: [],
          },
        }}
        onSaved={() => {}}
        onClose={() => {}}
        onDirty={() => {}}
      />,
    );
    const rollingCard = card(html, rolling.name);
    expect(options(rollingCard, "Date dimension")).toEqual(["Choose…"]);
    expect(rollingCard).toContain(
      "Add a dimension on a date column first. Timestamps cannot anchor a window.",
    );
  });

  it.each([
    ["en", "Undo", "Redo"],
    ["de", "Rückgängig", "Wiederholen"],
  ] as const)(
    "offers disabled undo and redo before any edit (%s)",
    (locale, undo, redo) => {
      const html = render([revenue], locale);
      expect(html).toContain(
        `<button type="button" disabled="">${undo}</button>`,
      );
      expect(html).toContain(
        `<button type="button" disabled="">${redo}</button>`,
      );
    },
  );
});

describe("model editor visual builder", () => {
  const sum = (id: string, name: string) =>
    ({
      id,
      name,
      kind: "aggregate",
      datasetId: "sales",
      aggregate: { id, name, op: "sum", fieldId: "amount" },
    }) as const;
  const share: ModelMeasure = {
    id: "share",
    name: "Share formula",
    kind: "formula",
    expression: {
      kind: "call",
      fn: "divide",
      args: [
        { kind: "field", fieldId: "income" },
        { kind: "field", fieldId: "spend" },
      ],
    },
  };
  const filtered: ModelMeasure = {
    ...revenue,
    aggregate: {
      ...revenue.aggregate,
      filter: {
        kind: "call",
        fn: "eq",
        args: [
          { kind: "field", fieldId: "app" },
          { kind: "literal", type: "string", value: "x" },
        ],
      },
    },
  };

  it("shows a calculated measure as a visual division", () => {
    const html = card(
      render([sum("income", "Income"), sum("spend", "Spend"), share]),
      "Share formula",
    );
    expect(html).toContain(
      '<option value="divide" selected="">divided by</option>',
    );
    expect(html).toMatch(/<option value="income" selected="">Income<\/option>/);
    expect(html).toMatch(/<option value="spend" selected="">Spend<\/option>/);
    // The measure does not offer itself.
    expect(html).not.toContain('<option value="share"');
    expect(html).toContain("Measure");
  });

  it("shows a measure filter as rows", () => {
    const html = card(render([filtered]), "Revenue");
    expect(html).toContain("Only include rows where");
    expect(html).toContain('aria-label="Condition 1"');
    expect(html).toContain("Remove filter");
    expect(html).not.toContain("Add a filter");
  });

  it("offers a filter for an unfiltered aggregate", () => {
    const html = card(render([revenue]), "Revenue");
    expect(html).toContain("Add a filter");
    expect(html).not.toContain("Only include rows where");
  });

  it("labels the measure filter in German", () => {
    const html = card(render([filtered], "de"), "Revenue");
    expect(html).toContain("Nur Zeilen einbeziehen, bei denen");
    expect(html).toContain("Filter entfernen");
    expect(card(render([revenue], "de"), "Revenue")).toContain(
      "Filter hinzufügen",
    );
  });

  it("is not dirty when opened", () => {
    const model = definition([filtered, share]);
    const html = renderI18n(
      <ModelEditor
        workspaceId="workspace"
        sources={[source]}
        initial={{ ...draft([]), name: "M", definition: model }}
        onSaved={() => {}}
        onClose={() => {}}
        onDirty={() => {}}
      />,
    );
    expect(html).not.toContain("Unpublished changes");
    // Unedited drafts (a view switched without typing) are not edits.
    expect(
      modelEditorState("M", model, {
        "share:formula": {
          view: "formula",
          text: "[Income] / [Spend]",
          edited: false,
        },
      }),
    ).toBe(modelEditorState("M", model, {}));
    // Key order is not a change.
    const reverse = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reverse)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([key, inner]) => [key, reverse(inner)]),
            )
          : value;
    const reordered = reverse(model) as SemanticModelDefinition;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(model));
    expect(modelEditorState("M", reordered, {})).toBe(
      modelEditorState("M", model, {}),
    );
    expect(
      modelEditorState("M", model, {
        "revenue:filter": {
          view: "formula",
          text: '[App] = "y"',
          edited: true,
        },
      }),
    ).not.toBe(modelEditorState("M", model, {}));
  });

  it("does not count switching an edited draft's view as a change", () => {
    const model = definition([filtered]);
    const rows: ExpressionDraft = {
      view: "visual",
      model: emptyVisualModel("condition"),
      edited: true,
    };
    const text = "[App] = NULL";
    expect(
      modelEditorState("M", model, {
        "revenue:filter": {
          view: "formula",
          text,
          edited: true,
          origin: { text, model: rows.model },
        },
      }),
    ).toBe(modelEditorState("M", model, { "revenue:filter": rows }));
  });
});

describe("model editor edits", () => {
  it("records no undo step for a change that changes nothing", () => {
    const model = definition([revenue]);
    const history = startHistory({ definition: model, expressionDrafts: {} });
    expect(
      changeModelDefinition(history, {
        measures: model.measures.map((m) => ({ ...m })),
      }),
    ).toBe(history);
    const renamed = changeModelDefinition(history, {
      measures: [{ ...revenue, name: "Sales" }],
    });
    expect(renamed.past).toHaveLength(1);
  });
});

describe("model editor publish confirmation", () => {
  const M = "00000000-0000-4000-8000-000000000011";
  const impact = (
    measureIds: string[] | undefined,
    widgets: string[],
  ): DataImpact => ({
    target: measureIds
      ? { kind: "measure", id: M, measureIds }
      : { kind: "model", id: M },
    preparations: [],
    models: [],
    measures: [],
    dashboards: [
      {
        id: "00000000-0000-4000-8000-000000000021",
        name: "Sales",
        widgets: widgets.map((id) => ({ id, type: "measure", title: null })),
        viaFilter: false,
      },
    ],
    screens: [],
    hidden: { preparations: 0, models: 0, dashboards: 0, screens: 0 },
    changedMeasureIds: ["revenue", "removed"],
  });
  const W1 = "00000000-0000-4000-8000-000000000031";
  const W2 = "00000000-0000-4000-8000-000000000032";

  it("marks the widgets of changed measures that are still in the draft", async () => {
    const calls: Array<{ measureIds?: string[] }> = [];
    const read = vi.fn(
      async (
        _workspace: string,
        target: { kind: "preparation" | "model"; measureIds?: string[] },
      ) => {
        calls.push(target);
        return target.measureIds
          ? impact(target.measureIds, [W1])
          : impact(undefined, [W1, W2]);
      },
    );
    const check = await modelImpact(
      "w",
      M,
      definition([revenue, rolling]),
      read,
    );
    expect(calls.map((c) => c.measureIds)).toEqual([undefined, ["revenue"]]);
    expect(check.changedWidgetIds).toEqual([W1]);
    expect(check.impact.dashboards[0]!.widgets).toHaveLength(2);
  });

  it("keeps the impact when the follow-up read fails", async () => {
    let first = true;
    const read = vi.fn(async () => {
      if (first) {
        first = false;
        return impact(undefined, [W1]);
      }
      throw new Error("offline");
    });
    const check = await modelImpact("w", M, definition([revenue]), read);
    expect(check.changedWidgetIds).toBeUndefined();
    expect(check.impact.dashboards).toHaveLength(1);
  });

  it("renders no confirmation until Publish is pressed", () => {
    expect(
      renderI18n(
        <ModelEditor
          workspaceId="w"
          sources={[source]}
          initial={null}
          onSaved={() => undefined}
          onClose={() => undefined}
          onDirty={() => undefined}
        />,
      ),
    ).not.toContain("<dialog");
  });
});

describe("model editor preview scope", () => {
  /** Whether the preview's "Show results by" checkbox for a dimension is on. */
  const grouped = (html: string, name: string) => {
    const preview = html.slice(html.indexOf('class="data-model-preview"'));
    const group = preview.slice(
      preview.indexOf("<legend>Show results by</legend>"),
    );
    const label = group.slice(0, group.indexOf(`${name}</label>`));
    return /<input[^>]*checked=""[^>]*\/?>$/.test(label);
  };
  it("groups a scoped measure's preview by its required dimension from the start", () => {
    const html = render([{ ...revenue, requiredDimensions: ["app"] }]);
    expect(grouped(html, "App dimension")).toBe(true);
    expect(grouped(html, "Reporting day")).toBe(false);
    expect(html).not.toContain("data-preview-scope");
  });
  it("groups a rolling measure's preview by its date from the start", () => {
    const html = render([revenue, rolling]);
    expect(grouped(html, "Reporting day")).toBe(true);
    expect(grouped(html, "App dimension")).toBe(false);
  });
  it("names the date a window needs, and describes the Preview button", () => {
    const en = renderI18n(
      <PreviewScopeHint
        id="scope-hint"
        dimensions={[]}
        dates={["Day"]}
        onFix={() => {}}
      />,
    );
    expect(en).toContain('id="scope-hint"');
    expect(en).toContain("have one value per date. Show results by Day");
    expect(en).not.toContain("keep");
    expect(en).toContain(">Group by Day to preview</button>");
    const de = renderI18n(
      <PreviewScopeHint
        id="scope-hint"
        dimensions={["Store"]}
        dates={["Tag"]}
        onFix={() => {}}
      />,
      "de",
    );
    expect(de).toContain("Deine Kennzahlen halten Store getrennt");
    expect(de).toContain(
      "haben einen Wert pro Datum. Zeige die Ergebnisse nach Tag",
    );
    expect(de).toContain(
      ">Nach Store, Tag gruppieren und Vorschau zeigen</button>",
    );
  });
  it("starts ungrouped when no measure needs a scope", () => {
    expect(grouped(render([revenue]), "App dimension")).toBe(false);
  });
  it("explains a missing scope and offers the grouping as one click, en and de", () => {
    const en = renderI18n(
      <PreviewScopeHint
        id="h"
        dimensions={["Store"]}
        dates={[]}
        onFix={() => {}}
      />,
    );
    expect(en).toContain("Your measures keep Store separate");
    expect(en).toContain(">Group by Store to preview</button>");
    const de = renderI18n(
      <PreviewScopeHint
        id="h"
        dimensions={["Store", "Land"]}
        dates={[]}
        onFix={() => {}}
      />,
      "de",
    );
    expect(de).toContain("Deine Kennzahlen halten Store, Land getrennt");
    expect(de).toContain(
      ">Nach Store, Land gruppieren und Vorschau zeigen</button>",
    );
  });
});

describe("model editor new dimensions (#698)", () => {
  const withDimensions = (
    dimensions: SemanticModelDefinition["dimensions"],
  ): ModelDraft => ({
    ...draft([revenue]),
    definition: { ...definition([revenue]), dimensions },
  });
  const renderDimensions = (
    dimensions: SemanticModelDefinition["dimensions"],
    locale: "en" | "de" = "en",
  ) =>
    renderI18n(
      <ModelEditor
        workspaceId="workspace"
        sources={[source]}
        initial={withDimensions(dimensions)}
        onSaved={() => {}}
        onClose={() => {}}
        onDirty={() => {}}
      />,
      locale,
    );
  it("starts a new dimension with an empty name and a placeholder, en and de", () => {
    const added = newDimension("d1", "sales");
    expect(added).toMatchObject({ name: "", datasetId: "sales", fieldId: "" });
    const dimensions = [{ ...added, fieldId: "app" }];
    const en = renderDimensions(dimensions);
    expect(en).toMatch(/<input[^>]*placeholder="e.g. Country"[^>]*value=""/);
    expect(en).not.toContain("Dimension name 1");
    // The preview's grouping names it until it has a name.
    expect(en).toContain("Unnamed dimension 1");
    const de = renderDimensions(dimensions, "de");
    expect(de).toMatch(/<input[^>]*placeholder="z. B. Land"[^>]*value=""/);
    expect(de).not.toContain("Dimensionsname 1");
    expect(de).toContain("Unbenannte Dimension 1");
  });
  it("numbers dimensions that have no name yet", () => {
    const labels = dimensionLabels(
      [
        newDimension("a", "sales"),
        { id: "b", name: "Country", datasetId: "sales", fieldId: "app" },
        { ...newDimension("c", "sales"), name: "  " },
      ],
      (number) => `Unnamed dimension ${number}`,
    );
    expect([...labels.values()]).toEqual([
      "Unnamed dimension 1",
      "Country",
      "Unnamed dimension 2",
    ]);
  });
});

describe("model editor new measures and aggregate columns (#631)", () => {
  const counted = {
    id: "orders",
    name: "Orders",
    kind: "aggregate",
    datasetId: "sales",
    aggregate: { id: "orders", name: "Orders", op: "count" },
  } as const;
  it("starts a new measure with an empty name and a placeholder, en and de", () => {
    const added = newAggregateMeasure("m1", "sales", "Count");
    expect(added.name).toBe("");
    expect(added.aggregate).toEqual({ id: "m1", name: "Count", op: "count" });
    const en = render([added]);
    expect(en).toMatch(/<input[^>]*placeholder="e.g. Revenue"[^>]*value=""/);
    // The preview's measure list names it until it has a name.
    expect(en).toContain("Unnamed measure 1");
    const de = render([added], "de");
    expect(de).toMatch(/<input[^>]*placeholder="z. B. Umsatz"[^>]*value=""/);
    expect(de).toContain("Unbenannte Kennzahl 1");
  });
  it("keeps the aggregate's name with the measure's", () => {
    const renamed = renameMeasure(
      { ...counted, aggregate: { ...counted.aggregate, name: "" } },
      "Paid orders",
    );
    expect(renamed).toMatchObject({
      name: "Paid orders",
      aggregate: { name: "Paid orders" },
    });
    expect(renameMeasure(ratio, "Share")).toEqual({ ...ratio, name: "Share" });
  });
  it("offers only number columns to sum, and every column to count", () => {
    expect(options(card(render([revenue]), "Revenue"), "Column")).toEqual([
      "Choose…",
      "Amount",
    ]);
    expect(options(card(render([counted]), "Orders"), "Column")).toEqual([
      "Choose…",
      "Date",
      "Ordered at",
      "App",
      "Amount",
    ]);
  });
  it("drops a column the new aggregation cannot read", () => {
    const byApp = { ...counted.aggregate, fieldId: "app" };
    expect(
      changeAggregateOperation(byApp, "sum", source.fields).fieldId,
    ).toBeUndefined();
    expect(
      changeAggregateOperation(
        { ...byApp, fieldId: "amount" },
        "avg",
        source.fields,
      ),
    ).toEqual({ ...byApp, op: "avg", fieldId: "amount" });
    expect(changeAggregateOperation(byApp, "max", source.fields).fieldId).toBe(
      "app",
    );
  });
  it("numbers measures that have no name yet", () => {
    const labels = measureLabels(
      [
        newAggregateMeasure("a", "sales", "Count"),
        revenue,
        newAggregateMeasure("b", "sales", "Count"),
      ],
      (number) => `Unnamed measure ${number}`,
    );
    expect([...labels.values()]).toEqual([
      "Unnamed measure 1",
      "Revenue",
      "Unnamed measure 2",
    ]);
  });
  it("keeps a stored column that no longer fits, explained, so the model saves", () => {
    // A sum of text, saved before the picker offered only numbers.
    const textSum = {
      ...revenue,
      aggregate: { ...revenue.aggregate, fieldId: "app" },
    };
    expect(unfitAggregateField(textSum.aggregate, source.fields)?.id).toBe(
      "app",
    );
    expect(unfitAggregateField(revenue.aggregate, source.fields)).toBe(
      undefined,
    );
    const en = card(render([textSum]), "Revenue");
    expect(options(en, "Column")).toEqual([
      "Choose…",
      "Amount",
      "App (does not fit)",
    ]);
    expect(selected(en, "Column")).toBe("App (does not fit)");
    expect(en).toContain("App does not fit Sum.");
    expect(en).toMatch(/<select[^>]*aria-describedby="[^"]+"[^>]*required=""/);
    const de = card(render([textSum], "de"), "Revenue");
    expect(de).toContain("App (passt nicht)");
    expect(de).toContain("App passt nicht zu Summe.");
  });
});

describe("model editor unpublished mark (#632)", () => {
  const open = (
    version: number,
    publishedVersion: number | null,
    hasUnpublishedChanges = version !== publishedVersion && !!publishedVersion,
  ) =>
    renderI18n(
      <ModelEditor
        workspaceId="workspace"
        sources={[source]}
        initial={{
          ...draft([revenue]),
          version,
          publishedVersion,
          hasUnpublishedChanges,
          inputsDiffer: false,
        }}
        onSaved={() => {}}
        onClose={() => {}}
        onDirty={() => {}}
      />,
    );
  it("marks a saved draft ahead of its release, not the release itself", () => {
    expect(open(4, 3)).toContain("Unpublished changes");
    expect(open(3, 3)).not.toContain("Unpublished changes");
    expect(open(2, null)).not.toContain("Unpublished changes");
  });
  it("trusts the server on a saved draft equal to its release (#697)", () => {
    expect(open(4, 3, false)).not.toContain("Unpublished changes");
    expect(open(4, 3, true)).toContain("Unpublished changes");
  });
});
