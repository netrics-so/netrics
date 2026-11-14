import { describe, expect, it } from "vitest";
import { parseDataFormula, formatDataFormula } from "./data-formula.js";
import { compileRowExpression, type DataField } from "./data-expression.js";
import { fromVisual, sameDataExpression } from "./data-expression-visual.js";
import { mulberry32, randomVisualModel } from "./test-helpers.js";
const fields: DataField[] = [
  { id: "revenue", name: "Revenue", type: "decimal", nullable: true },
  { id: "downloads", name: "Downloads", type: "integer", nullable: true },
  { id: "paid", name: "Paid", type: "boolean", nullable: true },
];
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
          expect(
            sameDataExpression(parseDataFormula(text, fields), e),
            `seed ${seed} #${i}: ${text}`,
          ).toBe(true);
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
