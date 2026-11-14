/** Seeded generators for property tests (domain takes no dependencies). */
import {
  DATA_FUNCTIONS,
  type DataExpression,
  type DataType,
} from "./data-expression.js";
import {
  VISUAL_ARITHMETIC,
  VISUAL_COMPARISONS,
  type DataLiteral,
  type VisualCalculation,
  type VisualComparison,
  type VisualCondition,
  type VisualGroup,
  type VisualModel,
  type VisualOperand,
  type VisualTarget,
  type VisualValue,
  type VisualWrap,
} from "./data-expression-visual.js";

/** Small, fast, deterministic PRNG: the same seed yields the same sequence. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Random = () => number;
const pick = <T>(random: Random, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)]!;
const chance = (random: Random, p: number) => random() < p;
const integer = (random: Random, min: number, max: number) =>
  min + Math.floor(random() * (max - min + 1));

const STRINGS = [
  "",
  "DE",
  "a b",
  'quote " inside',
  "back\\slash",
  "[bracket]]",
  "ümlaut ß",
  "line\nbreak",
  "😀",
];
const INTEGERS = [0, 1, 2, 7, 42, -1, -5, -100, 9_007_199_254_740_991];
const NUMBERS = [0.5, 1.25, -2.5, 3, -7, 1e21, 1e-7, -1e-7, 123456.789, 2];
const DECIMALS = ["0", "2", "-2", "1.50", "-1.50", "0.1", "-0.0", "1234.5678"];
const DATES = ["2026-01-31", "2000-02-29", "1999-12-31"];
const TIMESTAMPS = [
  "2026-01-31T12:00:00Z",
  "2000-01-01T00:00:00.123Z",
  "2026-11-14T23:59:59.123456789Z",
];
const UNITS = ["currency", "kg", "count", "currency_minor"];
const CURRENCIES = ["EUR", "USD"];

function scalarLiteralValue(random: Random, type: DataType): unknown {
  switch (type) {
    case "string":
      return pick(random, STRINGS);
    case "boolean":
      return chance(random, 0.5);
    case "integer":
      return pick(random, INTEGERS);
    case "number":
      return pick(random, NUMBERS);
    case "decimal":
      return pick(random, DECIMALS);
    case "date":
      return pick(random, DATES);
    case "timestamp":
      return pick(random, TIMESTAMPS);
    case "json":
      return chance(random, 0.5) ? listValue(random) : { key: "v", n: [1, 2] };
  }
}

function listValue(random: Random): unknown[] {
  const kind = pick(random, [
    "string",
    "integer",
    "number",
    "boolean",
  ] as const);
  return Array.from({ length: integer(random, 0, 3) }, () =>
    scalarLiteralValue(random, kind),
  );
}

/** A literal; numeric literals sometimes carry a unit (and currency). */
function randomLiteral(
  random: Random,
  type: DataType,
  allowNull: boolean,
): DataLiteral {
  const literal: DataLiteral = {
    kind: "literal",
    type,
    value:
      allowNull && chance(random, 0.15)
        ? null
        : scalarLiteralValue(random, type),
  };
  if (["integer", "number", "decimal"].includes(type) && chance(random, 0.25)) {
    literal.unit = pick(random, UNITS);
    if (chance(random, 0.5)) literal.currency = pick(random, CURRENCIES);
  }
  return literal;
}

const VISUAL_LITERAL_TYPES = [
  "string",
  "boolean",
  "integer",
  "number",
  "decimal",
  "date",
  "timestamp",
] as const;

/** A comparison built straight as an expression (field on the left). */
function randomComparisonExpression(
  random: Random,
  fieldIds: readonly string[],
): DataExpression {
  const fn = pick(random, VISUAL_COMPARISONS);
  const left: DataExpression = {
    kind: "field",
    fieldId: pick(random, fieldIds),
  };
  if (fn === "is_null") return { kind: "call", fn, args: [left] };
  const right: DataExpression =
    fn === "in"
      ? { kind: "literal", type: "json", value: listValue(random) }
      : chance(random, 0.5)
        ? { kind: "field", fieldId: pick(random, fieldIds) }
        : randomLiteral(random, pick(random, VISUAL_LITERAL_TYPES), false);
  const comparison: DataExpression = { kind: "call", fn, args: [left, right] };
  return chance(random, 0.2)
    ? { kind: "call", fn: "not", args: [comparison] }
    : comparison;
}

/**
 * An and/or tree built independently of the visual model: each argument is a
 * comparison or, up to `levels` deep, another join (left and right nesting).
 */
function randomJoin(
  random: Random,
  fieldIds: readonly string[],
  fn: "and" | "or",
  levels: number,
): DataExpression {
  const argument = (): DataExpression =>
    levels > 0 && chance(random, 0.4)
      ? randomJoin(
          random,
          fieldIds,
          pick(random, ["and", "or"] as const),
          levels - 1,
        )
      : randomComparisonExpression(random, fieldIds);
  return { kind: "call", fn, args: [argument(), argument()] };
}

/** Any expression shape: every function, 0–3 args, every literal type incl. null. */
export function randomDataExpression(
  random: Random,
  fieldIds: readonly string[],
  depth: number,
): DataExpression {
  const roll = random();
  if (depth <= 0 || roll < 0.25) {
    if (chance(random, 0.5))
      return { kind: "field", fieldId: pick(random, fieldIds) };
    const type = pick(random, [...VISUAL_LITERAL_TYPES, "json"] as const);
    if (type === "json")
      return {
        kind: "literal",
        type,
        value: chance(random, 0.2) ? null : scalarLiteralValue(random, type),
      };
    return randomLiteral(random, type, true);
  }
  // Half of the calls are drawn from the visual subset with a fitting arity,
  // so random expressions are representable often enough to test something.
  if (chance(random, 0.5)) {
    const fn = pick(random, [
      ...VISUAL_COMPARISONS,
      ...VISUAL_ARITHMETIC,
      "and",
      "or",
      "not",
      "if",
      "round",
      "abs",
      "coalesce",
    ] as const);
    const arity =
      fn === "is_null" || fn === "not" || fn === "abs"
        ? 1
        : fn === "if"
          ? 3
          : 2;
    if ((fn === "and" || fn === "or") && chance(random, 0.5))
      return randomJoin(random, fieldIds, fn, 1);
    if (fn === "round" && chance(random, 0.7)) {
      const digits: DataLiteral = {
        kind: "literal",
        type: "integer",
        value: integer(random, 0, 4),
      };
      if (chance(random, 0.2)) digits.unit = pick(random, UNITS);
      return {
        kind: "call",
        fn,
        args: [
          chance(random, 0.5)
            ? { kind: "field", fieldId: pick(random, fieldIds) }
            : randomDataExpression(random, fieldIds, depth - 1),
          digits,
        ],
      };
    }
    const args = Array.from({ length: arity }, (_v, index) =>
      index === 0 && (VISUAL_COMPARISONS as readonly string[]).includes(fn)
        ? { kind: "field" as const, fieldId: pick(random, fieldIds) }
        : randomDataExpression(random, fieldIds, depth - 1),
    );
    return { kind: "call", fn, args };
  }
  return {
    kind: "call",
    fn: pick(random, DATA_FUNCTIONS),
    args: Array.from({ length: integer(random, 0, 3) }, () =>
      randomDataExpression(random, fieldIds, depth - 1),
    ),
  };
}

function randomOperand(
  random: Random,
  fieldIds: readonly string[],
): VisualOperand {
  return chance(random, 0.5)
    ? { kind: "field", fieldId: pick(random, fieldIds) }
    : {
        kind: "literal",
        literal: randomLiteral(
          random,
          pick(random, VISUAL_LITERAL_TYPES),
          false,
        ),
      };
}

function randomComparison(
  random: Random,
  fieldIds: readonly string[],
): VisualComparison {
  const operator = pick(random, VISUAL_COMPARISONS);
  const row: VisualComparison = {
    kind: "comparison",
    fieldId: pick(random, fieldIds),
    operator,
    negated: chance(random, 0.25),
  };
  if (operator === "is_null") return row;
  row.right =
    operator === "in"
      ? chance(random, 0.85)
        ? {
            kind: "literal",
            literal: {
              kind: "literal",
              type: "json",
              value: listValue(random),
            },
          }
        : { kind: "field", fieldId: pick(random, fieldIds) }
      : randomOperand(random, fieldIds);
  return row;
}

function randomCondition(
  random: Random,
  fieldIds: readonly string[],
): VisualCondition {
  const join = pick(random, ["and", "or"] as const);
  const items: Array<VisualComparison | VisualGroup> = Array.from(
    { length: integer(random, 1, 4) },
    () =>
      chance(random, 0.25)
        ? {
            kind: "group",
            // A group has the other join; a same-join group normalizes into the
            // top level when it comes first (the expression still round-trips).
            join: chance(random, 0.8) ? (join === "and" ? "or" : "and") : join,
            rows: Array.from({ length: integer(random, 1, 3) }, () =>
              randomComparison(random, fieldIds),
            ),
          }
        : randomComparison(random, fieldIds),
  );
  return { kind: "condition", join, items };
}

function randomValue(random: Random, fieldIds: readonly string[]): VisualValue {
  return chance(random, 0.5)
    ? {
        kind: "arithmetic",
        operator: pick(random, VISUAL_ARITHMETIC),
        left: randomOperand(random, fieldIds),
        right: randomOperand(random, fieldIds),
      }
    : randomOperand(random, fieldIds);
}

function randomWrap(
  random: Random,
  fieldIds: readonly string[],
): VisualWrap | undefined {
  switch (integer(random, 0, 3)) {
    case 0:
      return { fn: "round", digits: integer(random, 0, 4) };
    case 1:
      return { fn: "abs" };
    case 2:
      return { fn: "coalesce", fallback: randomOperand(random, fieldIds) };
    default:
      return undefined;
  }
}

/** Complete visual models only, covering every operator, wrap and shape. */
export function randomVisualModel(
  random: Random,
  fieldIds: readonly string[],
  target: VisualTarget,
): VisualModel {
  if (target === "condition") return randomCondition(random, fieldIds);
  const shape = integer(random, 0, 2);
  if (shape === 0) {
    const wrap = randomWrap(random, fieldIds);
    const model: VisualCalculation = {
      kind: "value",
      value: randomValue(random, fieldIds),
    };
    return wrap ? { ...model, wrap } : model;
  }
  if (shape === 1)
    return {
      kind: "if",
      condition: randomCondition(random, fieldIds),
      then: randomValue(random, fieldIds),
      else: randomValue(random, fieldIds),
    };
  return { kind: "boolean", condition: randomCondition(random, fieldIds) };
}
