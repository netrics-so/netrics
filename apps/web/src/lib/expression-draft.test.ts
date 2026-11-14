import { describe, expect, it } from "vitest";
import {
  DataProcessingError,
  sameDataExpression,
  type DataExpression,
  type DataField,
} from "@netrics/domain";
import {
  initialExpressionDraft,
  resolveExpressionDraft,
  switchExpressionView,
  type ExpressionDraft,
} from "./expression-draft";

const fields: DataField[] = [
  { id: "country", name: "Country", type: "string", nullable: true },
  { id: "amount", name: "Amount", type: "decimal", nullable: true },
  { id: "day", name: "Day", type: "date", nullable: true },
];
const field = (fieldId: string): DataExpression => ({ kind: "field", fieldId });
const call = (
  fn: Extract<DataExpression, { kind: "call" }>["fn"],
  ...args: DataExpression[]
): DataExpression => ({ kind: "call", fn, args });
const filter = call(
  "and",
  call("gte", field("day"), {
    kind: "literal",
    type: "date",
    value: "2026-01-31",
  }),
  call("gt", field("amount"), {
    kind: "literal",
    type: "decimal",
    value: "-1.50",
  }),
);

describe("expression draft", () => {
  it("returns the stored expression object when nothing was edited", () => {
    const draft = initialExpressionDraft(filter, "condition", fields);
    expect(draft).toMatchObject({ view: "visual", edited: false });
    expect(resolveExpressionDraft(draft, filter, "condition", fields)).toBe(
      filter,
    );
    expect(resolveExpressionDraft(undefined, filter, "condition", fields)).toBe(
      filter,
    );
  });

  it("keeps an unedited expression with a missing field", () => {
    const stored = call("eq", field("gone"), {
      kind: "literal",
      type: "string",
      value: "x",
    });
    const draft = initialExpressionDraft(stored, "condition", fields);
    expect(draft.view).toBe("visual");
    expect(resolveExpressionDraft(draft, stored, "condition", fields)).toBe(
      stored,
    );
    const formula = switchExpressionView(draft, "condition", fields);
    const back = switchExpressionView(formula, "condition", fields);
    expect(resolveExpressionDraft(back, stored, "condition", fields)).toBe(
      stored,
    );
  });

  it("switching views without edits keeps the model", () => {
    const draft = initialExpressionDraft(filter, "condition", fields);
    const formula = switchExpressionView(draft, "condition", fields);
    expect(formula).toMatchObject({ view: "formula", edited: false });
    if (formula.view !== "formula") throw new Error("formula view");
    expect(formula.text).toContain('DATE("2026-01-31")');
    const back = switchExpressionView(formula, "condition", fields);
    expect(back).toEqual(draft);
    // Also when edited: the model, not the reparsed text, comes back.
    const edited = { ...back, edited: true } as ExpressionDraft;
    const again = switchExpressionView(
      switchExpressionView(edited, "condition", fields),
      "condition",
      fields,
    );
    expect(again).toEqual(edited);
    // Equal to the stored expression: the stored object comes back.
    expect(resolveExpressionDraft(again, filter, "condition", fields)).toBe(
      filter,
    );
    const fresh = resolveExpressionDraft(again, undefined, "condition", fields);
    expect(sameDataExpression(fresh, filter)).toBe(true);
  });

  it("reads edited formula text and switches it to visual rows", () => {
    const draft = initialExpressionDraft(filter, "condition", fields);
    const formula = switchExpressionView(draft, "condition", fields);
    const typed: ExpressionDraft = {
      view: "formula",
      text: '[Country] = "DE"',
      edited: true,
    };
    expect(formula.view).toBe("formula");
    const visual = switchExpressionView(typed, "condition", fields);
    expect(visual).toMatchObject({ view: "visual", edited: true });
    expect(resolveExpressionDraft(typed, filter, "condition", fields)).toEqual(
      call("eq", field("country"), {
        kind: "literal",
        type: "string",
        value: "DE",
      }),
    );
  });

  it("stays in formula view with a reason for nesting", () => {
    const nested = call("eq", call("lower", field("country")), {
      kind: "literal",
      type: "string",
      value: "de",
    });
    const draft = initialExpressionDraft(nested, "condition", fields);
    expect(draft).toMatchObject({ view: "formula", edited: false });
    if (draft.view !== "formula") throw new Error("formula view");
    expect(draft.note).toBeDefined();
    const switched = switchExpressionView(draft, "condition", fields);
    expect(switched).toMatchObject({ view: "formula", note: draft.note });
    expect(resolveExpressionDraft(switched, nested, "condition", fields)).toBe(
      nested,
    );
  });

  it("returns the stored expression when formula text is typed back unchanged", () => {
    const stored = call("eq", field("country"), {
      kind: "literal",
      type: "json",
      value: null,
    });
    const draft = initialExpressionDraft(stored, "condition", fields);
    if (draft.view !== "formula") throw new Error("formula view");
    const retyped: ExpressionDraft = { ...draft, edited: true };
    expect(resolveExpressionDraft(retyped, stored, "condition", fields)).toBe(
      stored,
    );
  });

  it("refuses to switch an incomplete visual model", () => {
    const draft = initialExpressionDraft(undefined, "condition", fields);
    expect(draft).toMatchObject({ view: "visual", edited: true });
    expect(() => switchExpressionView(draft, "condition", fields)).toThrow(
      expect.objectContaining({ code: "builder_incomplete" }),
    );
    expect(() =>
      resolveExpressionDraft(undefined, undefined, "condition", fields),
    ).toThrow(DataProcessingError);
  });

  it("reports a type problem of an edited model at its field", () => {
    const draft: ExpressionDraft = {
      view: "visual",
      edited: true,
      model: {
        kind: "condition",
        join: "and",
        items: [
          {
            kind: "comparison",
            fieldId: "day",
            operator: "in",
            negated: false,
            right: {
              kind: "literal",
              literal: { kind: "literal", type: "json", value: ["nope"] },
            },
          },
        ],
      },
    };
    expect(() =>
      resolveExpressionDraft(draft, undefined, "condition", fields),
    ).toThrow(expect.objectContaining({ fieldId: "day" }));
  });

  it("returns the stored expression when edits are undone by hand", () => {
    const draft = initialExpressionDraft(filter, "condition", fields);
    if (draft.view !== "visual" || draft.model.kind !== "condition")
      throw new Error("visual condition");
    const model = draft.model;
    const row = model.items[0]!;
    if (row.kind !== "comparison") throw new Error("comparison");
    const withRow = (next: typeof row): ExpressionDraft => ({
      view: "visual",
      edited: true,
      model: { ...model, items: [next, ...model.items.slice(1)] },
    });
    // "Does not match" on and off again.
    const toggled = withRow({ ...row, negated: false });
    expect(resolveExpressionDraft(toggled, filter, "condition", fields)).toBe(
      filter,
    );
    // A value changed and typed back (a new, equal literal object).
    const retyped = withRow({
      ...row,
      right: {
        kind: "literal",
        literal: { kind: "literal", type: "date", value: "2026-01-31" },
      },
    });
    expect(resolveExpressionDraft(retyped, filter, "condition", fields)).toBe(
      filter,
    );
    const changed = withRow({
      ...row,
      right: {
        kind: "literal",
        literal: { kind: "literal", type: "date", value: "2026-02-01" },
      },
    });
    expect(
      resolveExpressionDraft(changed, filter, "condition", fields),
    ).not.toBe(filter);
  });
});
