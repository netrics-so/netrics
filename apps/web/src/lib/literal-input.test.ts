import { afterEach, describe, expect, it } from "vitest";
import {
  literalFromInput,
  literalInputText,
  listFromInput,
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
});
