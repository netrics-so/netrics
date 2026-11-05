import {
  dataFail,
  PROCESSING_LIMITS,
  type DataExpression,
  type DataFunction,
  type DataField,
} from "./data-expression.js";

export interface FormulaReference {
  id: string;
  name: string;
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
    } else if (token.text === "-" || token.text === "NOT") {
      left = {
        kind: "call",
        fn: token.text === "-" ? "negate" : "not",
        args: [parse(6, depth + 1)],
      };
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

export function formatDataFormula(
  expression: DataExpression,
  references: readonly FormulaReference[],
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
  if (expression.kind === "call")
    return (
      expression.fn.toUpperCase() +
      "(" +
      expression.args
        .map((arg) => formatDataFormula(arg, references))
        .join(", ") +
      ")"
    );
  const value =
    expression.value === null
      ? "NULL"
      : expression.type === "boolean"
        ? expression.value
          ? "TRUE"
          : "FALSE"
        : expression.type === "string"
          ? JSON.stringify(expression.value)
          : expression.type === "date" || expression.type === "timestamp"
            ? "TO_" +
              expression.type.toUpperCase() +
              "(" +
              JSON.stringify(expression.value) +
              ")"
            : expression.type === "json"
              ? "TO_JSON(" +
                JSON.stringify(JSON.stringify(expression.value)) +
                ")"
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
  return fields.map(({ id, name }) => ({ id, name }));
}
