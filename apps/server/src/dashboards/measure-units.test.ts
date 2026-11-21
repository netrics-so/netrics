import { describe, expect, it, vi } from "vitest";
import {
  measureSampleSuffix,
  measureTypeProbe,
  type DataField,
  type SemanticModelDefinition,
} from "@netrics/domain";

import { measureUnits } from "./data.js";

// The units a published model's measures carry (#835): one type probe for
// every measure, money as "currency" (screens show its code, not words).
const definition = {
  version: 1,
  datasets: ["sales"],
  relationships: [],
  dimensions: [],
  measures: ["installs", "ratio", "revenue"].map((id) => ({
    id,
    name: id,
    kind: "aggregate",
    datasetId: "sales",
    aggregate: { id, name: id, op: "sum", fieldId: id },
  })),
} as unknown as SemanticModelDefinition;
const bindings: Record<string, DataField[]> = { sales: [] };

describe("measure units of a model (#835)", () => {
  it("probes every measure in one call", () => {
    const probe = vi.fn((_model, _tables, ids: readonly string[]) => {
      return new Map(
        ids.map((id) => [
          id,
          id === "ratio"
            ? {
                value: null,
                type: "decimal" as const,
                unit: "installs/impressions",
              }
            : id === "revenue"
              ? // A formula over amounts: its currency, whatever its unit.
                {
                  value: null,
                  type: "decimal" as const,
                  unit: "currency/visitors",
                  currency: "EUR",
                }
              : { value: null, type: "integer" as const, unit: "installs" },
        ]),
      );
    }) as unknown as typeof measureTypeProbe;
    expect(measureUnits(definition, bindings, probe)).toEqual(
      new Map([
        ["installs", "installs"],
        ["ratio", "installs/impressions"],
        ["revenue", "currency"],
      ]),
    );
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("probes each measure on its own only when one is refused", () => {
    const probe = vi.fn((_model, _tables, ids: readonly string[]) => {
      if (ids.includes("ratio")) throw new Error("refused");
      return new Map(
        ids.map((id) => [
          id,
          { value: null, type: "integer" as const, unit: "kg" },
        ]),
      );
    }) as unknown as typeof measureTypeProbe;
    expect(measureUnits(definition, bindings, probe)).toEqual(
      new Map([
        ["installs", "kg"],
        ["ratio", undefined],
        ["revenue", "kg"],
      ]),
    );
    expect(probe).toHaveBeenCalledTimes(4);
  });
});

describe("readability sample suffix (#835)", () => {
  it("counts the currency an amount shows, not a unit's words", () => {
    expect(measureSampleSuffix("currency", "de")).toBe(" EUR");
    expect(measureSampleSuffix("currency_minor", "en")).toBe(" EUR");
    expect(measureSampleSuffix("USD_minor", "en")).toBe(" EUR");
    expect(measureSampleSuffix("installs/impressions", "de")).toBe(
      " Installationen/Impressionen",
    );
    expect(measureSampleSuffix("count", "en")).toBe("");
    expect(measureSampleSuffix(undefined, "en")).toBe("");
  });
});
