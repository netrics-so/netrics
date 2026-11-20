import type { CustomApiField } from "@netrics/connector-sdk/custom-api";
import { describe, expect, it } from "vitest";

import {
  CUSTOM_API_MESSAGES,
  convertValue,
  jsonTooDeep,
  mapRecords,
  selectRecords,
} from "./index.js";
import { FIXTURE_BAD_VALUES } from "./testing/index.js";

const FAIL = Symbol("fail");

function field(spec: Partial<CustomApiField>): CustomApiField {
  return {
    id: "f",
    name: "F",
    path: "f",
    type: "string",
    nullable: true,
    classification: "internal",
    ...spec,
  } as CustomApiField;
}

describe("custom API records", () => {
  it("treats an object as one record and null as none", () => {
    expect(selectRecords({ data: { a: 1 } }, "data")).toEqual([{ a: 1 }]);
    expect(selectRecords({ data: null }, "data")).toEqual([]);
    expect(selectRecords({}, "data")).toEqual([]);
    expect(selectRecords([{ a: 1 }, { a: 2 }], "")).toHaveLength(2);
    expect(selectRecords({ a: 1 }, "")).toEqual([{ a: 1 }]);
  });

  it("refuses a number at the records path", () => {
    expect(() => selectRecords({ data: 5 }, "data")).toThrow(
      CUSTOM_API_MESSAGES.recordsNotList,
    );
    expect(() => selectRecords({ data: "x" }, "data")).toThrow(
      CUSTOM_API_MESSAGES.recordsNotList,
    );
  });

  it.each<[Partial<CustomApiField>, unknown, unknown, string?]>([
    [{ type: "integer" }, "42", 42],
    [{ type: "integer" }, 4.5, FAIL],
    [{ type: "integer" }, "n/a", FAIL],
    [{ type: "integer" }, "9007199254740993", FAIL],
    [{ type: "decimal", scale: 2 }, "12.50", "12.50"],
    [{ type: "decimal", scale: 2 }, "12.505", FAIL],
    [{ type: "decimal", scale: 2 }, 7.25, "7.25"],
    [{ type: "decimal" }, 1e21, "1000000000000000000000"],
    [{ type: "decimal" }, "1e3", FAIL],
    [{ type: "number" }, "1.5e3", 1500],
    [{ type: "boolean" }, "true", true],
    [{ type: "boolean" }, "yes", FAIL],
    [{ type: "string" }, 12, "12"],
    [{ type: "string" }, { a: 1 }, FAIL],
    [{ type: "date", format: "dd.MM.yyyy" }, "31.12.2024", "2024-12-31"],
    [{ type: "date", format: "MM/dd/yyyy" }, "02/29/2024", "2024-02-29"],
    [{ type: "date", format: "yyyyMMdd" }, "20230229", FAIL],
    [{ type: "date", format: "iso" }, "31.12.2024", FAIL],
    // The instant's calendar date in the zone: 22:30 UTC is 23:30 CET.
    [
      { type: "date" },
      "2024-03-31T00:30:00+02:00",
      "2024-03-30",
      "Europe/Berlin",
    ],
    [
      { type: "date" },
      "2024-03-31T08:30:00+02:00",
      "2024-03-31",
      "Europe/Berlin",
    ],
    [{ type: "date" }, "2024-03-31", "2024-03-31", "Europe/Berlin"],
    [
      { type: "date", format: "unix_seconds" },
      1711839600,
      "2024-03-31",
      "Europe/Berlin",
    ],
    [
      { type: "timestamp", format: "unix_millis" },
      1704067200000,
      "2024-01-01T00:00:00.000Z",
    ],
    [
      { type: "timestamp", format: "unix_seconds" },
      "1704067200",
      "2024-01-01T00:00:00.000Z",
    ],
    // Zone-less, Europe/Berlin (02:30 does not exist that night).
    [
      { type: "timestamp" },
      "2024-03-31T02:30:00",
      "2024-03-31T01:30:00.000Z",
      "Europe/Berlin",
    ],
    [
      { type: "timestamp" },
      "2024-01-15T10:00:00",
      "2024-01-15T09:00:00.000Z",
      "Europe/Berlin",
    ],
    [
      { type: "timestamp" },
      "2024-01-15T10:00:00.123456+01:00",
      "2024-01-15T09:00:00.123Z",
    ],
    [{ type: "timestamp" }, "2024-13-01T00:00:00Z", FAIL],
    [{ type: "json" }, { a: [1, 2] }, { a: [1, 2] }],
  ])("converts %j %j", (spec, raw, expected, zone = "UTC") => {
    const converted = convertValue(field(spec), raw, zone);
    if (expected === FAIL) expect(converted).toEqual({ ok: false });
    else expect(converted).toEqual({ ok: true, value: expected });
  });

  it("nulls an unparseable nullable value and skips a record whose key does not parse", () => {
    const badValuesStream = {
      fields: [
        field({ id: "id", path: "id", type: "integer", nullable: false }),
        field({ id: "orders", path: "orders", type: "integer" }),
      ],
      keyFields: ["id"],
    };
    const page = mapRecords(badValuesStream, FIXTURE_BAD_VALUES, "UTC");
    expect(page.skipped).toBe(1);
    expect(page.nulled).toEqual({ orders: 2 });
    expect(page.rows).toEqual([
      { id: 1, orders: 3 },
      { id: 2, orders: null },
      { id: 3, orders: null },
    ]);
  });

  it("skips a record whose money field has no ISO currency", () => {
    const stream = {
      fields: [
        field({ id: "id", path: "id", type: "integer", nullable: false }),
        field({
          id: "amount",
          path: "amount",
          type: "decimal",
          currencyField: "currency",
        }),
        field({ id: "currency", path: "currency", nullable: false }),
      ],
      keyFields: ["id"],
    };
    const page = mapRecords(
      stream,
      [
        { id: 1, amount: "1.00", currency: "EUR" },
        { id: 2, amount: "1.00", currency: "euro" },
      ],
      "UTC",
    );
    expect(page.rows).toHaveLength(1);
    expect(page.skipped).toBe(1);
  });

  it("detects nesting deeper than 64 without recursion", () => {
    expect(jsonTooDeep(`${"[".repeat(64)}${"]".repeat(64)}`)).toBe(false);
    expect(jsonTooDeep(`${"[".repeat(65)}${"]".repeat(65)}`)).toBe(true);
    expect(jsonTooDeep(`{"a":"${"[".repeat(100)}"}`)).toBe(false);
    expect(jsonTooDeep(`{"a":"\\"${"{".repeat(100)}"}`)).toBe(false);
    expect(
      jsonTooDeep(`${'{"a":'.repeat(100_000)}1${"}".repeat(100_000)}`),
    ).toBe(true);
  });
});
