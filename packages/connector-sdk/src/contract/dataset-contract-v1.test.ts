import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DATASET_FIELD_ROLES,
  DATASET_LIMITS,
  datasetFieldSchema,
  datasetFieldTypeSchema,
  datasetPageSchema,
  datasetRecordKey,
  sourceDatasetSchema,
  validateDatasetPage,
} from "../datasets.js";
import { syncResultSchema } from "../transport.js";

// Dataset contract v1 (docs/decisions/0026-dataset-contract-v1.md). The
// fixtures are frozen: within v1 they only gain entries. A fixture that stops
// passing is a breaking change and needs contract v2, not a fixture edit.
interface Entry {
  name: string;
  value: unknown;
}
interface PageEntry {
  name: string;
  definition: unknown;
  page: unknown;
}
const fixture = <T>(file: string): T[] =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/v1/${file}`, import.meta.url), "utf8"),
  ) as T[];
const accepted = fixture<Entry>("definitions.accepted.json");
const rejected = fixture<Entry>("definitions.rejected.json");
const pagesAccepted = fixture<PageEntry>("pages.accepted.json");
const pagesRejected = fixture<PageEntry>("pages.rejected.json");
const syncResults = fixture<Entry>("sync-results.accepted.json");

describe("dataset contract v1", () => {
  it.each(accepted)("still accepts $name", ({ value }) => {
    expect(sourceDatasetSchema.safeParse(value).success).toBe(true);
  });
  it.each(rejected)("still rejects $name", ({ value }) => {
    expect(sourceDatasetSchema.safeParse(value).success).toBe(false);
  });
  it.each(pagesAccepted)("validates page $name", ({ definition, page }) => {
    expect(() =>
      validateDatasetPage(sourceDatasetSchema.parse(definition), page),
    ).not.toThrow();
  });
  it.each(pagesRejected)("refuses page $name", ({ definition, page }) => {
    expect(() =>
      validateDatasetPage(sourceDatasetSchema.parse(definition), page),
    ).toThrow();
  });
  it.each(syncResults)("accepts sync result $name", ({ value }) => {
    expect(syncResultSchema.safeParse(value).success).toBe(true);
  });

  it("covers every field type, mode and the image role in its fixtures", () => {
    const definitions = accepted.map(({ value }) =>
      sourceDatasetSchema.parse(value),
    );
    const fields = definitions.flatMap((d) => d.fields);
    expect(new Set(fields.map((f) => f.type))).toEqual(
      new Set(datasetFieldTypeSchema.options),
    );
    expect(new Set(definitions.map((d) => d.mode))).toEqual(
      new Set(["upsert", "append", "replace_window", "snapshot"]),
    );
    expect(fields.some((f) => f.role === "image")).toBe(true);
    expect(new Set(definitions.map((d) => d.retentionDays))).toEqual(
      new Set([null, 90, DATASET_LIMITS.retentionDays]),
    );
  });

  it("defaults dataset retention to 30 days and keeps null as keep-until-deleted", () => {
    const byName = new Map(accepted.map((e) => [e.name, e.value]));
    expect(
      sourceDatasetSchema.parse(byName.get("retention-default")).retentionDays,
    ).toBe(30);
    expect(
      sourceDatasetSchema.parse(byName.get("snapshot-keep")).retentionDays,
    ).toBeNull();
  });

  it("keeps the canonical record key: normalised decimals and nanosecond timestamps", () => {
    const byName = new Map(accepted.map((e) => [e.name, e.value]));
    const composite = sourceDatasetSchema.parse(byName.get("composite-key"));
    expect(
      datasetRecordKey(composite, { id: "k", seq: 1, amount: "1.50" }),
    ).toBe(datasetRecordKey(composite, { amount: "1.5", seq: 1, id: "k" }));
    expect(datasetRecordKey(composite, { id: "k", seq: 1, amount: "-0" })).toBe(
      '[["id","k"],["seq",1],["amount","0"]]',
    );
    const append = sourceDatasetSchema.parse(byName.get("append"));
    expect(
      datasetRecordKey(
        { ...append, keyFields: ["at"] },
        { at: "2026-11-05T00:00:00.5Z" },
      ),
    ).toBe('[["at","2026-11-05T00:00:00.500000000Z"]]');
  });

  it("has exactly the v1 members (additions need a fixture and an SDK bump)", () => {
    expect(Object.keys(datasetFieldSchema.shape).sort()).toEqual([
      "classification",
      "currencyField",
      "id",
      "name",
      "nullable",
      "retentionDays",
      "role",
      "scale",
      "type",
      "unit",
    ]);
    expect(Object.keys(sourceDatasetSchema.shape).sort()).toEqual([
      "fields",
      "grain",
      "key",
      "keyFields",
      "mode",
      "name",
      "reportingField",
      "reportingTimeZone",
      "retentionDays",
      "version",
    ]);
    expect(Object.keys(datasetPageSchema.shape).sort()).toEqual([
      "complete",
      "datasetKey",
      "pageKey",
      "previousPageKey",
      "records",
      "refreshKey",
      "schemaVersion",
      "stagingId",
      "stagingPageKey",
      "window",
    ]);
    expect(datasetFieldTypeSchema.options).toEqual([
      "string",
      "boolean",
      "integer",
      "number",
      "decimal",
      "date",
      "timestamp",
      "json",
    ]);
    expect(DATASET_LIMITS).toEqual({
      fields: 100,
      datasets: 20,
      pageRows: 1_000,
      pageBytes: 1_048_576,
      rowBytes: 65_536,
      keyBytes: 1_024,
      previewRows: 100,
      retentionDays: 30,
    });
  });

  it("names the v1 field roles", () => {
    // The API contract and the domain repeat this list; their agreement is
    // tested in packages/contracts/src/data-processing.test.ts.
    expect([...DATASET_FIELD_ROLES]).toEqual(["image"]);
  });
});
