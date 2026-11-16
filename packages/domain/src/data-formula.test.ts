import { describe, expect, it } from "vitest";
import { parseDataFormula, formatDataFormula } from "./data-formula.js";
import {
  compileRowExpression,
  type DataExpression,
  type DataField,
} from "./data-expression.js";
import { fromVisual, sameDataExpression } from "./data-expression-visual.js";
import { mulberry32, randomVisualModel } from "./test-helpers.js";
const fields: DataField[] = [
  { id: "revenue", name: "Revenue", type: "decimal", nullable: true },
  { id: "downloads", name: "Downloads", type: "integer", nullable: true },
  { id: "paid", name: "Paid", type: "boolean", nullable: true },
];
/**
 * Equal, except that a whole decimal literal may read back as the same
 * integer (it prints as a plain number where that means the same).
 */
function sameUpToPlainDecimals(
  parsed: DataExpression,
  original: DataExpression,
): boolean {
  if (
    parsed.kind === "literal" &&
    original.kind === "literal" &&
    parsed.type === "integer" &&
    original.type === "decimal"
  )
    return (
      String(parsed.value) === original.value &&
      parsed.unit === original.unit &&
      parsed.currency === original.currency
    );
  if (parsed.kind === "call" && original.kind === "call")
    return (
      parsed.fn === original.fn &&
      parsed.args.length === original.args.length &&
      parsed.args.every((arg, i) =>
        sameUpToPlainDecimals(arg, original.args[i]!),
      )
    );
  return sameDataExpression(parsed, original);
}
/** Result type and value on a sample row, or the error code. */
function outcome(expression: DataExpression) {
  try {
    const compiled = compileRowExpression(expression, fields);
    const cell = compiled.evaluate({
      revenue: "12.50",
      downloads: 5,
      paid: true,
    });
    return JSON.stringify([compiled.result.type, cell]);
  } catch (error) {
    return (error as Error).message;
  }
}
function evaluate(
  text: string,
  row: Record<string, unknown> = { revenue: "12.50", downloads: 5, paid: true },
) {
  return compileRowExpression(parseDataFormula(text, fields), fields).evaluate(
    row,
  ).value;
}
describe("editable formulas", () => {
  it("resolves readable labels to stable field IDs", () => {
    const expression = parseDataFormula("[Revenue] / [Downloads]", fields);
    expect(expression).toEqual({
      kind: "call",
      fn: "divide",
      args: [
        { kind: "field", fieldId: "revenue" },
        { kind: "field", fieldId: "downloads" },
      ],
    });
    expect(evaluate("[Revenue] / [Downloads]")).toBe("2.5");
  });
  it("uses arithmetic precedence and parentheses", () => {
    expect(evaluate("1 + 2 * 3")).toBe(7);
    expect(evaluate("(1 + 2) * 3")).toBe(9);
    expect(evaluate("10 - 3 - 2")).toBe(5);
    expect(evaluate("0.1 + 0.2")).toBe("0.3");
  });
  it("uses numeric thresholds in the type of a floating-point source", () => {
    const rating: DataField[] = [
      {
        id: "rating",
        name: "Rating",
        type: "number",
        nullable: false,
        unit: "stars",
      },
    ];
    expect(
      compileRowExpression(
        parseDataFormula("[Rating] < 4.5", rating),
        rating,
      ).evaluate({ rating: 4.2 }).value,
    ).toBe(true);
    expect(
      compileRowExpression(
        parseDataFormula("0.5 + [Rating]", rating),
        rating,
      ).evaluate({ rating: 4.2 }),
    ).toMatchObject({ value: 4.7, unit: "stars" });
  });
  it("supports boolean conditions, named functions and null handling", () => {
    expect(
      evaluate("IF([Paid] AND [Downloads] > 0, [Revenue] / [Downloads], NULL)"),
    ).toBe("2.5");
    expect(evaluate("IF(FALSE, 1, NULL)")).toBeNull();
    expect(evaluate("COALESCE(NULL, 0)")).toBe(0);
    expect(
      evaluate("ISBLANK([Revenue])", {
        revenue: null,
        downloads: 0,
        paid: false,
      }),
    ).toBe(true);
    expect(evaluate("NOT [Paid]")).toBe(false);
    expect(evaluate("TRUE() OR FALSE()")).toBe(true);
  });
  it("round-trips formulas using renamed references", () => {
    const expression = parseDataFormula("[Revenue] / [Downloads]", fields);
    const renamed = fields.map((f) =>
      f.id === "revenue" ? { ...f, name: "App income" } : f,
    );
    const text = formatDataFormula(expression, renamed);
    expect(text).toContain("[App income]");
    expect(parseDataFormula(text, renamed)).toEqual(expression);
  });
  it("refuses ambiguous labels rather than guessing a source", () => {
    expect(() =>
      parseDataFormula("[Downloads]", [
        ...fields,
        { id: "other", name: "Downloads" },
      ]),
    ).toThrow("formula_reference_ambiguous");
    expect(() => parseDataFormula("[Unknown]", fields)).toThrow(
      "formula_reference_not_found",
    );
  });
  it("round-trips negative unit literals and falls back to IDs for duplicate labels", () => {
    const expression = {
      kind: "literal",
      type: "decimal",
      value: "-2.5",
      unit: "currency",
      currency: "EUR",
    } as const;
    expect(parseDataFormula(formatDataFormula(expression, []), [])).toEqual(
      expression,
    );
    const ambiguous = [
      { id: "a", name: "Amount" },
      { id: "b", name: "Amount" },
    ];
    expect(formatDataFormula({ kind: "field", fieldId: "a" }, ambiguous)).toBe(
      "[a]",
    );
  });
  it("does not allow arbitrary code, property access or unknown functions", () => {
    for (const text of [
      "process.env.SECRET",
      'eval("x")',
      "[Revenue].constructor",
      'fetch("https://example.com")',
      "1;DROP TABLE x",
    ])
      expect(() => parseDataFormula(text, fields)).toThrow();
  });
  it("bounds nesting and rejects malformed strings without echoing their content", () => {
    expect(() =>
      parseDataFormula("(".repeat(50) + "1" + ")".repeat(50), fields),
    ).toThrow("formula_complexity_limit");
    expect(() =>
      parseDataFormula('"private unterminated data', fields),
    ).toThrow(/^formula_string_invalid$/);
  });
  it("formula text round-trips every visual expression", () => {
    for (const seed of [1, 2, 3]) {
      const random = mulberry32(seed);
      for (let i = 0; i < 1000; i++)
        for (const target of ["condition", "calculation"] as const) {
          const e = fromVisual(
            randomVisualModel(
              random,
              fields.map((f) => f.id),
              target,
            ),
          );
          const text = formatDataFormula(e, fields);
          const parsed = parseDataFormula(text, fields);
          if (sameDataExpression(parsed, e)) continue;
          // A whole decimal printed as a plain number reads back as an
          // integer only where that changes neither result type nor value.
          expect(
            sameUpToPlainDecimals(parsed, e),
            `seed ${seed} #${i}: ${text}`,
          ).toBe(true);
          expect(outcome(parsed), `seed ${seed} #${i}: ${text}`).toBe(
            outcome(e),
          );
          expect(formatDataFormula(parsed, fields)).toBe(text);
        }
    }
  });
  it("prints literal forms that parse back to the same literal", () => {
    expect(
      formatDataFormula(
        { kind: "literal", type: "date", value: "2026-01-31" },
        [],
      ),
    ).toBe('DATE("2026-01-31")');
    expect(
      formatDataFormula({ kind: "literal", type: "decimal", value: "2" }, []),
    ).toBe('DECIMAL("2")');
    expect(
      formatDataFormula(
        { kind: "literal", type: "decimal", value: "-1.50" },
        [],
      ),
    ).toBe("-1.50");
    expect(
      formatDataFormula({ kind: "literal", type: "number", value: 1e21 }, []),
    ).toBe('NUMBER("1e+21")');
    expect(parseDataFormula("-5", [])).toEqual({
      kind: "literal",
      type: "integer",
      value: -5,
    });
    expect(parseDataFormula("-[Revenue]", fields)).toEqual({
      kind: "call",
      fn: "negate",
      args: [{ kind: "field", fieldId: "revenue" }],
    });
    expect(() => parseDataFormula('DATE("2026-13-01")', [])).toThrow(
      "formula_literal_invalid",
    );
  });
  it("prints a whole decimal typed in the builder as a plain number next to a decimal (#630)", () => {
    const decimal = (value: string): DataExpression => ({
      kind: "literal",
      type: "decimal",
      value,
    });
    const revenue: DataExpression = { kind: "field", fieldId: "revenue" };
    const downloads: DataExpression = { kind: "field", fieldId: "downloads" };
    const cases: [DataExpression, string][] = [
      [
        { kind: "call", fn: "gt", args: [revenue, decimal("0")] },
        "GT([Revenue], 0)",
      ],
      [
        { kind: "call", fn: "lte", args: [decimal("-5"), revenue] },
        "LTE(-5, [Revenue])",
      ],
      [
        {
          kind: "call",
          fn: "add",
          args: [revenue, decimal("12345678901234567890")],
        },
        "ADD([Revenue], 12345678901234567890)",
      ],
      [
        { kind: "call", fn: "multiply", args: [revenue, decimal("-1.50")] },
        "MULTIPLY([Revenue], -1.50)",
      ],
      [
        { kind: "call", fn: "subtract", args: [decimal("1.5"), decimal("2")] },
        "SUBTRACT(1.5, 2)",
      ],
      [
        {
          kind: "call",
          fn: "if",
          args: [{ kind: "field", fieldId: "paid" }, decimal("0"), revenue],
        },
        "IF([Paid], 0, [Revenue])",
      ],
      [
        {
          kind: "call",
          fn: "add",
          args: [
            { kind: "call", fn: "multiply", args: [revenue, decimal("2")] },
            decimal("-3"),
          ],
        },
        "ADD(MULTIPLY([Revenue], 2), -3)",
      ],
      // The wrapper stays where an integer would change the result type.
      [decimal("0"), 'DECIMAL("0")'],
      [
        { kind: "call", fn: "add", args: [downloads, decimal("0")] },
        'ADD([Downloads], DECIMAL("0"))',
      ],
      [
        { kind: "call", fn: "add", args: [decimal("1"), decimal("2")] },
        'ADD(DECIMAL("1"), DECIMAL("2"))',
      ],
      [
        { kind: "call", fn: "coalesce", args: [revenue, decimal("0")] },
        'COALESCE([Revenue], DECIMAL("0"))',
      ],
    ];
    for (const [expression, text] of cases) {
      expect(formatDataFormula(expression, fields)).toBe(text);
      const parsed = parseDataFormula(text, fields);
      expect(sameUpToPlainDecimals(parsed, expression), text).toBe(true);
      expect(outcome(parsed), text).toBe(outcome(expression));
    }
    // Without column types the printer cannot know, and keeps the wrapper.
    expect(
      formatDataFormula(
        { kind: "call", fn: "gt", args: [revenue, decimal("0")] },
        [{ id: "revenue", name: "Revenue" }],
      ),
    ).toBe('GT([Revenue], DECIMAL("0"))');
  });
  it("parses every literal form and refuses malformed ones", () => {
    expect(parseDataFormula('TIMESTAMP("2026-01-31T12:00:00Z")', [])).toEqual({
      kind: "literal",
      type: "timestamp",
      value: "2026-01-31T12:00:00Z",
    });
    expect(parseDataFormula('JSON("[1,\\"a\\"]")', [])).toEqual({
      kind: "literal",
      type: "json",
      value: [1, "a"],
    });
    expect(parseDataFormula('-DECIMAL("-2")', [])).toEqual({
      kind: "literal",
      type: "decimal",
      value: "2",
    });
    expect(parseDataFormula('UNIT(NUMBER("1.5"), "kg")', [])).toEqual({
      kind: "literal",
      type: "number",
      value: 1.5,
      unit: "kg",
    });
    for (const text of [
      'NUMBER("abc")',
      'NUMBER("")',
      'DECIMAL("1e3")',
      'JSON("{")',
      "DATE([Revenue])",
      'DATE("2026-01-01", "x")',
      "DATE()",
    ])
      expect(() => parseDataFormula(text, fields), text).toThrow(
        "formula_literal_invalid",
      );
    // Stored window filters keep parsing TO_DATE as a call.
    expect(parseDataFormula('TO_DATE("2026-01-31")', [])).toEqual({
      kind: "call",
      fn: "to_date",
      args: [{ kind: "literal", type: "string", value: "2026-01-31" }],
    });
  });
  it("keeps binary minus and negates non-literal operands", () => {
    expect(evaluate("10 - -3")).toBe(13);
    expect(parseDataFormula("2 * -[Downloads]", fields)).toEqual({
      kind: "call",
      fn: "multiply",
      args: [
        { kind: "literal", type: "integer", value: 2 },
        {
          kind: "call",
          fn: "negate",
          args: [{ kind: "field", fieldId: "downloads" }],
        },
      ],
    });
  });
});
