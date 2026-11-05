import { describe, expect, it } from "vitest";
import {
  datasetRecordKey,
  datasetRetentionDays,
  sourceDatasetSchema,
  validateDatasetPage,
  type DatasetPage,
} from "./datasets.js";

const definition = sourceDatasetSchema.parse({
  key: "orders",
  name: "Orders",
  version: 1,
  keyFields: ["id"],
  grain: "one order",
  mode: "upsert",
  reportingField: "day",
  fields: [
    {
      id: "id",
      name: "ID",
      type: "string",
      nullable: false,
      classification: "internal",
    },
    {
      id: "amount",
      name: "Amount",
      type: "decimal",
      nullable: false,
      classification: "internal",
    },
    {
      id: "paid",
      name: "Paid",
      type: "boolean",
      nullable: false,
      classification: "internal",
    },
    {
      id: "day",
      name: "Day",
      type: "date",
      nullable: false,
      classification: "internal",
    },
    {
      id: "extra",
      name: "Extra",
      type: "json",
      nullable: true,
      classification: "internal",
    },
  ],
});
const values = {
  id: "one",
  amount: "12345678901234567890.12",
  paid: true,
  day: "2026-11-05",
  extra: { items: [1, null] },
};
function page(overrides: Partial<DatasetPage> = {}): DatasetPage {
  return {
    datasetKey: "orders",
    schemaVersion: 1,
    refreshKey: "r1",
    pageKey: "p1",
    previousPageKey: null,
    complete: true,
    records: [{ values }],
    ...overrides,
  };
}

describe("typed source datasets", () => {
  it("preserves exact decimals and booleans without numeric coercion", () => {
    expect(validateDatasetPage(definition, page()).records[0]?.values).toEqual(
      values,
    );
    expect(datasetRetentionDays(definition)).toBe(30);
  });
  it.each([
    { amount: 1.2 },
    { amount: "1e4" },
    { amount: "NaN" },
    { amount: "1.1234567890123456789" },
    { paid: "true" },
    { day: "2026-02-30" },
    { extra: undefined },
    { unknown: "x" },
  ])("rejects incorrectly typed or undeclared source fields", (override) => {
    expect(() =>
      validateDatasetPage(
        definition,
        page({ records: [{ values: { ...values, ...override } }] }),
      ),
    ).toThrow();
  });
  it("requires every declared field, even when nullable", () => {
    const { extra: _extra, ...missing } = values;
    expect(() =>
      validateDatasetPage(definition, page({ records: [{ values: missing }] })),
    ).toThrow();
  });
  it("requires unique stable IDs and scalar non-null keys", () => {
    expect(
      sourceDatasetSchema.safeParse({
        ...definition,
        fields: [...definition.fields, definition.fields[0]],
      }).success,
    ).toBe(false);
    expect(
      sourceDatasetSchema.safeParse({ ...definition, keyFields: ["extra"] })
        .success,
    ).toBe(false);
    expect(
      sourceDatasetSchema.safeParse({ ...definition, keyFields: ["missing"] })
        .success,
    ).toBe(false);
  });
  it("requires an explicit bounded personal-data retention policy", () => {
    const personal = { ...definition.fields[0]!, classification: "personal" };
    expect(
      sourceDatasetSchema.safeParse({
        ...definition,
        fields: [personal, ...definition.fields.slice(1)],
      }).success,
    ).toBe(false);
    const valid = sourceDatasetSchema.parse({
      ...definition,
      fields: [
        { ...personal, retentionDays: 7 },
        ...definition.fields.slice(1),
      ],
    });
    expect(datasetRetentionDays(valid)).toBe(7);
  });
  it("checks authoritative replacement scope before accepting records", () => {
    const schema = sourceDatasetSchema.parse({
      ...definition,
      mode: "replace_window",
    });
    const scoped = page({
      window: {
        from: "2026-11-01",
        toExclusive: "2026-12-01",
        partition: { paid: true },
      },
    });
    expect(validateDatasetPage(schema, scoped).records).toHaveLength(1);
    expect(() =>
      validateDatasetPage(schema, {
        ...scoped,
        window: { ...scoped.window, partition: { paid: false } },
      }),
    ).toThrow();
    expect(() =>
      validateDatasetPage(schema, {
        ...scoped,
        window: { ...scoped.window, toExclusive: "2026-11-05" },
      }),
    ).toThrow();
    expect(() => validateDatasetPage(schema, page())).toThrow();
  });
  it("accepts tombstone keys only for upserts", () => {
    const deletion = page({
      records: [{ values: { id: "one" }, deleted: true }],
    });
    expect(validateDatasetPage(definition, deletion).records).toHaveLength(1);
    expect(() =>
      validateDatasetPage({ ...definition, mode: "append" }, deletion),
    ).toThrow();
  });
  it("bounds JSON depth, bytes, and record count without exposing content", () => {
    let nested: unknown = "private-customer-text";
    for (let i = 0; i < 10; i++) nested = { nested };
    expect(() =>
      validateDatasetPage(
        definition,
        page({ records: [{ values: { ...values, extra: nested } }] }),
      ),
    ).toThrow("Invalid dataset page structure");
    expect(() =>
      validateDatasetPage(
        definition,
        page({
          records: [
            { values: { ...values, id: "private-customer-text".repeat(5000) } },
          ],
        }),
      ),
    ).toThrow(/byte limit/);
    expect(() =>
      validateDatasetPage(
        definition,
        page({ records: Array.from({ length: 1001 }, () => ({ values })) }),
      ),
    ).toThrow("Invalid dataset page structure");
  });
  it("canonicalizes decimal keys and ignores editable display labels", () => {
    const keyed = { ...definition, keyFields: ["amount"] };
    expect(datasetRecordKey(keyed, { amount: "1.000" })).toBe(
      datasetRecordKey(keyed, { amount: "1" }),
    );
    expect(datasetRecordKey(keyed, { amount: "-0.0" })).toBe(
      datasetRecordKey(keyed, { amount: "0" }),
    );
    expect(datasetRecordKey({ ...definition, name: "Changed" }, values)).toBe(
      datasetRecordKey(definition, values),
    );
  });
});

it("compares timestamp windows by instant even when fractional precision differs", () => {
  const schema = sourceDatasetSchema.parse({
    ...definition,
    mode: "replace_window",
    reportingField: "day",
    fields: definition.fields.map((f) =>
      f.id === "day" ? { ...f, type: "timestamp" } : f,
    ),
  });
  const p = page({
    window: {
      from: "2026-11-05T00:00:00Z",
      toExclusive: "2026-11-05T00:00:01Z",
      partition: {},
    },
    records: [{ values: { ...values, day: "2026-11-05T00:00:00.500Z" } }],
  });
  expect(validateDatasetPage(schema, p).records).toHaveLength(1);
});

it("declares exact money and rejects fractional precision/currency mismatches", () => {
  const money = sourceDatasetSchema.parse({
    ...definition,
    fields: [
      ...definition.fields.map((f) =>
        f.id === "amount"
          ? { ...f, unit: "currency", scale: 2, currencyField: "currency" }
          : f,
      ),
      {
        id: "currency",
        name: "Currency",
        type: "string",
        nullable: false,
        classification: "internal",
      },
    ],
  });
  const p = page({ records: [{ values: { ...values, currency: "EUR" } }] });
  expect(validateDatasetPage(money, p).records).toHaveLength(1);
  expect(() =>
    validateDatasetPage(
      money,
      page({ records: [{ values: { ...values, currency: "eur" } }] }),
    ),
  ).toThrow("Invalid currency field");
  expect(() =>
    validateDatasetPage(
      money,
      page({
        records: [{ values: { ...values, currency: "EUR", amount: "1.001" } }],
      }),
    ),
  ).toThrow("Invalid dataset field type: amount");
  expect(
    sourceDatasetSchema.safeParse({
      ...money,
      fields: money.fields.map((f) =>
        f.id === "amount" ? { ...f, type: "number" } : f,
      ),
    }).success,
  ).toBe(false);
});
