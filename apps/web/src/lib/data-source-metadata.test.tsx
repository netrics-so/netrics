import { describe, expect, it } from "vitest";
import { renderI18n } from "@/lib/i18n/test-render";
import type { DataSource } from "./data-api";
import { overlayDraftSources } from "./data-source-metadata";
import { AggregateFields, ColumnSelect } from "@/components/data/fields";

const source = (id: string, prefix: string): DataSource => ({
  id,
  name: "Prepared rows",
  kind: "prepared",
  generationId: null,
  rowCount: 1,
  schemaVersion: 1,
  aggregated: false,
  expiresAt: null,
  connectionId: null,
  fields: [
    {
      id: prefix + "_amount",
      name: prefix + " amount",
      type: "decimal",
      nullable: false,
    },
    {
      id: prefix + "_group",
      name: prefix + " group",
      type: "string",
      nullable: false,
    },
  ],
});

describe("restored authoring input metadata", () => {
  it("replaces latest field options with historical identities in aggregate and dimension controls", () => {
    const prepared = "prepared:preparation:output";
    const sources = overlayDraftSources(
      [source(prepared, "new")],
      [source(prepared, "old")],
    );
    const fields = sources[0]!.fields;
    const html = renderI18n(
      <>
        <AggregateFields
          fields={fields}
          value={{
            id: "total",
            name: "Total",
            op: "sum",
            fieldId: "old_amount",
          }}
          onChange={() => {}}
        />
        <ColumnSelect
          label="Group"
          fields={fields.filter((field) => field.type === "string")}
          value="old_group"
          onChange={() => {}}
        />
      </>,
    );
    expect(html).toContain(
      '<option value="old_amount" selected="">old amount</option>',
    );
    expect(html).toContain(
      '<option value="old_group" selected="">old group</option>',
    );
    expect(html).not.toContain("new_amount");
    expect(fields.find((field) => field.id === "old_group")!.type).toBe(
      "string",
    );
  });
  it("adds a removed historical output to source choices while preserving other available sources", () => {
    const latest = source("prepared:preparation:replacement", "new");
    const historic = source("prepared:preparation:removed", "old");
    const sources = overlayDraftSources([latest], [historic]);
    expect(sources.map((entry) => entry.id)).toEqual([latest.id, historic.id]);
    expect(
      sources.find((entry) => entry.id === historic.id)!.fields[0]!.id,
    ).toBe("old_amount");
  });
});
