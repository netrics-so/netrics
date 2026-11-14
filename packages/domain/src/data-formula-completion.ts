import {
  DATA_FUNCTIONS,
  DATA_TYPES,
  type DataField,
  type DataFunction,
  type DataType,
} from "./data-expression.js";
import {
  FORMULA_LITERAL_FORMS,
  formatDataFormula,
  formulaReferences,
} from "./data-formula.js";

export type FormulaParamName =
  | "value"
  | "number"
  | "digits"
  | "text"
  | "search"
  | "condition"
  | "then"
  | "else"
  | "fallback"
  | "list"
  | "date"
  | "json"
  | "key"
  | "left"
  | "right";
export interface DataFunctionSignature {
  params: ReadonlyArray<{ name: FormulaParamName; types: readonly DataType[] }>;
  /** The last parameter repeats. */
  rest?: boolean;
}

const any: readonly DataType[] = DATA_TYPES;
const comparable = DATA_TYPES.filter((type) => type !== "json");
const numeric: readonly DataType[] = ["integer", "number", "decimal"];
const text: readonly DataType[] = ["string"];
const boolean: readonly DataType[] = ["boolean"];
const p = (name: FormulaParamName, types: readonly DataType[]) => ({
  name,
  types,
});
const arithmetic = { params: [p("left", numeric), p("right", numeric)] };
const comparison = { params: [p("left", comparable), p("right", comparable)] };
const logical = { params: [p("left", boolean), p("right", boolean)] };
const conversion = { params: [p("value", any)] };
const oneText = { params: [p("text", text)] };
const search = { params: [p("text", text), p("search", text)] };
const datePart = { params: [p("date", ["date", "timestamp"])] };

/** What the type checker (`compileRowExpression`) accepts per argument. */
export const DATA_FUNCTION_SIGNATURES: Readonly<
  Record<DataFunction, DataFunctionSignature>
> = {
  add: arithmetic,
  subtract: arithmetic,
  multiply: arithmetic,
  divide: arithmetic,
  negate: { params: [p("number", numeric)] },
  abs: { params: [p("number", numeric)] },
  round: { params: [p("number", numeric), p("digits", ["integer"])] },
  eq: comparison,
  ne: comparison,
  lt: comparison,
  lte: comparison,
  gt: comparison,
  gte: comparison,
  in: { params: [p("value", comparable), p("list", ["json"])] },
  and: logical,
  or: logical,
  not: { params: [p("condition", boolean)] },
  if: {
    params: [p("condition", boolean), p("then", any), p("else", any)],
  },
  coalesce: { params: [p("value", any), p("fallback", any)], rest: true },
  is_null: { params: [p("value", any)] },
  concat: { params: [p("text", text), p("text", text)], rest: true },
  lower: oneText,
  upper: oneText,
  trim: oneText,
  contains: search,
  starts_with: search,
  length: oneText,
  to_string: conversion,
  to_decimal: conversion,
  to_integer: conversion,
  to_number: conversion,
  to_boolean: conversion,
  to_date: conversion,
  to_timestamp: conversion,
  to_json: conversion,
  year: datePart,
  month: datePart,
  json_get: { params: [p("json", ["json"]), p("key", text)] },
};

export interface FormulaCompletion {
  kind: "function" | "field" | "operator" | "keyword";
  label: string;
  insert: string;
  fieldId?: string;
  type?: DataType;
}
export interface FormulaCompletionResult {
  /** The text from `from` to `to` is replaced by the chosen item. */
  from: number;
  to: number;
  items: FormulaCompletion[];
}

/** Formula names that are not `DATA_FUNCTIONS` names. */
const aliases: Readonly<Record<string, DataFunction>> = {
  ISBLANK: "is_null",
  VALUE: "to_decimal",
};
const functionNames = [
  ...DATA_FUNCTIONS.map((fn) => fn.toUpperCase()),
  ...Object.keys(aliases),
  "UNIT",
  ...FORMULA_LITERAL_FORMS,
];
const keywords = ["TRUE", "FALSE", "NULL", "AND", "OR", "NOT"];
const operatorLabels = [
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
];
const valueWords = new Set(["TRUE", "FALSE", "NULL", "BLANK"]);
const operatorWords = new Set(["AND", "OR", "NOT"]);

function signatureOf(name: string): DataFunctionSignature | undefined {
  const fn = aliases[name] ?? name.toLowerCase();
  return (DATA_FUNCTIONS as readonly string[]).includes(fn)
    ? DATA_FUNCTION_SIGNATURES[fn as DataFunction]
    : undefined;
}

interface OpenCall {
  /** The upper-cased name before `(`; null for a grouping parenthesis. */
  fn: string | null;
  argument: number;
  /** Whether the current argument has a token yet. */
  started: boolean;
}
type ScanState =
  | { kind: "string" | "none" }
  | {
      kind: "reference";
      start: number;
      name: string;
      argumentStart: boolean;
    }
  | { kind: "word"; start: number; text: string }
  | { kind: "operand"; space: boolean }
  | { kind: "expect" };
interface Scan {
  calls: OpenCall[];
  /** What ends right before the cursor. */
  at: ScanState;
}

/** Reads the text before the cursor, left to right, without ever failing. */
function scan(source: string, cursor: number): Scan {
  const end = Math.max(0, Math.min(cursor, source.length));
  const calls: OpenCall[] = [];
  let at: ScanState = { kind: "expect" };
  /** A function name waiting for its "(". */
  let pendingName: string | null = null;
  /** Marks the current argument started; true for its first token. */
  const token = () => {
    const top = calls[calls.length - 1];
    const first = !!top && !top.started;
    if (top) top.started = true;
    return first;
  };
  /** After a word, once something other than the word follows. */
  const endWord = (word: string): ScanState =>
    valueWords.has(word)
      ? { kind: "operand", space: false }
      : operatorWords.has(word)
        ? { kind: "expect" }
        : { kind: "none" };
  let i = 0;
  while (i < end) {
    const char = source[i]!;
    if (/\s/.test(char)) {
      i++;
      if (at.kind === "word") {
        pendingName = operatorWords.has(at.text) ? null : at.text;
        at = endWord(at.text);
      }
      if (at.kind === "operand") at = { kind: "operand", space: true };
      continue;
    }
    // Every token below sets `at`; a word right before it may name a call.
    if (at.kind === "word")
      pendingName = operatorWords.has(at.text) ? null : at.text;
    if (char !== "(") pendingName = null;
    if (char === '"') {
      token();
      let j = i + 1,
        escaped = false,
        closed = false;
      while (j < end) {
        const c = source[j++]!;
        if (!escaped && c === '"') {
          closed = true;
          break;
        }
        escaped = !escaped && c === "\\";
      }
      if (!closed) return { calls, at: { kind: "string" } };
      at = { kind: "operand", space: false };
      i = j;
      continue;
    }
    if (char === "[") {
      const start = i,
        argumentStart = token();
      let j = i + 1,
        name = "",
        closed = false;
      while (j < end) {
        if (source[j] === "]") {
          if (j + 1 < end && source[j + 1] === "]") {
            name += "]";
            j += 2;
            continue;
          }
          j++;
          closed = true;
          break;
        }
        name += source[j++];
      }
      if (!closed)
        return {
          calls,
          at: { kind: "reference", start, name, argumentStart },
        };
      at = { kind: "operand", space: false };
      i = j;
      continue;
    }
    const word = /^[a-z_][a-z_0-9]*/i.exec(source.slice(i, end));
    if (word) {
      const upper = word[0].toUpperCase();
      if (!operatorWords.has(upper)) token();
      at = { kind: "word", start: i, text: upper };
      i += word[0].length;
      continue;
    }
    const number = /^[0-9]+(?:\.[0-9]*)?/.exec(source.slice(i, end));
    if (number) {
      token();
      // A number is complete only once something follows it.
      at =
        i + number[0].length < end
          ? { kind: "operand", space: false }
          : { kind: "none" };
      i += number[0].length;
      continue;
    }
    i++;
    if (char === "(") {
      token();
      calls.push({ fn: pendingName, argument: 0, started: false });
      pendingName = null;
      at = { kind: "expect" };
    } else if (char === ")") {
      calls.pop();
      at = { kind: "operand", space: false };
    } else if (char === "," || char === ";") {
      const top = calls[calls.length - 1];
      if (top) {
        top.argument++;
        top.started = false;
      }
      at = { kind: "expect" };
    } else {
      // Operators, and anything the formula language does not know.
      at = { kind: "expect" };
    }
  }
  return { calls, at };
}

/** The types the argument at the cursor takes, when it is a whole argument. */
function argumentTypes(
  calls: readonly OpenCall[],
  argumentStart: boolean,
): readonly DataType[] | undefined {
  const top = calls[calls.length - 1];
  if (!top?.fn || !argumentStart) return undefined;
  const signature = signatureOf(top.fn);
  if (!signature) return undefined;
  const param =
    signature.params[top.argument] ??
    (signature.rest
      ? signature.params[signature.params.length - 1]
      : undefined);
  return param?.types;
}

function fieldItems(
  fields: readonly DataField[],
  query: string,
  types: readonly DataType[] | undefined,
): FormulaCompletion[] {
  const references = formulaReferences(fields);
  const needle = query.toLowerCase();
  return fields
    .filter(
      (field) =>
        field.name.toLowerCase().includes(needle) &&
        (!types || types.includes(field.type)),
    )
    .map((field) => ({
      kind: "field" as const,
      label: field.name,
      insert: formatDataFormula(
        { kind: "field", fieldId: field.id },
        references,
      ),
      fieldId: field.id,
      type: field.type,
    }));
}

function wordItems(prefix: string): FormulaCompletion[] {
  return [
    ...functionNames
      .filter((name) => name.startsWith(prefix))
      .map((name) => ({
        kind: "function" as const,
        label: name,
        insert: name + "(",
      })),
    ...keywords
      .filter((name) => name.startsWith(prefix))
      .map((name) => ({
        kind: operatorWords.has(name)
          ? ("operator" as const)
          : ("keyword" as const),
        label: name,
        insert: name,
      })),
  ];
}

/**
 * Where the name being edited ends: just past its closing `]` when the rest
 * of the name after the cursor reaches one, else the cursor. A `[` or a line
 * break first means the reference is unclosed and what follows is other
 * text, which must be kept.
 */
function referenceEnd(text: string, cursor: number): number {
  for (let j = cursor; j < text.length; j++) {
    const char = text[j];
    if (char === "[" || char === "\n" || char === "\r") return cursor;
    if (char === "]") {
      if (text[j + 1] === "]") {
        j++;
        continue;
      }
      return j + 1;
    }
  }
  return cursor;
}

/** Suggestions for the token at the cursor. Never throws. */
export function formulaCompletions(
  text: string,
  cursor: number,
  fields: readonly DataField[],
): FormulaCompletionResult {
  const at = Math.max(0, Math.min(cursor, text.length));
  const none = { from: at, to: at, items: [] };
  const { calls, at: state } = scan(text, at);
  switch (state.kind) {
    case "reference":
      return {
        from: state.start,
        to: referenceEnd(text, at),
        items: fieldItems(
          fields,
          state.name,
          argumentTypes(calls, state.argumentStart),
        ),
      };
    case "word": {
      const rest = /^[a-z_0-9]*/i.exec(text.slice(at))![0];
      return {
        from: state.start,
        to: at + rest.length,
        items: wordItems(state.text),
      };
    }
    case "operand":
      return state.space
        ? {
            from: at,
            to: at,
            items: operatorLabels.map((label) => ({
              kind: "operator" as const,
              label,
              insert: label + " ",
            })),
          }
        : none;
    case "expect":
      return {
        from: at,
        to: at,
        items: [
          ...fieldItems(
            fields,
            "",
            argumentTypes(calls, !calls[calls.length - 1]?.started),
          ),
          ...wordItems(""),
        ],
      };
    default:
      return none;
  }
}

/** The innermost function call open at the cursor and the argument in it. */
export function formulaArgumentHint(
  text: string,
  cursor: number,
): { fn: string; argument: number; signature: DataFunctionSignature } | null {
  const { calls, at } = scan(text, cursor);
  if (at.kind === "string") return null;
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i]!;
    if (!call.fn) continue;
    const signature = signatureOf(call.fn);
    return signature
      ? { fn: call.fn, argument: call.argument, signature }
      : null;
  }
  return null;
}

/** The text with the item in place of the token, and the cursor after it. */
export function applyFormulaCompletion(
  text: string,
  result: FormulaCompletionResult,
  item: FormulaCompletion,
): { text: string; cursor: number } {
  const after = text.slice(result.to);
  // An existing "(" after a function name is kept rather than repeated.
  const insert =
    item.kind === "function" && after.startsWith("(")
      ? item.insert.slice(0, -1)
      : item.insert;
  const cursor = result.from + insert.length + (insert === item.insert ? 0 : 1);
  return { text: text.slice(0, result.from) + insert + after, cursor };
}
