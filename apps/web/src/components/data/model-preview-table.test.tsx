import { describe, expect, it } from "vitest";
import type { SemanticModelDefinition } from "@netrics/domain";
import { renderI18n } from "@/lib/i18n/test-render";
import type { DataSource, ModelResult } from "@/lib/data-api";
import { ModelPreviewTable } from "./model-preview-table";

const source: DataSource = {
  id: "sales",
  name: "Sales",
  kind: "source",
  fields: [
    { id: "date", name: "Date", type: "date", nullable: false },
    { id: "amount", name: "Amount", type: "decimal", nullable: true },
  ],
  generationId: null,
  rowCount: null,
  schemaVersion: 1,
  aggregated: false,
  expiresAt: null,
  connectionId: null,
};
const model: SemanticModelDefinition = {
  version: 1,
  datasets: ["sales"],
  relationships: [],
  dimensions: [
    {
      id: "day",
      name: "Reporting day",
      datasetId: "sales",
      fieldId: "date",
      timeAlignment: "reporting_date",
    },
  ],
  measures: [
    {
      id: "revenue",
      name: "Revenue",
      kind: "aggregate",
      datasetId: "sales",
      aggregate: {
        id: "revenue",
        name: "Revenue",
        op: "sum",
        fieldId: "amount",
      },
    },
    {
      id: "growth",
      name: "Growth",
      kind: "period_offset",
      baseMeasureId: "revenue",
      timeDimensionId: "day",
      offset: { unit: "day", length: 1 },
      output: "percent_change",
    },
    // The previous value of a percent change is a percent change too.
    {
      id: "growthBefore",
      name: "Growth the day before",
      kind: "period_offset",
      baseMeasureId: "growth",
      timeDimensionId: "day",
      offset: { unit: "day", length: 1 },
      output: "value",
    },
    {
      id: "delta",
      name: "Revenue change",
      kind: "period_offset",
      baseMeasureId: "revenue",
      timeDimensionId: "day",
      offset: { unit: "day", length: 1 },
      output: "change",
    },
  ],
};
const result: ModelResult = {
  releaseId: null,
  warnings: [],
  operations: 1,
  provenance: [],
  appliedFilter: null,
  groupBy: ["day"],
  stale: false,
  rows: [
    {
      dimensions: { day: "2026-11-02" },
      measures: {
        revenue: {
          value: "130.50",
          type: "decimal",
          currency: "EUR",
          status: "ok",
        },
        growth: {
          value: "0.083333333333333333",
          type: "decimal",
          status: "ok",
        },
        growthBefore: { value: "-0.0125", type: "decimal", status: "ok" },
        delta: {
          value: "10.05",
          type: "decimal",
          currency: "EUR",
          status: "ok",
        },
      },
    },
    {
      dimensions: { day: "2026-11-01" },
      measures: {
        revenue: { value: null, type: "decimal", status: "missing" },
        growth: { value: null, type: "decimal", status: "missing" },
        growthBefore: { value: null, type: "decimal", status: "missing" },
        delta: { value: null, type: "decimal", status: "missing" },
      },
    },
  ],
};
const render = (locale: "en" | "de") =>
  renderI18n(
    <ModelPreviewTable
      query={{
        model,
        measureIds: ["revenue", "growth", "growthBefore", "delta"],
        groupBy: ["day"],
      }}
      result={result}
      sources={[source]}
    />,
    locale,
  );
/** The text of each body cell, row by row. */
const cells = (html: string) =>
  [...html.matchAll(/<tr>(.*?)<\/tr>/g)]
    .slice(1)
    .map((row) =>
      [...row[1]!.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((m) => m[1]),
    );

describe("model preview table", () => {
  it.each([
    ["en", ["2026-11-02", "130.50 EUR", "+8.3%", "−1.3%", "10.05 EUR"]],
    ["de", ["2026-11-02", "130.50 EUR", "+8,3%", "−1,3%", "10.05 EUR"]],
  ] as const)(
    "shows percent-change measures as signed percentages (%s)",
    (locale, first) => {
      const html = render(locale);
      const [row, empty] = cells(html);
      expect(row).toEqual(first);
      // Missing values stay missing, never "—" or 0%.
      expect(empty!.slice(1).every((text) => text !== "—")).toBe(true);
      expect(empty!.slice(1)).not.toContain("±0%");
      // The ratio itself never shows, nor does a percentage for a change.
      expect(html).not.toContain("0.083333333333333333");
      expect(html).not.toContain("+1005%");
    },
  );
});
