import {
  dataFail,
  DataProcessingError,
  PROCESSING_LIMITS,
  validateDataValue,
  type DataExpression,
  type DataFunction,
  type DataField,
  type DataType,
} from "./data-expression.js";

/**
 * Typed literal forms, e.g. `DATE("2026-01-31")`: each takes exactly one
 * string, or NULL for an empty value of that type (`DECIMAL(NULL)`, #682),
 * and parses to a literal (not a call), so printed formulas read back as the
 * same literal.
 */
export const FORMULA_LITERAL_FORMS = [
  "DATE",
  "TIMESTAMP",
  "NUMBER",
  "DECIMAL",
  "JSON",
  "INTEGER",
  "STRING",
  "BOOLEAN",
] as const;
type FormulaLiteralForm = (typeof FORMULA_LITERAL_FORMS)[number];
const literalFormTypes: Record<FormulaLiteralForm, DataType> = {
  DATE: "date",
  TIMESTAMP: "timestamp",
  NUMBER: "number",
  DECIMAL: "decimal",
  JSON: "json",
  INTEGER: "integer",
  STRING: "string",
  BOOLEAN: "boolean",
};
const formOfType = Object.fromEntries(
  Object.entries(literalFormTypes).map(([form, type]) => [type, form]),
) as Partial<Record<DataType, FormulaLiteralForm>>;
const numberText = /^-?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:e[+-]?[0-9]+)?$/i;
const numericTypes: readonly DataType[] = ["integer", "number", "decimal"];

/** `text` null: the form's NULL, an empty value of its type. */
function literalForm(
  form: FormulaLiteralForm,
  text: string | null,
): DataExpression {
  const type = literalFormTypes[form];
  if (text === null) return { kind: "literal", type, value: null };
  try {
    if (
      (type === "number" && !numberText.test(text)) ||
      (type === "integer" && !/^-?(0|[1-9][0-9]*)$/.test(text)) ||
      (type === "boolean" && text !== "TRUE" && text !== "FALSE")
    )
      dataFail("formula_literal_invalid");
    const value: unknown =
      type === "number" || type === "integer"
        ? Number(text)
        : type === "json"
          ? (JSON.parse(text) as unknown)
          : type === "boolean"
            ? text === "TRUE"
            : text;
    validateDataValue(type, value, false);
    return { kind: "literal", type, value };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof DataProcessingError)
      return dataFail("formula_literal_invalid");
    throw error;
  }
}

/** `-` before a plain numeric literal is part of the literal: `-5` is -5. */
function negated(operand: DataExpression): DataExpression {
  if (
    operand.kind !== "literal" ||
    !numericTypes.includes(operand.type) ||
    operand.unit !== undefined ||
    operand.value === null
  )
    return { kind: "call", fn: "negate", args: [operand] };
  if (operand.type === "decimal") {
    const text = String(operand.value);
    return {
      ...operand,
      value: text.startsWith("-") ? text.slice(1) : "-" + text,
    };
  }
  return { ...operand, value: 0 - Number(operand.value) };
}

export interface FormulaReference {
  id: string;
  name: string;
  /** The column's type, when known: lets plain numbers print without a wrapper. */
  type?: DataType;
}
const functions = new Set<DataFunction>([
  "add",
  "subtract",
  "multiply",
  "divide",
  "negate",
  "abs",
  "round",
  "eq",
  "in",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "and",
  "or",
  "not",
  "if",
  "coalesce",
  "is_null",
  "concat",
  "lower",
  "upper",
  "trim",
  "contains",
  "starts_with",
  "length",
  "to_string",
  "to_decimal",
  "to_integer",
  "to_number",
  "to_boolean",
  "to_date",
  "to_timestamp",
  "to_json",
  "year",
  "month",
  "json_get",
]);
interface Token {
  kind: "number" | "string" | "reference" | "word" | "symbol" | "end";
  text: string;
}
const operators: Record<string, { fn: DataFunction; precedence: number }> = {
  OR: { fn: "or", precedence: 1 },
  AND: { fn: "and", precedence: 2 },
  "=": { fn: "eq", precedence: 3 },
  "==": { fn: "eq", precedence: 3 },
  "!=": { fn: "ne", precedence: 3 },
  "<>": { fn: "ne", precedence: 3 },
  "<": { fn: "lt", precedence: 3 },
  "<=": { fn: "lte", precedence: 3 },
  ">": { fn: "gt", precedence: 3 },
  ">=": { fn: "gte", precedence: 3 },
  "+": { fn: "add", precedence: 4 },
  "-": { fn: "subtract", precedence: 4 },
  "*": { fn: "multiply", precedence: 5 },
  "/": { fn: "divide", precedence: 5 },
};
function tokenize(text: string): Token[] {
  if (!text.trim() || text.length > 10_000) dataFail("formula_length_invalid");
  const tokens: Token[] = [];
  let at = 0;
  while (at < text.length) {
    if (/\s/.test(text[at]!)) {
      at++;
      continue;
    }
    if (tokens.length > 1000) dataFail("formula_complexity_limit");
    const first = text[at]!;
    if (first === "[") {
      at++;
      let name = "",
        closed = false;
      while (at < text.length) {
        if (text[at] === "]") {
          if (text[at + 1] === "]") {
            name += "]";
            at += 2;
            continue;
          }
          at++;
          closed = true;
          break;
        }
        name += text[at++];
      }
      if (!closed || !name) dataFail("formula_reference_invalid");
      tokens.push({ kind: "reference", text: name });
      continue;
    }
    if (first === '"') {
      const start = at++;
      let escaped = false,
        closed = false;
      while (at < text.length) {
        const char = text[at++]!;
        if (!escaped && char === '"') {
          closed = true;
          break;
        }
        if (!escaped && char === "\\") escaped = true;
        else escaped = false;
      }
      if (!closed) dataFail("formula_string_invalid");
      try {
        tokens.push({
          kind: "string",
          text: JSON.parse(text.slice(start, at)) as string,
        });
      } catch {
        dataFail("formula_string_invalid");
      }
      continue;
    }
    const number = /^[0-9]+(?:\.[0-9]+)?/.exec(text.slice(at));
    if (number) {
      tokens.push({ kind: "number", text: number[0] });
      at += number[0].length;
      continue;
    }
    const word = /^[a-z_][a-z_0-9]*/i.exec(text.slice(at));
    if (word) {
      tokens.push({ kind: "word", text: word[0].toUpperCase() });
      at += word[0].length;
      continue;
    }
    const pair = text.slice(at, at + 2);
    if (["<=", ">=", "!=", "<>", "=="].includes(pair)) {
      tokens.push({ kind: "symbol", text: pair });
      at += 2;
      continue;
    }
    if ("()+-*/=<>;,".includes(first)) {
      tokens.push({ kind: "symbol", text: first === ";" ? "," : first });
      at++;
      continue;
    }
    dataFail("formula_token_invalid");
  }
  return [...tokens, { kind: "end", text: "" }];
}

/** Friendly formula text resolves labels to stable IDs; no identifiers execute code. */
export function parseDataFormula(
  text: string,
  references: readonly FormulaReference[],
): DataExpression {
  const tokens = tokenize(text);
  let at = 0,
    nodes = 0;
  const peek = () => tokens[at]!;
  const take = () => tokens[at++]!;
  const expect = (text: string) => {
    if (take().text !== text) dataFail("formula_syntax_invalid");
  };
  const parse = (minimum = 0, depth = 0): DataExpression => {
    if (++nodes > PROCESSING_LIMITS.nodes || depth > PROCESSING_LIMITS.depth)
      dataFail("formula_complexity_limit");
    const token = take();
    let left: DataExpression;
    if (token.text === "(") {
      left = parse(0, depth + 1);
      expect(")");
    } else if (token.text === "-") {
      left = negated(parse(6, depth + 1));
    } else if (token.text === "NOT" && peek().text !== "(") {
      // Prefix NOT; `NOT(…)` reads as a call below, so the printed form of
      // any argument count parses back and compiling reports the arity (#760).
      left = { kind: "call", fn: "not", args: [parse(6, depth + 1)] };
    } else if (
      token.kind === "word" &&
      (FORMULA_LITERAL_FORMS as readonly string[]).includes(token.text)
    ) {
      if (peek().text !== "(") dataFail("formula_literal_invalid");
      take();
      const text = take();
      const empty = text.kind === "word" && text.text === "NULL";
      if ((text.kind !== "string" && !empty) || peek().text !== ")")
        dataFail("formula_literal_invalid");
      take();
      left = literalForm(
        token.text as FormulaLiteralForm,
        empty ? null : text.text,
      );
    } else if (token.kind === "reference") {
      const exact = references.find((ref) => ref.id === token.text),
        matches = references.filter(
          (ref) => ref.name.toLowerCase() === token.text.toLowerCase(),
        );
      if (!exact && matches.length !== 1)
        dataFail(
          matches.length
            ? "formula_reference_ambiguous"
            : "formula_reference_not_found",
        );
      left = { kind: "field", fieldId: (exact ?? matches[0])!.id };
    } else if (token.kind === "number") {
      const integer = Number(token.text);
      left =
        !token.text.includes(".") && Number.isSafeInteger(integer)
          ? { kind: "literal", type: "integer", value: integer }
          : { kind: "literal", type: "decimal", value: token.text };
    } else if (token.kind === "string")
      left = { kind: "literal", type: "string", value: token.text };
    else if (token.kind === "word") {
      if (["TRUE", "FALSE", "NULL", "BLANK"].includes(token.text)) {
        if (peek().text === "(") {
          take();
          expect(")");
        }
        left =
          token.text === "TRUE" || token.text === "FALSE"
            ? { kind: "literal", type: "boolean", value: token.text === "TRUE" }
            : { kind: "literal", type: "json", value: null };
      } else {
        expect("(");
        const args: DataExpression[] = [];
        if (peek().text !== ")")
          while (true) {
            args.push(parse(0, depth + 1));
            if (args.length > 20) dataFail("formula_arity_limit");
            if (peek().text !== ",") break;
            take();
          }
        expect(")");
        if (token.text === "UNIT") {
          let [value] = args;
          const [, unit, currency] = args;
          if (
            value?.kind === "call" &&
            value.fn === "negate" &&
            value.args.length === 1
          ) {
            const operand = value.args[0]!;
            if (
              operand.kind === "literal" &&
              ["integer", "number", "decimal"].includes(operand.type)
            )
              value = {
                ...operand,
                value:
                  operand.type === "decimal"
                    ? String(operand.value).startsWith("-")
                      ? String(operand.value).slice(1)
                      : "-" + String(operand.value)
                    : -Number(operand.value),
              };
          }
          if (
            args.length < 2 ||
            args.length > 3 ||
            value?.kind !== "literal" ||
            unit?.kind !== "literal" ||
            unit.type !== "string" ||
            typeof unit.value !== "string" ||
            (currency &&
              (currency.kind !== "literal" ||
                currency.type !== "string" ||
                typeof currency.value !== "string"))
          )
            dataFail("formula_unit_invalid");
          left = {
            ...value,
            unit: unit.value,
            ...(currency?.kind === "literal"
              ? { currency: String(currency.value) }
              : {}),
          };
        } else {
          const alias =
            token.text === "ISBLANK"
              ? "is_null"
              : token.text === "VALUE"
                ? "to_decimal"
                : token.text.toLowerCase();
          if (!functions.has(alias as DataFunction))
            dataFail("formula_function_unknown");
          left = { kind: "call", fn: alias as DataFunction, args };
        }
      }
    } else return dataFail("formula_syntax_invalid");
    while (true) {
      const operator = operators[peek().text];
      if (!operator || operator.precedence < minimum) break;
      take();
      if (++nodes > PROCESSING_LIMITS.nodes)
        dataFail("formula_complexity_limit");
      const right = parse(operator.precedence + 1, depth + 1);
      left = { kind: "call", fn: operator.fn, args: [left, right] };
    }
    return left;
  };
  const result = parse();
  if (peek().kind !== "end") dataFail("formula_syntax_invalid");
  return result;
}

/** Operators whose result does not depend on an integer vs decimal operand next to a decimal. */
const decimalNeutral = new Set<DataFunction>([
  "add",
  "subtract",
  "multiply",
  "divide",
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
]);
/** A whole number in its one canonical spelling (no sign on zero, no leading zeros). */
const wholeDecimal = /^(0|-?[1-9][0-9]*)$/;
/** Number text that reads back as an integer or a scalar decimal. */
const plainNumberText = /^-?(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/;

/**
 * Whether `expression` has `type` from its printed text alone. A decimal:
 * a decimal column, a decimal literal with a point, or arithmetic over one;
 * whole decimal literals do not count, they may print as plain numbers. A
 * number: a number column or arithmetic over one (never a literal, which is
 * a scalar that does not decide the type next to a decimal).
 */
function printsAs(
  type: "decimal" | "number",
  expression: DataExpression,
  references: readonly FormulaReference[],
): boolean {
  if (expression.kind === "field")
    return references.find((r) => r.id === expression.fieldId)?.type === type;
  if (expression.kind === "literal")
    return (
      type === "decimal" &&
      expression.type === "decimal" &&
      typeof expression.value === "string" &&
      expression.value.includes(".")
    );
  const any = (args: readonly DataExpression[]) =>
    args.some((arg) => printsAs(type, arg, references));
  if (["add", "subtract", "multiply", "divide"].includes(expression.fn))
    return any(expression.args);
  if (expression.fn === "if") return any(expression.args.slice(1));
  if (expression.fn === "coalesce") return any(expression.args);
  if (["negate", "abs", "round"].includes(expression.fn))
    return any(expression.args.slice(0, 1));
  return type === "decimal" && expression.fn === "to_decimal";
}

/**
 * The operands next to `args[index]` whose type the result shares: the
 * other operand of arithmetic or a comparison, the other branch of IF, the
 * other values of COALESCE. A plain number there is promoted to their type.
 */
function neighbours(
  fn: DataFunction,
  args: readonly DataExpression[],
  index: number,
): readonly DataExpression[] {
  if (decimalNeutral.has(fn) && args.length === 2) return [args[1 - index]!];
  if (fn === "if" && args.length === 3 && index > 0) return [args[3 - index]!];
  if (fn === "coalesce") return args.filter((_, i) => i !== index);
  return [];
}

/**
 * A numeric literal typed in the builder prints as the plain number where
 * reading it back as an integer (or a scalar decimal) means the same:
 * - a whole decimal (`0`) next to a decimal, which promotes it anyway;
 * - a number without a unit (`0`, `1.5`) next to a number column, whose
 *   type a scalar beside it takes.
 * Elsewhere (alone, next to an integer column) `DECIMAL("0")` and
 * `NUMBER("0")` keep the result's type.
 */
function plainLiteral(
  expression: DataExpression,
  around: readonly DataExpression[],
  references: readonly FormulaReference[],
): boolean {
  if (expression.kind !== "literal" || expression.value === null) return false;
  if (expression.type === "decimal")
    return (
      typeof expression.value === "string" &&
      wholeDecimal.test(expression.value) &&
      around.some((e) => printsAs("decimal", e, references))
    );
  return (
    expression.type === "number" &&
    expression.unit === undefined &&
    typeof expression.value === "number" &&
    !Object.is(expression.value, -0) &&
    plainNumberText.test(String(expression.value)) &&
    around.some((e) => printsAs("number", e, references))
  );
}

export function formatDataFormula(
  expression: DataExpression,
  references: readonly FormulaReference[],
): string {
  return formatExpression(expression, references, false);
}

function formatExpression(
  expression: DataExpression,
  references: readonly FormulaReference[],
  plain: boolean,
): string {
  if (expression.kind === "field") {
    const ref = references.find((r) => r.id === expression.fieldId);
    const name =
      ref &&
      references.filter((r) => r.name.toLowerCase() === ref.name.toLowerCase())
        .length === 1 &&
      !references.some((r) => r.id === ref.name && r.id !== ref.id)
        ? ref.name
        : expression.fieldId;
    return "[" + name.replace(/]/g, "]]") + "]";
  }
  if (expression.kind === "call") {
    return (
      expression.fn.toUpperCase() +
      "(" +
      expression.args
        .map((arg, index) =>
          formatExpression(
            arg,
            references,
            plainLiteral(
              arg,
              neighbours(expression.fn, expression.args, index),
              references,
            ),
          ),
        )
        .join(", ") +
      ")"
    );
  }
  const value =
    expression.value === null
      ? // A typed NULL keeps its type (#682); plain NULL reads back as JSON.
        expression.type === "json"
        ? "NULL"
        : formOfType[expression.type] + "(NULL)"
      : expression.type === "boolean"
        ? expression.value
          ? "TRUE"
          : "FALSE"
        : expression.type === "string"
          ? JSON.stringify(expression.value)
          : expression.type === "date" || expression.type === "timestamp"
            ? expression.type.toUpperCase() +
              "(" +
              JSON.stringify(expression.value) +
              ")"
            : expression.type === "json"
              ? "JSON(" + JSON.stringify(JSON.stringify(expression.value)) + ")"
              : expression.type === "number" && !plain
                ? "NUMBER(" + JSON.stringify(String(expression.value)) + ")"
                : expression.type === "decimal" &&
                    !plain &&
                    !String(expression.value).includes(".")
                  ? "DECIMAL(" + JSON.stringify(String(expression.value)) + ")"
                  : String(expression.value);
  return expression.unit
    ? "UNIT(" +
        value +
        ", " +
        JSON.stringify(expression.unit) +
        (expression.currency
          ? ", " + JSON.stringify(expression.currency)
          : "") +
        ")"
    : value;
}

export function formulaReferences(
  fields: readonly DataField[],
): FormulaReference[] {
  return fields.map(({ id, name, type }) => ({ id, name, type }));
}
