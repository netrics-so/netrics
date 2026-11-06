"use client";
import {
  measureIsPercentChange,
  type DataField,
  type SemanticModelDefinition,
} from "@netrics/domain";
import type { DataSource, ModelResult } from "@/lib/data-api";
import { useLocale } from "@/lib/i18n/client";
import { formatPercentChange } from "@/lib/format-metric";
import { DataTable } from "./data-table";

/** The draft and query a model preview ran with. */
export interface ModelPreviewQuery {
  model: SemanticModelDefinition;
  measureIds: string[];
  groupBy: string[];
}

/**
 * A model preview's rows as a table: dimension labels, money with its
 * currency, and percent-change measures as signed percentages.
 */
export function ModelPreviewTable({
  query: { model, measureIds, groupBy },
  result,
  sources,
  loading = false,
}: {
  query: ModelPreviewQuery;
  result: ModelResult;
  sources: DataSource[];
  loading?: boolean;
}) {
  const locale = useLocale();
  const percent = new Set(
    measureIds.filter((id) => measureIsPercentChange(model, id)),
  );
  const fields: DataField[] = [
    ...groupBy.map((id): DataField => {
      const dimension = model.dimensions.find((d) => d.id === id)!;
      const source = sources
        .find((s) => s.id === dimension.datasetId)
        ?.fields.find((f) => f.id === dimension.fieldId);
      return {
        type: "string",
        nullable: true,
        ...source,
        id: "d." + id,
        name: dimension.name,
      };
    }),
    ...measureIds.map((id): DataField => {
      const cell = result.rows[0]?.measures[id];
      return {
        id: "m." + id,
        name: model.measures.find((m) => m.id === id)?.name ?? id,
        type: percent.has(id) ? "string" : (cell?.type ?? "decimal"),
        nullable: true,
        ...(cell?.unit ? { unit: cell.unit } : {}),
      };
    }),
  ];
  const rows = result.rows.map((row) =>
    Object.fromEntries([
      ...Object.entries(row.dimensions).map(([id, value]) => [
        "d." + id,
        row.dimensionLabels?.[id] ?? value,
      ]),
      ...Object.entries(row.measures).map(([id, cell]) => [
        "m." + id,
        cell.value === null
          ? null
          : percent.has(id)
            ? formatPercentChange(cell.value, locale)
            : cell.currency
              ? String(cell.value) + " " + cell.currency
              : cell.value,
      ]),
    ]),
  );
  return <DataTable fields={fields} rows={rows} loading={loading} />;
}
