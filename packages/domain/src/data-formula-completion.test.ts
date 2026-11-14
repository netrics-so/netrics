import { describe, expect, it } from "vitest";
import {
  compileRowExpression,
  DATA_FUNCTIONS,
  DATA_TYPES,
  type DataExpression,
  type DataField,
  type DataType,
} from "./data-expression.js";
import {
  applyFormulaCompletion,
  DATA_FUNCTION_SIGNATURES,
  formulaArgumentHint,
  formulaCompletions,
} from "./data-formula-completion.js";
import { mulberry32 } from "./test-helpers.js";

const typed: DataField[] = DATA_TYPES.map((type) => ({
  id: "f_" + type,
  name: "F " + type,
  type,
  nullable: false,
}));
const sample = (type: DataType): DataExpression => ({
  kind: "field",
  fieldId: "f_" + type,
});

const fields: DataField[] = [
  { id: "revenue", name: "Revenue", type: "decimal", nullable: false },
  { id: "units", name: "Units", type: "integer", nullable: false },
  { id: "day", name: "Day", type: "date", nullable: false },
  { id: "seen", name: "Seen at", type: "timestamp", nullable: true },
  { id: "country", name: "Country", type: "string", nullable: false },
  { id: "a", name: "Same", type: "string", nullable: false },
  { id: "b", name: "same", type: "string", nullable: false },
];
const labels = (text: string, cursor = text.length) =>
  formulaCompletions(text, cursor, fields).items.map((item) => item.label);

describe("formula completion", () => {
  it("signatures agree with the checker", () => {
    for (const fn of DATA_FUNCTIONS) {
      const { params } = DATA_FUNCTION_SIGNATURES[fn];
      const args = params.map((param) => sample(param.types[0]!));
      expect(() =>
        compileRowExpression({ kind: "call", fn, args }, typed),
      ).not.toThrow();
      params.forEach((param, index) => {
        const outside = DATA_TYPES.find((type) => !param.types.includes(type));
        if (!outside) return;
        const wrong = args.map((arg, i) =>
          i === index ? sample(outside) : arg,
        );
        expect(
          () => compileRowExpression({ kind: "call", fn, args: wrong }, typed),
          `${fn} argument ${index} as ${outside}`,
        ).toThrow();
      });
    }
  });

  it("completes field names inside brackets", () => {
    const result = formulaCompletions("[Rev", 4, fields);
    expect(result).toMatchObject({ from: 0, to: 4 });
    expect(result.items).toEqual([
      {
        kind: "field",
        label: "Revenue",
        insert: "[Revenue]",
        fieldId: "revenue",
        type: "decimal",
      },
    ]);
    // Ambiguous names are inserted by id, as the formula printer does.
    expect(
      formulaCompletions("[sam", 4, fields).items.map((i) => i.insert),
    ).toEqual(["[a]", "[b]"]);
    // Matches anywhere in the name, ignoring case.
    expect(labels("1 + [VENU")).toEqual(["Revenue"]);
  });

  it("replaces the rest of the reference being edited", () => {
    const text = "[Rev] + 1";
    const result = formulaCompletions(text, 4, fields);
    expect(result).toMatchObject({ from: 0, to: 5 });
    expect(applyFormulaCompletion(text, result, result.items[0]!)).toEqual({
      text: "[Revenue] + 1",
      cursor: 9,
    });
  });

  it("keeps the text after an unclosed reference", () => {
    for (const [text, expected] of [
      ["[Rev + [Cost]", "[Revenue] + [Cost]"],
      ["[Rev[Cost] * 2", "[Revenue][Cost] * 2"],
      ["[Rev\n+ [Cost]", "[Revenue]\n+ [Cost]"],
      ["[Rev + 1", "[Revenue] + 1"],
    ] as const) {
      const result = formulaCompletions(text, 4, fields);
      expect(result, text).toMatchObject({ from: 0, to: 4 });
      expect(applyFormulaCompletion(text, result, result.items[0]!).text).toBe(
        expected,
      );
    }
  });

  it("completes functions from a prefix", () => {
    const result = formulaCompletions("ROU", 3, fields);
    expect(result).toMatchObject({ from: 0, to: 3 });
    expect(result.items).toContainEqual({
      kind: "function",
      label: "ROUND",
      insert: "ROUND(",
    });
    expect(applyFormulaCompletion("ROU", result, result.items[0]!)).toEqual({
      text: "ROUND(",
      cursor: 6,
    });
    expect(labels("1 + is")).toEqual(["IS_NULL", "ISBLANK"]);
    expect(labels("da")).toEqual(["DATE"]);
    expect(labels("tr")).toEqual(["TRIM", "TRUE"]);
    expect(
      formulaCompletions("tr", 2, fields).items.find((i) => i.label === "TRUE"),
    ).toEqual({ kind: "keyword", label: "TRUE", insert: "TRUE" });
    // Logical words are operators, not values (AND( is also a function).
    for (const [text, word] of [
      ["x an", "AND"],
      ["x o", "OR"],
      ["no", "NOT"],
    ] as const)
      expect(
        formulaCompletions(text, text.length, fields)
          .items.filter((i) => i.label === word && i.kind !== "function")
          .map((i) => i.kind),
        text,
      ).toEqual(["operator"]);
  });

  it("does not repeat an existing parenthesis", () => {
    const text = "ROU([Revenue], 2)";
    const result = formulaCompletions(text, 2, fields);
    expect(result).toMatchObject({ from: 0, to: 3 });
    const round = result.items.find((i) => i.label === "ROUND")!;
    expect(applyFormulaCompletion(text, result, round)).toEqual({
      text: "ROUND([Revenue], 2)",
      cursor: 6,
    });
  });

  it("offers operators after an operand", () => {
    for (const text of ["[Revenue] ", '"x" ', "2 ", "ROUND([Revenue], 2) "]) {
      const result = formulaCompletions(text, text.length, fields);
      expect(result).toMatchObject({ from: text.length, to: text.length });
      expect(result.items.map((i) => i.label)).toEqual([
        "=",
        "!=",
        "<",
        "<=",
        ">",
        ">=",
        "+",
        "-",
        "*",
        "/",
        "AND",
        "OR",
      ]);
      expect(result.items.every((i) => i.kind === "operator")).toBe(true);
    }
    expect(labels("[Revenue] + ")).not.toContain("+");
    expect(labels("[Revenue]")).toEqual([]);
  });

  it("restricts fields to the argument's types", () => {
    expect(labels("YEAR([")).toEqual(["Day", "Seen at"]);
    expect(labels("ROUND([Revenue], [")).toEqual(["Units"]);
    expect(labels("CONCAT([Country], [")).toEqual(["Country", "Same", "same"]);
    // An operand inside a larger argument is not the argument itself.
    expect(labels("YEAR([Day] + [")).toHaveLength(fields.length);
  });

  it("offers everything for an empty operand", () => {
    const items = formulaCompletions("YEAR(", 5, fields).items;
    expect(items.filter((i) => i.kind === "field").map((i) => i.label)).toEqual(
      ["Day", "Seen at"],
    );
    expect(items.some((i) => i.label === "ROUND")).toBe(true);
    expect(items.some((i) => i.label === "NULL")).toBe(true);
    expect(formulaCompletions('"open', 5, fields).items).toEqual([]);
  });

  it("hints the current argument", () => {
    expect(formulaArgumentHint("ROUND([Revenue], ", 17)).toEqual({
      fn: "ROUND",
      argument: 1,
      signature: DATA_FUNCTION_SIGNATURES.round,
    });
    expect(formulaArgumentHint("round (", 7)).toMatchObject({
      fn: "ROUND",
      argument: 0,
    });
    expect(formulaArgumentHint("IF([a] = 1, ROUND(", 18)).toMatchObject({
      fn: "ROUND",
      argument: 0,
    });
    expect(formulaArgumentHint("IF([a] = 1, ROUND(1, 2), ", 25)).toMatchObject({
      fn: "IF",
      argument: 2,
    });
    expect(formulaArgumentHint('IF("a,(b", ', 11)).toMatchObject({
      fn: "IF",
      argument: 1,
    });
    expect(formulaArgumentHint("ISBLANK(", 8)).toMatchObject({
      fn: "ISBLANK",
      signature: DATA_FUNCTION_SIGNATURES.is_null,
    });
    expect(formulaArgumentHint("ROUND(1, 2)", 11)).toBeNull();
    expect(formulaArgumentHint("DATE(", 5)).toBeNull();
    expect(formulaArgumentHint("[Revenue]", 9)).toBeNull();
  });

  it("never throws on unbalanced text", () => {
    const alphabet = [
      ...'[]]"\\(),; +-*/=<>!abcRUNDOTE0123.',
      "ROUND(",
      "[Rev",
      "IF(",
      " AND ",
      '"x',
    ];
    const random = mulberry32(569);
    for (let n = 0; n < 2000; n++) {
      let text = "";
      const length = Math.floor(random() * 16);
      for (let i = 0; i < length; i++)
        text += alphabet[Math.floor(random() * alphabet.length)];
      const cursor = Math.floor(random() * (text.length + 1));
      const result = formulaCompletions(text, cursor, fields);
      expect(result.from).toBeLessThanOrEqual(cursor);
      expect(result.to).toBeGreaterThanOrEqual(cursor);
      formulaArgumentHint(text, cursor);
      for (const item of result.items.slice(0, 3))
        applyFormulaCompletion(text, result, item);
    }
  });
});
