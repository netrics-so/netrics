import { describe, expect, it } from "vitest";
import type { SemanticModelDefinition } from "@netrics/domain";
import { renderI18n } from "@/lib/i18n/test-render";
import type { DataSource, ModelDraft } from "@/lib/data-api";
import { ModelEditor } from "./model-editor";

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
  version: 1,
  publishedVersion: null,
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
});
