import { expect, it } from "vitest";
import { sourceDatasetSchema, validateDatasetPage } from "@netrics/contracts";
import type { DataField } from "@netrics/domain";
import { setReferenceCurrency } from "./reference-fields";

it("declares exact money and a required currency identity while preserving values and precision", () => {
  const original: DataField[] = [
    { id: "id", name: "ID", type: "string", nullable: false },
    {
      id: "amount",
      name: "Revenue",
      type: "decimal",
      nullable: true,
      scale: 4,
    },
    { id: "currency", name: "Currency", type: "string", nullable: true },
  ];
  const fields = setReferenceCurrency(original, "amount", "currency");
  expect(original[2]!.nullable).toBe(true);
  expect(fields[1]).toMatchObject({
    unit: "currency",
    currencyField: "currency",
    scale: 4,
  });
  expect(fields[2]!.nullable).toBe(false);
  const definition = sourceDatasetSchema.parse({
    key: "money",
    name: "Money",
    version: 1,
    grain: "one amount",
    mode: "snapshot",
    keyFields: ["id"],
    fields: fields.map((field) => ({ ...field, classification: "internal" })),
  });
  const page = {
    datasetKey: "money",
    schemaVersion: 1,
    refreshKey: "edit",
    pageKey: "one",
    previousPageKey: null,
    complete: true,
    records: [
      {
        values: { id: "001", amount: "9007199254740993.1200", currency: "EUR" },
      },
      { values: { id: "002", amount: null, currency: "EUR" } },
    ],
  };
  expect(validateDatasetPage(definition, page).records).toEqual(page.records);
  expect(() =>
    validateDatasetPage(definition, {
      ...page,
      records: [{ values: { id: "001", amount: "1.20", currency: null } }],
    }),
  ).toThrow();
  const cleared = setReferenceCurrency(fields, "amount", "");
  expect(cleared[1]!.currencyField).toBeUndefined();
  expect(cleared[1]!.unit).toBeUndefined();
  expect(cleared[1]!.scale).toBe(4);
});

it("preserves minor-unit declarations and rejects floating-point money or non-text currencies", () => {
  const fields: DataField[] = [
    {
      id: "amount",
      name: "Amount",
      type: "integer",
      nullable: false,
      unit: "currency_minor",
    },
    { id: "currency", name: "Currency", type: "string", nullable: false },
  ];
  expect(setReferenceCurrency(fields, "amount", "currency")[0]!.unit).toBe(
    "currency_minor",
  );
  expect(() =>
    setReferenceCurrency(
      [{ ...fields[0]!, type: "number" }, fields[1]!],
      "amount",
      "currency",
    ),
  ).toThrow("data_currency_invalid");
  expect(() =>
    setReferenceCurrency(
      [fields[0]!, { ...fields[1]!, type: "integer" }],
      "amount",
      "currency",
    ),
  ).toThrow("data_currency_invalid");
});

it("keeps currency and scale controls reachable before an incompatible type change", async () => {
  const { referenceTypeAllowed } = await import("./reference-fields");
  const amount: DataField = {
      id: "amount",
      name: "Amount",
      type: "decimal",
      nullable: true,
      currencyField: "currency",
      unit: "currency",
      scale: 2,
    },
    currency: DataField = {
      id: "currency",
      name: "Currency",
      type: "string",
      nullable: false,
    };
  const fields = [amount, currency];
  expect(referenceTypeAllowed(amount, fields, "string")).toBe(false);
  expect(referenceTypeAllowed(amount, fields, "number")).toBe(false);
  expect(referenceTypeAllowed(amount, fields, "integer")).toBe(true);
  expect(referenceTypeAllowed(currency, fields, "decimal")).toBe(false);
  const unlinked = setReferenceCurrency(fields, "amount", "");
  expect(referenceTypeAllowed(unlinked[1]!, unlinked, "decimal")).toBe(true);
  expect(referenceTypeAllowed(unlinked[0]!, unlinked, "string")).toBe(false);
  const cleared = unlinked.map((field) => ({ ...field, scale: undefined }));
  expect(referenceTypeAllowed(cleared[0]!, cleared, "string")).toBe(true);
});
