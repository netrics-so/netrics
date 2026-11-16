import { afterEach, describe, expect, it } from "vitest";
import {
  literalDisplayType,
  rowDisplayType,
  literalEdit,
  literalFromInput,
  literalInputText,
  listFromInput,
  fixedValueMode,
  typedNumericLiteral,
} from "./literal-input";

describe("literal input", () => {
  const timeZone = process.env.TZ;
  afterEach(() => {
    if (timeZone === undefined) delete process.env.TZ;
    else process.env.TZ = timeZone;
  });

  it("parses German decimal commas exactly", () => {
    expect(literalFromInput("decimal", "1,50", "de")).toEqual({
      kind: "literal",
      type: "decimal",
      value: "1.50",
    });
    expect(literalFromInput("decimal", "1.50", "en")?.value).toBe("1.50");
    expect(literalFromInput("decimal", "-0,5", "de")?.value).toBe("-0.5");
    expect(literalFromInput("decimal", "1.000,5", "de")).toBeNull();
    expect(literalFromInput("decimal", "1.5", "de")).toBeNull();
    expect(literalFromInput("decimal", "1,000.5", "en")).toBeNull();
    expect(literalFromInput("decimal", "1,5", "en")).toBeNull();
    expect(literalFromInput("decimal", "", "en")).toBeNull();
    expect(
      literalInputText(
        { kind: "literal", type: "decimal", value: "1.50" },
        "de",
      ),
    ).toBe("1,50");
    expect(
      literalInputText(
        { kind: "literal", type: "decimal", value: "1.50" },
        "en",
      ),
    ).toBe("1.50");
  });

  it("parses integers and numbers in the locale", () => {
    expect(literalFromInput("integer", "-42", "de")?.value).toBe(-42);
    expect(literalFromInput("integer", "1,5", "de")).toBeNull();
    expect(literalFromInput("integer", "9007199254740993", "en")).toBeNull();
    expect(literalFromInput("number", "2,5", "de")?.value).toBe(2.5);
    expect(literalFromInput("number", "2.5", "en")?.value).toBe(2.5);
    expect(literalFromInput("number", "abc", "en")).toBeNull();
    for (const value of [2.5, -0.125, 1e21, 5e-7])
      for (const locale of ["en", "de"] as const) {
        const literal = {
          kind: "literal" as const,
          type: "number" as const,
          value,
        };
        expect(
          literalFromInput("number", literalInputText(literal, locale), locale),
        ).toEqual(literal);
      }
  });

  it("timestamp input round-trips as UTC", () => {
    process.env.TZ = "Europe/Berlin";
    const literal = literalFromInput("timestamp", "2026-03-29T02:30:00", "de");
    expect(literal).toEqual({
      kind: "literal",
      type: "timestamp",
      value: "2026-03-29T02:30:00Z",
    });
    expect(literalInputText(literal!, "de")).toBe("2026-03-29T02:30:00");
    // datetime-local omits zero seconds.
    expect(literalFromInput("timestamp", "2026-03-29T02:30", "en")?.value).toBe(
      "2026-03-29T02:30:00Z",
    );
    const fraction = {
      kind: "literal" as const,
      type: "timestamp" as const,
      value: "2026-01-01T00:00:00.250Z",
    };
    expect(
      literalFromInput("timestamp", literalInputText(fraction, "en"), "en"),
    ).toEqual(fraction);
    expect(literalFromInput("timestamp", "2026-02-30T00:00", "en")).toBeNull();
  });

  it("keeps currency on decimal literals", () => {
    expect(
      literalFromInput("decimal", "12,00", "de", {
        unit: "currency",
        currency: "EUR",
      }),
    ).toEqual({
      kind: "literal",
      type: "decimal",
      value: "12.00",
      unit: "currency",
      currency: "EUR",
    });
  });

  it("rejects invalid dates", () => {
    expect(literalFromInput("date", "2026-02-30", "en")).toBeNull();
    expect(literalFromInput("date", "2026-02-28", "en")?.value).toBe(
      "2026-02-28",
    );
  });

  it("reads booleans and strings", () => {
    expect(literalFromInput("boolean", "true", "en")?.value).toBe(true);
    expect(literalFromInput("boolean", "false", "de")?.value).toBe(false);
    expect(literalFromInput("boolean", "yes", "en")).toBeNull();
    expect(literalFromInput("string", " DE ", "en")?.value).toBe(" DE ");
    expect(literalFromInput("string", "", "en")).toBeNull();
  });

  it("builds a json list for in", () => {
    expect(listFromInput("string", ["DE", "AT"], "en")).toEqual({
      kind: "literal",
      type: "json",
      value: ["DE", "AT"],
    });
    expect(listFromInput("decimal", ["1,5", "2"], "de")?.value).toEqual([
      "1.5",
      "2",
    ]);
    expect(listFromInput("integer", ["1", "x"], "en")).toBeNull();
    expect(listFromInput("string", [], "en")).toBeNull();
  });

  it("shows a stored literal of another type in the column's input", () => {
    const integer = {
      kind: "literal" as const,
      type: "integer" as const,
      value: 0,
    };
    const number = {
      kind: "literal" as const,
      type: "number" as const,
      value: 0.5,
    };
    const big = {
      kind: "literal" as const,
      type: "number" as const,
      value: 1e21,
    };
    expect(literalDisplayType("decimal", integer, "en")).toBe("decimal");
    expect(literalDisplayType("number", number, "de")).toBe("number");
    // "1e+21" is no decimal text: the input keeps the literal's own type.
    expect(literalDisplayType("decimal", big, "en")).toBe("number");
    expect(literalDisplayType("decimal", undefined, "en")).toBe("decimal");
  });

  it("keeps the unit and currency while a value is cleared and retyped", () => {
    const stored = {
      kind: "literal" as const,
      type: "number" as const,
      value: 0.5,
      unit: "percent",
    };
    const cleared = literalEdit("number", "", "", "en", stored);
    expect(cleared).toEqual({
      kind: "literal",
      type: "number",
      value: null,
      unit: "percent",
    });
    expect(literalEdit("number", "0.6", "", "en", cleared)).toEqual({
      kind: "literal",
      type: "number",
      value: 0.6,
      unit: "percent",
    });
    const money = {
      kind: "literal" as const,
      type: "decimal" as const,
      value: "1.00",
      unit: "currency",
      currency: "EUR",
    };
    expect(literalEdit("decimal", "1,", "EUR", "de", money)).toEqual({
      kind: "literal",
      type: "decimal",
      value: null,
      unit: "currency",
      currency: "EUR",
    });
  });

  it("shows a literal in the column's input only when it reads back equal", () => {
    const text = {
      kind: "literal" as const,
      type: "string" as const,
      value: "true",
    };
    expect(literalDisplayType("boolean", text, "en")).toBe("string");
    const integer = {
      kind: "literal" as const,
      type: "integer" as const,
      value: 2,
    };
    expect(literalDisplayType("number", integer, "en")).toBe("number");
    // Integer 0 reads as decimal text "0": the decimal input shows it, so
    // the value can be edited to 0.5.
    const zero = {
      kind: "literal" as const,
      type: "integer" as const,
      value: 0,
    };
    expect(literalDisplayType("decimal", zero, "en")).toBe("decimal");
    expect(literalEdit("decimal", "0.5", "", "en", zero)).toEqual({
      kind: "literal",
      type: "decimal",
      value: "0.5",
    });
    // A number is no exact decimal: it keeps its own input.
    expect(
      literalDisplayType(
        "decimal",
        { kind: "literal", type: "number", value: 0.5 },
        "en",
      ),
    ).toBe("number");
  });

  it("keeps a row's input type while its value is typed", () => {
    const stored = {
      kind: "literal" as const,
      type: "number" as const,
      value: 0.5,
    };
    const opened = rowDisplayType(undefined, "integer", stored, "en", "n|gt");
    expect(opened.type).toBe("number");
    const typed = {
      kind: "literal" as const,
      type: "number" as const,
      value: 1,
    };
    expect(rowDisplayType(opened, "integer", typed, "en", "n|gt")).toBe(opened);
    // Another column or operator decides again.
    expect(
      rowDisplayType(opened, "integer", undefined, "en", "m|gt").type,
    ).toBe("integer");
  });

  it("carries a unit only on numbers and a currency only on decimals", () => {
    const money = {
      kind: "literal" as const,
      type: "decimal" as const,
      value: "1",
      unit: "currency",
      currency: "EUR",
    };
    expect(literalEdit("string", "x", "EUR", "en", money)).toEqual({
      kind: "literal",
      type: "string",
      value: "x",
    });
    // A currency unit goes with its currency: neither moves to a number.
    expect(literalEdit("number", "2", "EUR", "en", money)).toEqual({
      kind: "literal",
      type: "number",
      value: 2,
    });
    const percent = {
      kind: "literal" as const,
      type: "decimal" as const,
      value: "1",
      unit: "percent",
    };
    expect(literalEdit("number", "2", "", "en", percent)).toEqual({
      kind: "literal",
      type: "number",
      value: 2,
      unit: "percent",
    });
    expect(
      literalEdit("date", "", "", "en", { ...money, unit: "percent" }),
    ).toEqual({
      kind: "literal",
      type: "date",
      value: null,
    });
  });
});

describe("fixed values typed before a type is picked (#630)", () => {
  it("follows a decimal or number neighbour, else the typed text", () => {
    expect(fixedValueMode("decimal")).toBe("decimal");
    expect(fixedValueMode("number")).toBe("number");
    expect(fixedValueMode("integer")).toBe("typed");
    expect(fixedValueMode(undefined)).toBe("typed");
    // Next to text, a switch or a date: a decimal, as before.
    expect(fixedValueMode("string")).toBe("decimal");
    expect(fixedValueMode("boolean")).toBe("decimal");
    expect(fixedValueMode("date")).toBe("decimal");
  });
  it("reads a whole number as an integer and keeps anything else a decimal", () => {
    const typed = (text: string) =>
      typedNumericLiteral(
        literalFromInput("decimal", text, "en") ?? {
          kind: "literal",
          type: "decimal",
          value: null,
        },
      );
    expect(typed("0")).toEqual({ kind: "literal", type: "integer", value: 0 });
    expect(typed("-12")).toEqual({
      kind: "literal",
      type: "integer",
      value: -12,
    });
    expect(typed("")).toEqual({
      kind: "literal",
      type: "decimal",
      value: null,
    });
    expect(typed("0.5")).toEqual({
      kind: "literal",
      type: "decimal",
      value: "0.5",
    });
    // Beyond the safe integers, and money, stay exact decimals.
    expect(typed("12345678901234567890").type).toBe("decimal");
    expect(
      typedNumericLiteral({
        kind: "literal",
        type: "decimal",
        value: "5",
        unit: "currency",
        currency: "EUR",
      }).type,
    ).toBe("decimal");
  });
});
