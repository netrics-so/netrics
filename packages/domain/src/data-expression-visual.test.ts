import { describe, expect, it } from "vitest";
import {
  DataProcessingError,
  type DataExpression,
  type DataFunction,
  type DataType,
} from "./data-expression.js";
import {
  canonicalJson,
  emptyVisualModel,
  fromVisual,
  sameDataExpression,
  toVisual,
  visualModelComplete,
  type VisualCondition,
  type VisualModel,
} from "./data-expression-visual.js";
import {
  mulberry32,
  randomDataExpression,
  randomVisualModel,
} from "./test-helpers.js";

const field = (fieldId: string): DataExpression => ({ kind: "field", fieldId });
const lit = (type: DataType, value: unknown): DataExpression => ({
  kind: "literal",
  type,
  value,
});
const call = (fn: DataFunction, ...args: DataExpression[]): DataExpression => ({
  kind: "call",
  fn,
  args,
});
const cmp1 = call("eq", field("a"), lit("string", "x"));
const cmp2 = call("gt", field("amount"), lit("decimal", "1.50"));
const cmp3 = call("is_null", field("b"));
const cmp4 = call("lte", field("day"), field("c"));

function uses(e: DataExpression, fns: readonly string[]): boolean {
  return (
    e.kind === "call" &&
    (fns.includes(e.fn) || e.args.some((arg) => uses(arg, fns)))
  );
}
function conditionOf(model: VisualModel): VisualCondition | null {
  if (model.kind === "condition") return model;
  return model.kind === "if" || model.kind === "boolean"
    ? model.condition
    : null;
}
/** Each row of the model's condition as its own expression, in item order. */
function modelRows(model: VisualModel): string[] {
  const condition = conditionOf(model);
  if (!condition) return [];
  return condition.items
    .flatMap((item) => (item.kind === "group" ? item.rows : [item]))
    .map((row) =>
      JSON.stringify(
        fromVisual({ kind: "condition", join: "and", items: [row] }),
      ),
    );
}
/** The comparison leaves of the expression's condition, left to right. */
function expressionRows(e: DataExpression, model: VisualModel): string[] {
  if (!conditionOf(model)) return [];
  const root = model.kind === "if" && e.kind === "call" ? e.args[0]! : e;
  const leaves = (node: DataExpression): string[] =>
    node.kind === "call" && (node.fn === "and" || node.fn === "or")
      ? node.args.flatMap(leaves)
      : [JSON.stringify(node)];
  return leaves(root);
}

const SEEDS = [1, 2, 3, 4, 5],
  DRAWS = 2000,
  ids = ["a", "b", "c", "amount", "day"];

describe("visual expression model", () => {
  it("fromVisual(toVisual(e)) equals e for every representable generated expression", () => {
    for (const seed of SEEDS) {
      let joins = 0,
        rounds = 0;
      for (const target of ["condition", "calculation"] as const) {
        const random = mulberry32(seed);
        let representable = 0,
          generatedRepresentable = 0;
        for (let i = 0; i < DRAWS; i++) {
          const e =
            i % 2
              ? randomDataExpression(random, ids, 4)
              : fromVisual(randomVisualModel(random, ids, target));
          const r = toVisual(e, target);
          if (!r.representable) continue;
          representable++;
          if (i % 2) {
            generatedRepresentable++;
            if (uses(e, ["and", "or"])) joins++;
            if (uses(e, ["round"])) rounds++;
          }
          const message = `seed ${seed} #${i}: ${JSON.stringify(e)}`;
          expect(sameDataExpression(fromVisual(r.model), e), message).toBe(
            true,
          );
          expect(JSON.stringify(fromVisual(r.model))).toBe(JSON.stringify(e));
          // Independent of fromVisual: the model's rows follow the
          // expression's left-to-right order.
          expect(modelRows(r.model), message).toEqual(
            expressionRows(e, r.model),
          );
        }
        expect(representable).toBeGreaterThan(DRAWS * 0.4); // not vacuous
        // Random (not model-built) expressions also hit the subset.
        expect(generatedRepresentable).toBeGreaterThan(DRAWS * 0.02);
      }
      expect(joins, `seed ${seed} joins`).toBeGreaterThan(0);
      expect(rounds, `seed ${seed} rounds`).toBeGreaterThan(0);
    }
  });

  it("every generated visual model survives fromVisual → toVisual → fromVisual", () => {
    for (const seed of SEEDS)
      for (const target of ["condition", "calculation"] as const) {
        const random = mulberry32(seed);
        for (let i = 0; i < DRAWS; i++) {
          const model = randomVisualModel(random, ids, target);
          expect(visualModelComplete(model)).toBe(true);
          const e = fromVisual(model);
          const r = toVisual(e, target);
          expect(r.representable, `seed ${seed} #${i}`).toBe(true);
          if (!r.representable) continue;
          expect(JSON.stringify(fromVisual(r.model))).toBe(JSON.stringify(e));
        }
      }
  });

  it("reads right-nested and/or as a row plus a group", () => {
    const e = call("and", cmp1, call("and", cmp2, cmp3));
    const r = toVisual(e, "condition");
    expect(r).toEqual({
      representable: true,
      model: {
        kind: "condition",
        join: "and",
        items: [
          {
            kind: "comparison",
            fieldId: "a",
            operator: "eq",
            negated: false,
            right: { kind: "literal", literal: lit("string", "x") },
          },
          {
            kind: "group",
            join: "and",
            rows: [
              {
                kind: "comparison",
                fieldId: "amount",
                operator: "gt",
                negated: false,
                right: { kind: "literal", literal: lit("decimal", "1.50") },
              },
              {
                kind: "comparison",
                fieldId: "b",
                operator: "is_null",
                negated: false,
              },
            ],
          },
        ],
      },
    });
    if (r.representable) expect(fromVisual(r.model)).toEqual(e);
  });

  it("flattens the left spine and keeps a mixed join as a group", () => {
    const e = call("or", call("or", cmp1, call("and", cmp2, cmp4)), cmp3);
    const r = toVisual(e, "condition");
    expect(r.representable).toBe(true);
    if (!r.representable || r.model.kind !== "condition") return;
    expect(r.model.join).toBe("or");
    expect(r.model.items.map((item) => item.kind)).toEqual([
      "comparison",
      "group",
      "comparison",
    ]);
    expect(fromVisual(r.model)).toEqual(e);
  });

  it("reads negation, in-lists, wraps and if", () => {
    const negated = call("not", call("in", field("a"), lit("json", ["x", 1])));
    const r = toVisual(negated, "condition");
    expect(r).toMatchObject({
      representable: true,
      model: { items: [{ operator: "in", negated: true }] },
    });
    const calc = call(
      "round",
      call("divide", field("amount"), lit("integer", 2)),
      lit("integer", 1),
    );
    expect(toVisual(calc, "calculation")).toMatchObject({
      representable: true,
      model: {
        kind: "value",
        wrap: { fn: "round", digits: 1 },
        value: { kind: "arithmetic", operator: "divide" },
      },
    });
    const branch = call("if", cmp1, field("amount"), lit("integer", 0));
    expect(toVisual(branch, "calculation")).toMatchObject({
      representable: true,
      model: { kind: "if" },
    });
    expect(toVisual(cmp1, "calculation")).toMatchObject({
      representable: true,
      model: { kind: "boolean" },
    });
    expect(toVisual(field("amount"), "condition")).toEqual({
      representable: false,
      reason: "function",
    });
  });

  it.each([
    [
      "condition",
      call("and", cmp1, call("or", cmp2, call("and", cmp3, cmp4))),
      "nesting",
    ],
    ["condition", call("eq", lit("string", "x"), field("a")), "operand"],
    ["condition", call("not", call("and", cmp1, cmp2)), "negation"],
    ["condition", call("eq", field("a"), lit("json", null)), "literal"],
    [
      "calculation",
      call("coalesce", field("a"), field("b"), field("c")),
      "arity",
    ],
    ["calculation", call("concat", field("a"), field("b")), "function"],
    ["calculation", call("round", field("a"), field("b")), "operand"],
  ] as const)("%s %j is not representable: %s", (target, e, reason) =>
    expect(toVisual(e, target)).toEqual({ representable: false, reason }),
  );

  it("fromVisual refuses an incomplete model with builder_incomplete", () => {
    for (const target of ["condition", "calculation"] as const) {
      const model = emptyVisualModel(target);
      expect(visualModelComplete(model)).toBe(false);
      let error: unknown;
      try {
        fromVisual(model);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(DataProcessingError);
      expect((error as DataProcessingError).code).toBe("builder_incomplete");
    }
    const missingValue: VisualModel = {
      kind: "condition",
      join: "and",
      items: [
        { kind: "comparison", fieldId: "a", operator: "eq", negated: false },
      ],
    };
    expect(() => fromVisual(missingValue)).toThrow("builder_incomplete");
  });

  it("compares expressions structurally, not by key order or absent keys", () => {
    expect(
      sameDataExpression(
        { kind: "literal", type: "json", value: { a: 1, b: [2] } },
        { kind: "literal", type: "json", value: { b: [2], a: 1 } },
      ),
    ).toBe(true);
    expect(
      sameDataExpression(
        { kind: "literal", type: "integer", value: 1, unit: undefined },
        { kind: "literal", type: "integer", value: 1 },
      ),
    ).toBe(true);
    expect(sameDataExpression(lit("integer", 2), lit("number", 2))).toBe(false);
    expect(sameDataExpression(cmp1, call("eq", field("a")))).toBe(false);
  });
});

describe("canonicalJson", () => {
  it("ignores key order and undefined keys", () => {
    expect(
      canonicalJson({ id: "a", input: "s", type: "select", x: undefined }),
    ).toBe(canonicalJson({ type: "select", id: "a", input: "s" }));
    expect(canonicalJson([{ b: 1, a: [2, { d: 3, c: 4 }] }])).toBe(
      '[{"a":[2,{"c":4,"d":3}],"b":1}]',
    );
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: "1" }));
  });
});
