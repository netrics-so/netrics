# M11 Visual Builder (11C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Customers build common filters and calculations visually (preparation filter/calculate steps, model measure filters and calculated measures), with formula completion, while the visual view and the formula always describe the same stored `DataExpression`; an end-to-end browser test proves the 11C journey in English and German.

**Architecture:** Pure logic lives in `packages/domain`: a visual model with `toVisual` / `fromVisual` over the existing `DataExpression` AST (no second stored representation), type-aware choices computed by trial compilation with `compileRowExpression` (the engine's type checker), a literal-exact formula printer, and formula completion. `apps/web` adds a controlled `ExpressionEditor` (visual ⇄ formula) whose draft state is resolved by a pure helper that returns the stored expression untouched when nothing was edited. A new Playwright suite (`e2e/`) drives the real web app and API against Postgres in a new CI job.

**Tech Stack:** TypeScript 6, React 19 / Next.js 16 (`apps/web`), vitest 5 (static-markup component tests via `renderI18n`), new: `@playwright/test` (root devDependency, exact pin).

**Spec:** `docs/milestones/11-completion-design.md` (sections "Visual builder (11C)", Goal 1, Goal 6 journey test, Anti-goals). Background: `docs/milestones/11-projects-and-derived-metrics.md` (11C gate, #442).

**Execution:** subagent-driven; one GitHub issue and one PR per task group (G1–G4), each PR body `Closes #N` and referencing gate #442.

## Global Constraints

- One shared expression AST: `DataExpression` in `packages/domain/src/data-expression.ts` (field / literal / call over `DATA_FUNCTIONS`). No second representation is stored; the visual model is UI state only.
- Visual subset (verbatim from spec): conditions compare a field with a literal or another field via `eq ne lt lte gt gte in contains starts_with is_null` (and their negation through `not`), combined by one level of `and` / `or`; one level of grouping is allowed. Calculations: two operands (field or literal) with `add subtract multiply divide`, optionally wrapped in `round` / `abs` / `coalesce`, and `if(condition, a, b)` where the condition is a visual condition.
- Invariant: for every representable `expr`, `fromVisual(toVisual(expr))` is structurally equal to `expr`; opening and saving without edits never changes the stored definition.
- The engine's type checker (`compileRowExpression`) decides which fields and operators are offered, not UI code.
- Packages depend inward only (`PACKAGE_LAYERS` in `eslint.config.mjs`): `packages/domain` imports nothing.
- Every UI string in `apps/web/src/messages/data/en.ts` and `de.ts` (`Catalog<typeof dataEn>`); German uses informal "du". No hard-coded UI text in `.tsx` (ADR 0016 lint rule).
- Pin dependencies exactly; avoid releases younger than a few days. Actions pinned by SHA.
- Existing draft → preview → publish flows and `data:*` capabilities are the only way definitions go live; the builder adds no endpoint.
- Definition of done per PR: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`; UI flows checked in a real browser.

## Review Focus

1. **A stored expression references a column that no longer exists upstream** (column removed or renamed in an earlier step): the builder shows the row with a "missing column" marker instead of dropping it, and saving without edits keeps the expression. Test: Task 5 `keeps an unedited expression with a missing field`, Task 6 `renders a missing column row`.
2. **German decimal entry and exact decimals**: "1,50" in German and "1.50" in English both store decimal text `"1.50"` (never a float, trailing zero kept). Test: Task 4 `parses German decimal commas exactly`.
3. **Timestamps entered in a browser that is not on UTC**: the value is read and written as UTC (`…Z`), so reopening shows the same wall-clock value and saving unchanged stores the same string. Test: Task 4 `timestamp input round-trips as UTC`.
4. **Switching to formula and back without typing, for literals the old printer could not round-trip** (dates, timestamps, negative numbers, `number` literals, decimals without a point, `in` lists): the definition does not change. Test: Task 2 property `formula text round-trips every visual expression`, Task 5 `switching views without edits keeps the model`.
5. **Changing the column of a row to one of another type** (e.g. text → date): operator and value are kept only when the checker still accepts them, otherwise reset; no invalid combination reaches save. Test: Task 3 `reconcileComparison drops a value the new field cannot take`.

---

## File Structure

| File                                                         | Responsibility                                                                         |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `packages/domain/src/data-expression-visual.ts` (new)        | Visual model types, `toVisual`, `fromVisual`, `sameDataExpression`, completeness       |
| `packages/domain/src/data-expression-choices.ts` (new)       | Type-aware operator/field/literal choices by trial compilation                         |
| `packages/domain/src/data-formula.ts` (modify)               | Literal forms `DATE/TIMESTAMP/NUMBER/DECIMAL/JSON`, negative literal folding           |
| `packages/domain/src/data-formula-completion.ts` (new, G3)   | Function signatures, completions, argument hints                                       |
| `packages/domain/src/data-model.ts` (modify, G3)             | `formulaMeasureFields` (typed measure "fields" for calculated measures)                |
| `packages/domain/src/test-helpers.ts` (new)                  | Seeded PRNG and expression/model generators (excluded from the published `dist` files) |
| `apps/web/src/lib/literal-input.ts` (new)                    | Typed literal text ⇄ `DataExpression` literal                                          |
| `apps/web/src/lib/expression-draft.ts` (new)                 | Editor draft state: init, view switch, resolve (open+save identity)                    |
| `apps/web/src/components/data/expression-editor.tsx` (new)   | Visual/formula toggle; composes the builders and `FormulaInput`                        |
| `apps/web/src/components/data/condition-builder.tsx` (new)   | Rows, "all of"/"any of", one group level                                               |
| `apps/web/src/components/data/calculation-builder.tsx` (new) | Value / arithmetic / wrap / if / boolean                                               |
| `apps/web/src/components/data/literal-field.tsx` (new)       | Typed literal inputs (date, datetime, decimal + currency, boolean switch, list)        |
| `apps/web/src/components/data/formula-input.tsx` (new)       | Formula textarea; G3 adds completion listbox and argument hint                         |
| `apps/web/src/components/data/step-form.tsx` (modify)        | Uses `ExpressionEditor` for filter/calculate                                           |
| `apps/web/src/components/data/model-editor.tsx` (modify, G3) | Calculated measures and new measure filters use `ExpressionEditor`                     |
| `apps/web/src/lib/data-errors.ts` (modify)                   | Map `builder_incomplete`                                                               |
| `apps/web/src/messages/data/{en,de}.ts` (modify)             | `data.builder.*`, `data.completion.*`, `data.errors.builderIncomplete`                 |
| `apps/web/src/app/styles/data.css` (modify)                  | Builder layout using existing tokens                                                   |
| `playwright.config.ts`, `e2e/**` (new, G4)                   | Journey test harness and spec                                                          |
| `.github/workflows/ci.yml` (modify, G4)                      | `e2e` job                                                                              |

---

## Group G1 — Domain: visual model and round-trip

**Issue title:** "11C: visual expression model with round-trip guarantee (domain)". **Depends on:** nothing. **Tasks:** 1–3.

### Task 1: Visual model, `toVisual` / `fromVisual`, property tests

**Files:**

- Create: `packages/domain/src/data-expression-visual.ts`
- Create: `packages/domain/src/test-helpers.ts`
- Create: `packages/domain/src/data-expression-visual.test.ts`
- Modify: `packages/domain/src/index.ts` (export `./data-expression-visual.js`; do **not** export `test-helpers`)

**Interfaces:**

- Consumes: `DataExpression`, `DataFunction`, `dataFail` from `data-expression.ts`.
- Produces (exact):

```ts
export type DataLiteral = Extract<DataExpression, { kind: "literal" }>;
export type VisualOperand =
  | { kind: "field"; fieldId: string } // "" = not chosen yet
  | { kind: "literal"; literal: DataLiteral };
export const VISUAL_COMPARISONS = [
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "contains",
  "starts_with",
  "is_null",
] as const;
export type VisualComparisonOperator = (typeof VISUAL_COMPARISONS)[number];
export interface VisualComparison {
  kind: "comparison";
  fieldId: string; // "" = not chosen yet
  operator: VisualComparisonOperator;
  negated: boolean; // wrapped in not(...)
  right?: VisualOperand; // absent only for is_null (or while incomplete)
}
export interface VisualGroup {
  kind: "group";
  join: "and" | "or";
  rows: VisualComparison[];
}
export interface VisualCondition {
  kind: "condition";
  join: "and" | "or";
  items: Array<VisualComparison | VisualGroup>;
}
export const VISUAL_ARITHMETIC = [
  "add",
  "subtract",
  "multiply",
  "divide",
] as const;
export type VisualArithmeticOperator = (typeof VISUAL_ARITHMETIC)[number];
export type VisualValue =
  | VisualOperand
  | {
      kind: "arithmetic";
      operator: VisualArithmeticOperator;
      left: VisualOperand;
      right: VisualOperand;
    };
export type VisualWrap =
  | { fn: "round"; digits: number }
  | { fn: "abs" }
  | { fn: "coalesce"; fallback: VisualOperand };
export type VisualCalculation =
  | { kind: "value"; value: VisualValue; wrap?: VisualWrap }
  | {
      kind: "if";
      condition: VisualCondition;
      then: VisualValue;
      else: VisualValue;
    }
  | { kind: "boolean"; condition: VisualCondition };
export type VisualModel = VisualCondition | VisualCalculation;
export type VisualTarget = "condition" | "calculation";
export type NotVisualReason =
  "function" | "nesting" | "operand" | "literal" | "negation" | "arity";
export type ToVisualResult =
  | { representable: true; model: VisualModel }
  | { representable: false; reason: NotVisualReason };
export function toVisual(
  expression: DataExpression,
  target: VisualTarget,
): ToVisualResult;
export function fromVisual(model: VisualModel): DataExpression; // throws DataProcessingError("builder_incomplete")
export function visualModelComplete(model: VisualModel): boolean;
export function sameDataExpression(
  a: DataExpression,
  b: DataExpression,
): boolean;
export function emptyVisualModel(target: VisualTarget): VisualModel;
```

Mapping rules the implementer cannot infer:

- `and`/`or` are binary in the AST. `fromVisual` builds **left-nested** chains (`and(and(a,b),c)`), matching `parseDataFormula`'s left associativity. `toVisual` flattens the **left spine** of the top-level `and`/`or`; every right operand (and the leftmost leaf) becomes an item: a comparison becomes a row; an `and`/`or` call becomes a `VisualGroup` whose own left spine is flattened and whose leaves must all be comparisons (anything deeper → `"nesting"`). This keeps right-nested stored shapes (`and(a, and(b,c))`) exact: they read as a row plus a group.
- A single comparison (no `and`/`or`) is a condition with `join: "and"` and one item. `fromVisual` emits a one-row group as the bare row expression (models can normalize; expressions stay equal).
- A comparison is `call(op, [field, right])` with `args[0].kind === "field"`; `right` is a field or a literal. Literal or call on the left → `"operand"`. `is_null` has exactly one field argument. `not(comparison)` sets `negated: true`; `not` of anything else (group, `not`) → `"negation"`.
- Literals allowed in the subset: types `string boolean integer number decimal date timestamp` with non-null value (unit/currency kept verbatim); for `in`, the right operand must be a `json` literal whose value is an array of non-null strings/numbers/booleans. Anything else (null literal, other json) → `"literal"`.
- Calculation target: top `if` with arity 3 → `if` (condition via the condition rules, branches `VisualValue`); top `and`/`or`/comparison/`not` → `boolean`; top `round` (second arg an `integer` literal without unit) / `abs` (arity 1) / `coalesce` (arity exactly 2, fallback an operand) → `value` with `wrap`, the wrapped arg a `VisualValue`; `add|subtract|multiply|divide` with two operands → arithmetic value; a bare field or literal → operand value. Wrong arity → `"arity"`; any other function → `"function"`.
- Condition target accepts only condition shapes (anything else → `"function"`).
- `sameDataExpression`: same `kind`; field ids equal; literals equal in `type`, `unit`, `currency` (an absent key equals a key set to `undefined`) and in value by canonical JSON (sorted object keys); calls equal in `fn`, arity and each argument.
- `fromVisual` copies literal objects verbatim (never adds `undefined` keys), so the stored JSON is byte-identical after `JSON.stringify`.

- [ ] **Step 1: Write the seeded generators in `test-helpers.ts`**

`mulberry32(seed: number): () => number`; `randomDataExpression(random, fieldIds: readonly string[], depth: number): DataExpression` (any `DATA_FUNCTIONS` member with 0–3 args, all literal types incl. `null`, negative numbers, decimals with and without a point, json arrays and objects, unit/currency on numeric literals); `randomVisualModel(random, fieldIds, target: VisualTarget): VisualModel` (complete models only, covering every operator, negation, groups, wraps, `if`, `boolean`, `in` lists). Integers avoid `-0`; `number` literals include fractional and large values (e.g. `1e21`, `1e-7`).

- [ ] **Step 2: Write the failing tests in `data-expression-visual.test.ts`**

```ts
const SEEDS = [1, 2, 3, 4, 5], DRAWS = 2000, ids = ["a", "b", "c", "amount", "day"];
it("fromVisual(toVisual(e)) equals e for every representable generated expression", () => {
  for (const seed of SEEDS) for (const target of ["condition", "calculation"] as const) {
    const random = mulberry32(seed); let representable = 0;
    for (let i = 0; i < DRAWS; i++) {
      const e = i % 2 ? randomDataExpression(random, ids, 4) : fromVisual(randomVisualModel(random, ids, target));
      const r = toVisual(e, target);
      if (!r.representable) continue;
      representable++;
      expect(sameDataExpression(fromVisual(r.model), e), `seed ${seed} #${i}: ${JSON.stringify(e)}`).toBe(true);
      expect(JSON.stringify(fromVisual(r.model))).toBe(JSON.stringify(e));
    }
    expect(representable).toBeGreaterThan(DRAWS * 0.4); // not vacuous
  }
});
it("every generated visual model survives fromVisual → toVisual → fromVisual", ...);
it("reads right-nested and/or as a row plus a group", ...);   // and(a, and(b,c)) → items [row, group(and,[b,c])]
it.each([
  ["condition", call("and", cmp1, call("or", cmp2, call("and", cmp3, cmp4))), "nesting"],
  ["condition", call("eq", lit("string", "x"), field("a")), "operand"],
  ["condition", call("not", call("and", cmp1, cmp2)), "negation"],
  ["condition", call("eq", field("a"), lit("json", null)), "literal"],
  ["calculation", call("coalesce", field("a"), field("b"), field("c")), "arity"],
  ["calculation", call("concat", field("a"), field("b")), "function"],
  ["calculation", call("round", field("a"), field("b")), "operand"],
])("%s %j is not representable: %s", (target, e, reason) =>
  expect(toVisual(e, target)).toEqual({ representable: false, reason }));
it("fromVisual refuses an incomplete model with builder_incomplete", ...); // emptyVisualModel(...) throws DataProcessingError code "builder_incomplete"
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm exec vitest run packages/domain/src/data-expression-visual.test.ts`
Expected: FAIL (module `./data-expression-visual.js` not found).

- [ ] **Step 4: Implement `data-expression-visual.ts`** per the Interfaces block and mapping rules.

- [ ] **Step 5: Run to verify pass**

Run: `pnpm exec vitest run packages/domain/src/data-expression-visual.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit** — `feat(domain): visual expression model with round-trip property tests`

### Task 2: Formula text round-trips every visual expression

The current printer is lossy for the subset: `formatDataFormula` prints date/timestamp/json literals as `TO_DATE(...)`/`TO_JSON(...)` (they parse back as **calls**), a `number` literal `2` or a decimal `"2"` parses back as `integer`, and `-5` parses as `negate(5)`. Switching visual → formula → (edit elsewhere) → visual would then change or lose a definition (anti-goal). `TO_DATE(...)` parsing stays unchanged (window filters in `data-model-windows.ts` accept both forms).

**Files:**

- Modify: `packages/domain/src/data-formula.ts`
- Test: `packages/domain/src/data-formula.test.ts`

**Interfaces:**

- Consumes: `randomVisualModel`, `mulberry32` (Task 1), `fromVisual`, `sameDataExpression`.
- Produces: `export const FORMULA_LITERAL_FORMS = ["DATE", "TIMESTAMP", "NUMBER", "DECIMAL", "JSON"] as const;` (used by completion in Task 9). Parser and printer signatures unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
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
        expect(
          sameDataExpression(
            parseDataFormula(formatDataFormula(e, fields), fields),
            e,
          ),
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
    formatDataFormula({ kind: "literal", type: "decimal", value: "-1.50" }, []),
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
```

- [ ] **Step 2: Run to verify failure** — `pnpm exec vitest run packages/domain/src/data-formula.test.ts` → FAIL on the new tests.

- [ ] **Step 3: Implement in `data-formula.ts`**

Parser: a word in `FORMULA_LITERAL_FORMS` followed by `(` exactly one string token `)` yields a literal: `DATE`→`date`, `TIMESTAMP`→`timestamp`, `DECIMAL`→`decimal` (text as given), `NUMBER`→`number` (`Number(text)`), `JSON`→`json` (`JSON.parse(text)`); validate with `validateDataValue(type, value, false)`; any failure → `dataFail("formula_literal_invalid")`. Prefix `-` whose parsed operand is an `integer`/`number`/`decimal` literal without `unit` folds into a negative literal (decimal text gets/loses the leading `-`); otherwise `negate(...)` as today. `UNIT(...)` accepts the folded literal forms as its first argument. Printer (literal branch only): `date`/`timestamp`/`json` → the literal forms; `number` → `NUMBER("<String(value)>")`; `decimal` → plain text when it contains `.`, else `DECIMAL("<text>")`; others unchanged. Update existing assertions in `data-formula.test.ts` that expected `negate(literal)` from `-<number>` text.

- [ ] **Step 4: Run** `pnpm exec vitest run packages/domain/src/data-formula.test.ts packages/domain/src/data-model-windows.test.ts` → PASS.

- [ ] **Step 5: Commit** — `fix(domain): formula text round-trips typed literals`

### Task 3: Type-aware choices from the engine's checker

**Files:**

- Create: `packages/domain/src/data-expression-choices.ts`
- Test: `packages/domain/src/data-expression-choices.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**

- Consumes: `compileRowExpression`, `DataField`, `DataType`, `ExpressionType`, Task 1 types.
- Produces:

```ts
export function expressionResultType(
  expression: DataExpression,
  fields: readonly DataField[],
): ExpressionType | null; // null when the checker throws
export function comparisonOperators(
  field: DataField,
  fields: readonly DataField[],
): VisualComparisonOperator[];
export function comparisonRightFields(
  field: DataField,
  operator: VisualComparisonOperator,
  fields: readonly DataField[],
): DataField[];
export function comparisonLiteralType(
  field: DataField,
  operator: VisualComparisonOperator,
): DataType | null; // null for is_null; for "in" the element type
export function arithmeticOperators(
  left: VisualOperand,
  right: VisualOperand,
  fields: readonly DataField[],
): VisualArithmeticOperator[];
export function operandFields(
  other: VisualOperand | null,
  fields: readonly DataField[],
  role: "arithmetic" | "branch" | "fallback",
): DataField[];
export function reconcileComparison(
  row: VisualComparison,
  fields: readonly DataField[],
): VisualComparison;
export function visualProblem(
  model: VisualModel,
  fields: readonly DataField[],
  target: VisualTarget,
): { code: string; fieldId?: string } | null;
```

Every choice is decided by trial compilation: build the candidate expression and keep it iff `compileRowExpression(candidate, fields)` does not throw (and, for conditions, the result type is `boolean`). Sample right-hand literals for trials: string `""`, boolean `true`, integer `0`, number `0`, decimal `"0"`, date `"2000-01-01"`, timestamp `"2000-01-01T00:00:00Z"`; for `in`, `{ type: "json", value: [] }`; json fields get no sample (only `is_null`). `reconcileComparison` keeps `operator` if still offered (else first offered operator) and keeps `right` only if the full comparison still compiles. `visualProblem` returns `{ code: "builder_incomplete" }` for incomplete models, else the checker's `DataProcessingError` `code`/`fieldId`, else `expression_type_mismatch` when a condition target does not yield boolean.

- [ ] **Step 1: Write the failing tests**

```ts
const f = {
  text: { id: "country", name: "Country", type: "string", nullable: true },
  amount: {
    id: "amount",
    name: "Amount",
    type: "decimal",
    nullable: true,
    unit: "currency",
    currencyField: "cur",
  },
  day: { id: "day", name: "Day", type: "date", nullable: false },
  meta: { id: "meta", name: "Meta", type: "json", nullable: true },
};
it("offers text operators only for text", () => {
  expect(comparisonOperators(f.text, all)).toEqual([
    "eq",
    "ne",
    "lt",
    "lte",
    "gt",
    "gte",
    "in",
    "contains",
    "starts_with",
    "is_null",
  ]);
  expect(comparisonOperators(f.day, all)).not.toContain("contains");
  expect(comparisonOperators(f.meta, all)).toEqual(["is_null"]);
});
it("offers only same-unit fields to compare", () =>
  expect(
    comparisonRightFields(f.amount, "gt", all).map((x) => x.id),
  ).not.toContain("day"));
it("offers arithmetic the checker accepts", () =>
  expect(arithmeticOperators(field("day"), field("amount"), all)).toEqual([]));
it("reconcileComparison drops a value the new field cannot take", () => {
  const row = {
    kind: "comparison",
    fieldId: "day",
    operator: "contains",
    negated: false,
    right: { kind: "literal", literal: lit("string", "DE") },
  } as const;
  expect(reconcileComparison(row, all)).toEqual({
    ...row,
    operator: "eq",
    right: undefined,
  });
});
it("reports the checker's code and field", () =>
  expect(visualProblem(modelReferencing("gone"), all, "condition")).toEqual({
    code: "expression_field_not_found",
    fieldId: "gone",
  }));
```

- [ ] **Step 2: Run** `pnpm exec vitest run packages/domain/src/data-expression-choices.test.ts` → FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** → PASS; then `pnpm lint && pnpm typecheck`.
- [ ] **Step 5: Commit** — `feat(domain): type-aware builder choices from the expression checker`

---

## Group G2 — Visual builder in the preparation editor

**Issue title:** "11C: visual filter and calculate steps in the preparation editor". **Depends on:** G1. **Tasks:** 4–7.

Coexistence: the step-attributed-errors plan changes the step list in `preparation-editor.tsx` and may pass a step error into `StepForm`. This group touches only the filter/calculate branches of `step-form.tsx` (state init at lines ~96–100, submit at ~389–405, render at ~603–640) and exposes `problem` on `ExpressionEditor` so a step error with a `fieldId` can mark the matching rows.

### Task 4: Typed literal input conversion

**Files:**

- Create: `apps/web/src/lib/literal-input.ts`
- Test: `apps/web/src/lib/literal-input.test.ts`

**Interfaces:**

- Produces:

```ts
export function literalFromInput(
  type: DataType,
  text: string,
  locale: Locale,
  options?: { unit?: string; currency?: string },
): DataLiteral | null; // null = invalid/empty
export function literalInputText(literal: DataLiteral, locale: Locale): string;
export function listFromInput(
  type: DataType,
  items: readonly string[],
  locale: Locale,
): DataLiteral | null; // json array for "in"
```

Rules: decimal keeps the typed digits as text (German accepts `,` as the separator; thousands separators are rejected); integer via `Number.isSafeInteger`; number via `Number`, finite; date = `YYYY-MM-DD` from `<input type="date">`; timestamp: `<input type="datetime-local" step="1">` text is read **as UTC** and stored `YYYY-MM-DDTHH:MM:SSZ`; boolean `"true"|"false"`; every result passes `validateDataValue`. `literalInputText` is the exact inverse (German decimal shows `,`).

- [ ] **Step 1: Write failing tests**: `parses German decimal commas exactly` (`literalFromInput("decimal","1,50","de")` → value `"1.50"`; `"1.50","en"` → `"1.50"`; `"1.000,5","de"` → `null`); `timestamp input round-trips as UTC` (`"2026-03-29T02:30:00"` → `"2026-03-29T02:30:00Z"` and back, independent of `process.env.TZ`, run with `TZ=Europe/Berlin` set inside the test); `keeps currency on decimal literals` (`{unit:"currency",currency:"EUR"}` copied); `rejects invalid dates` (`"2026-02-30"` → `null`); `listFromInput` builds `{type:"json", value:["DE","AT"]}`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/src/lib/literal-input.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(web): typed literal input conversion`

### Task 5: Editor draft state (open+save identity, view switching)

**Files:**

- Create: `apps/web/src/lib/expression-draft.ts`
- Test: `apps/web/src/lib/expression-draft.test.ts`
- Modify: `apps/web/src/lib/data-errors.ts` (`if (code === "builder_incomplete") return "builderIncomplete";` placed before the `/formula|expression/` line)

**Interfaces:**

- Consumes: `toVisual`, `fromVisual`, `emptyVisualModel`, `visualProblem`, `parseDataFormula`, `formatDataFormula`.
- Produces:

```ts
export type ExpressionDraft =
  | { view: "visual"; model: VisualModel; edited: boolean }
  | {
      view: "formula";
      text: string;
      edited: boolean;
      note?: NotVisualReason;
      /** Set when switched from visual: unchanged text restores this model exactly. */
      origin?: { text: string; model: VisualModel };
    };
export function initialExpressionDraft(
  initial: DataExpression | undefined,
  target: VisualTarget,
  fields: readonly DataField[],
): ExpressionDraft;
export function switchExpressionView(
  draft: ExpressionDraft,
  target: VisualTarget,
  fields: readonly DataField[],
): ExpressionDraft; // throws DataProcessingError("builder_incomplete") from an incomplete visual model
export function resolveExpressionDraft(
  draft: ExpressionDraft | undefined,
  initial: DataExpression | undefined,
  target: VisualTarget,
  fields: readonly DataField[],
): DataExpression;
```

Rules: `initialExpressionDraft` → visual when `toVisual` is representable, else formula with `note: reason`; no `initial` → `emptyVisualModel(target)`, `edited: true`. `resolveExpressionDraft` returns `initial` **by reference** when `draft` is undefined or `!draft.edited`; otherwise visual → `fromVisual` after `visualProblem` is null (else throws `DataProcessingError(code, fieldId)`), formula → `parseDataFormula`. Formula → visual with text equal to `origin.text` restores `origin.model`; with other text, parse then `toVisual`; not representable → stay in formula with `note`. Switching never sets `edited`.

- [ ] **Step 1: Write failing tests**: `returns the stored expression object when nothing was edited` (`toBe(initial)`); `keeps an unedited expression with a missing field` (fields lack `"gone"`, still `toBe(initial)`); `switching views without edits keeps the model` (visual→formula→visual equals the original model and resolves to an expression `sameDataExpression` with the original, using a date literal and a negative decimal); `stays in formula view with a reason for nesting`; `refuses to switch an incomplete visual model` (throws `builder_incomplete`); `maps builder_incomplete to builderIncomplete` in `data-errors` test.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/src/lib/expression-draft.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(web): expression editor draft state`

### Task 6: Builder components and copy

**Files:**

- Create: `apps/web/src/components/data/expression-editor.tsx`, `condition-builder.tsx`, `calculation-builder.tsx`, `literal-field.tsx`, `formula-input.tsx`
- Modify: `apps/web/src/messages/data/en.ts`, `apps/web/src/messages/data/de.ts`, `apps/web/src/app/styles/data.css`
- Test: `apps/web/src/components/data/expression-editor.test.tsx`

**Interfaces:**

- Consumes: Tasks 3–5.
- Produces:

```tsx
export function ExpressionEditor(props: {
  label: string;
  target: VisualTarget;
  fields: readonly DataField[];
  noun?: "column" | "measure"; // wording of field pickers, default "column"
  initial: DataExpression | undefined;
  draft: ExpressionDraft | undefined; // undefined → initialExpressionDraft(initial, …) at render
  onDraftChange: (draft: ExpressionDraft) => void; // every edit sets edited: true
  problem?: { code: string; fieldId?: string }; // rows referencing fieldId get aria-invalid
}): JSX.Element;
export function FormulaInput(props: {
  id: string;
  value: string;
  fields: readonly DataField[];
  onChange: (text: string) => void;
  describedBy?: string;
}): JSX.Element;
```

Behaviour: a two-option view switch ("Visual" / "Formula", `role="radiogroup"`); a `note` renders the reason text above the formula. Condition rows are `role="group"` labelled "Condition {number}", each: field select (only fields with at least one offered operator), operator select (`comparisonOperators`, negated variants shown as "is not …" via the `negated` toggle checkbox "Does not match"), right side as "Value" (typed `LiteralField` of `comparisonLiteralType`) or "Another column" (`comparisonRightFields`); `in` shows a value list with "Add value". Field changes go through `reconcileComparison`. "All of" / "Any of" select for the top join; "Add condition", "Add group" (disabled inside a group), "Remove". Calculation: kind select (Value / If … then … otherwise / True when); value = operand, optional operator (`arithmeticOperators`) and second operand; wrap select (As is / Round / Absolute value / If empty, use) with digits input (integer 0–18) or fallback operand. Unknown field IDs render as "Missing column {id}" options so nothing is dropped. `visualProblem` is shown inline (`role="alert"`) through `t("errors."+dataErrorCodeKey(code))`. `FormulaInput` = the existing textarea, help text and "Insert a column" buttons moved from `step-form.tsx` (completion arrives in Task 10).

Copy (`data.builder.*`; en / de):

| key                                                               | en                                                                                                             | de                                                                                                                            |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `view` / `visual`                                                 | Edit as / Visual                                                                                               | Bearbeiten als / Visuell                                                                                                      |
| `all` / `any`                                                     | All of these are true / Any of these is true                                                                   | Alle treffen zu / Mindestens eine trifft zu                                                                                   |
| `condition` / `group`                                             | Condition {number} / Group {number}                                                                            | Bedingung {number} / Gruppe {number}                                                                                          |
| `addCondition` / `addGroup` / `remove`                            | Add condition / Add group / Remove                                                                             | Bedingung hinzufügen / Gruppe hinzufügen / Entfernen                                                                          |
| `column` / `measure` / `operator`                                 | Column / Measure / Comparison                                                                                  | Spalte / Kennzahl / Vergleich                                                                                                 |
| `value` / `otherColumn` / `addValue`                              | Value / Another column / Add value                                                                             | Wert / Andere Spalte / Wert hinzufügen                                                                                        |
| `negated`                                                         | Does not match                                                                                                 | Trifft nicht zu                                                                                                               |
| `operators.{eq,ne,lt,lte,gt,gte,in,contains,starts_with,is_null}` | is, is not, is less than, is at most, is greater than, is at least, is one of, contains, starts with, is empty | ist, ist nicht, ist kleiner als, ist höchstens, ist größer als, ist mindestens, ist eines von, enthält, beginnt mit, ist leer |
| `kinds.{value,if,boolean}`                                        | Value / If … then … otherwise / True when                                                                      | Wert / Wenn … dann … sonst / Wahr, wenn                                                                                       |
| `arithmetic.{add,subtract,multiply,divide}`                       | plus / minus / times / divided by                                                                              | plus / minus / mal / geteilt durch                                                                                            |
| `wrap.{none,round,abs,coalesce}` / `digits`                       | As is / Round / Absolute value / If empty, use / Decimal places                                                | Unverändert / Runden / Betrag / Wenn leer, verwende / Nachkommastellen                                                        |
| `then` / `else`                                                   | Then / Otherwise                                                                                               | Dann / Sonst                                                                                                                  |
| `true` / `false` / `currency` / `utc`                             | True / False / Currency / UTC                                                                                  | Wahr / Falsch / Währung / UTC                                                                                                 |
| `missing`                                                         | Missing column {id}                                                                                            | Fehlende Spalte {id}                                                                                                          |
| `invalidValue`                                                    | Enter a valid value ({type}).                                                                                  | Gib einen gültigen Wert ein ({type}).                                                                                         |
| `notVisual.{function,nesting,operand,literal,negation,arity}`     | one sentence each, ending "Edit it as a formula."                                                              | one sentence each, ending "Bearbeite sie als Formel."                                                                         |
| `errors.builderIncomplete` (in `data.errors`)                     | Complete every condition, or remove the empty ones.                                                            | Vervollständige jede Bedingung oder entferne die leeren.                                                                      |

- [ ] **Step 1: Write failing static-render tests** (`renderI18n`, en and de): `renders a stored condition as rows` (`and(eq(country,"DE"), gt(amount, 0))` shows two condition groups, the "is" and "is greater than" options selected); `offers only checker-approved operators` (a date row has no "contains" option); `renders a missing column row` (`Missing column gone` / `Fehlende Spalte gone`); `opens nesting in formula view with a note`; `renders German labels` (`Bedingung 1`, `Alle treffen zu`); `renders date and boolean literal inputs` (`type="date"`, `role="switch"`).
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/src/components/data/expression-editor.test.tsx` → FAIL.
- [ ] **Step 3: Implement components, catalogs and CSS** (existing classes `field`, `data-form-grid`, `data-form-actions`; new `.data-builder-row`, `.data-builder-group` in `data.css`).
- [ ] **Step 4: Run** the test file, then `pnpm lint && pnpm typecheck` → PASS (the i18n lint rule rejects hard-coded text).
- [ ] **Step 5: Commit** — `feat(web): visual condition and calculation builders`

### Task 7: Use the builder in filter and calculate steps

**Files:**

- Modify: `apps/web/src/components/data/step-form.tsx`
- Test: `apps/web/src/components/data/step-form.test.tsx` (create)

**Interfaces:**

- Consumes: `ExpressionEditor`, `resolveExpressionDraft`, `initialExpressionDraft`.
- Produces: `StepForm` props unchanged.

Replace `formula`/`initialFormula` state with `const [expressionDraft, setExpressionDraft] = useState<ExpressionDraft | undefined>()`; reset it to `undefined` when `operation` switches between `filter` and `calculate` on a new step; on submit `resolveExpressionDraft(expressionDraft, initial && "expression" in initial ? initial.expression : undefined, operation === "filter" ? "condition" : "calculation", fields)`; errors keep flowing through the existing `catch` → `t("errors."+dataErrorKey(e))`. Group-step aggregate filters stay formula text (out of the spec's "Where" list).

- [ ] **Step 1: Write failing tests**: `opens a filter step visually` (render with `initial` filter node → "Condition 1" present, no `<textarea`); `opens a calculate step with an if as rows`; `new calculate step starts with an empty visual value`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/src/components/data/step-form.test.tsx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file and `pnpm test` → PASS.
- [ ] **Step 5: Check in a real browser** (`pnpm dev`): build `[Country] = "DE"` as a calculate step and `Revenue > 0` as a filter, apply, reopen, apply unchanged; the draft's history shows no new change. Note the result in the PR.
- [ ] **Step 6: Commit** — `feat(web): visual filter and calculate steps`

---

## Group G3 — Model editor and formula completion

**Issue title:** "11C: visual measure filters and calculated measures; formula completion". **Depends on:** G1, G2. **Tasks:** 8–11.

Coexistence: the model-editor-undo plan snapshots editor state. This group replaces `formulaTexts` with one state object `expressionDrafts: Record<string, ExpressionDraft>` (keys `${measureId}:formula`, `${measureId}:filter`) holding **only edited drafts**, so it sits next to `definition` in one snapshot and an unedited editor stays clean. Whichever PR lands second rebases onto the other.

### Task 8: Typed measure fields for calculated measures

**Files:**

- Modify: `packages/domain/src/data-model.ts`
- Test: `packages/domain/src/data-model.test.ts`

**Interfaces:**

- Consumes: `measureTypeProbe`, `measureDependencies`.
- Produces: `export function formulaMeasureFields(model: SemanticModelDefinition, sources: ReadonlyMap<string, Pick<DataTable, "fields">>, measureId: string): DataField[];` — one `DataField` per measure other than `measureId` and its transitive dependents, typed as `evaluateFormula` types them (`nullable: true`, `unit`, `currencyField: <id>.currency` when the probe cell has a currency); measures whose probe throws are omitted. Extract the field construction from `evaluateFormula` into a private helper both use.

- [ ] **Step 1: Failing tests**: `types measures like evaluateFormula` (sum of decimal currency measure → `{type:"decimal", unit:"currency", currencyField:"revenue.currency"}`); `excludes the measure and its dependents`; `omits measures that fail to probe`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/domain/src/data-model.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(domain): typed measure fields for formula measures`

### Task 9: Formula completion and argument hints (domain)

**Files:**

- Create: `packages/domain/src/data-formula-completion.ts`
- Test: `packages/domain/src/data-formula-completion.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**

- Consumes: `DATA_FUNCTIONS`, `DATA_TYPES`, `FORMULA_LITERAL_FORMS`, `formatDataFormula`, `compileRowExpression`.
- Produces:

```ts
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
  rest?: boolean;
}
export const DATA_FUNCTION_SIGNATURES: Readonly<
  Record<DataFunction, DataFunctionSignature>
>;
export interface FormulaCompletion {
  kind: "function" | "field" | "operator" | "keyword";
  label: string;
  insert: string;
  fieldId?: string;
  type?: DataType;
}
export interface FormulaCompletionResult {
  from: number;
  to: number;
  items: FormulaCompletion[];
}
export function formulaCompletions(
  text: string,
  cursor: number,
  fields: readonly DataField[],
): FormulaCompletionResult;
export function formulaArgumentHint(
  text: string,
  cursor: number,
): { fn: string; argument: number; signature: DataFunctionSignature } | null;
export function applyFormulaCompletion(
  text: string,
  result: FormulaCompletionResult,
  item: FormulaCompletion,
): { text: string; cursor: number };
```

Rules: a tolerant backwards scan (never throws; skips string literals and `[...]` with `]]` escapes) finds the token at the cursor. Inside an unclosed `[` → field items by case-insensitive substring of the name, `insert` = `formatDataFormula({kind:"field",…}, fields)` (handles ambiguous names); a word prefix → functions (`DATA_FUNCTIONS` upper-cased, plus `ISBLANK`, `VALUE`, `UNIT` and `FORMULA_LITERAL_FORMS`, `insert` ends in `(`) and keywords `TRUE FALSE NULL AND OR NOT`; after a complete operand and whitespace → operators `= != < <= > >= + - * / AND OR`. Inside a function's argument with a known signature, field items are restricted to `signature.params[argument].types` (`rest` repeats the last param). `formulaArgumentHint` finds the innermost open call and the comma index at depth 0.

- [ ] **Step 1: Failing tests**: `signatures agree with the checker` — for every `DataFunction`, a call built from one sample argument per param type compiles with `compileRowExpression`, and replacing one typed param (types ≠ all) with a sample of a type outside its list throws; `completes field names inside brackets` (`"[Rev"` at end → `{from:0,to:4}` with `[Revenue]`); `completes functions from a prefix` (`"ROU"` → `ROUND(`); `offers operators after an operand`; `restricts fields to the argument's types` (`"YEAR(["` lists only date/timestamp fields); `hints the current argument` (`"ROUND([Revenue], "` → `{fn:"ROUND", argument:1}`); `never throws on unbalanced text` (seeded 2,000 random strings from the formula alphabet).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/domain/src/data-formula-completion.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(domain): formula completion and argument hints`

### Task 10: Completion in `FormulaInput`

**Files:**

- Modify: `apps/web/src/components/data/formula-input.tsx`, `apps/web/src/messages/data/{en,de}.ts`
- Test: `apps/web/src/components/data/formula-input.test.tsx`

**Interfaces:**

- Consumes: Task 9.
- Produces: `FormulaInput` props unchanged.

Behaviour: the textarea gets `role="combobox"`, `aria-autocomplete="list"`, `aria-expanded`, `aria-controls` → a `role="listbox"` of items (label + kind + localized type from `data.types`), `aria-activedescendant`; ArrowUp/Down move, Enter/Tab accept via `applyFormulaCompletion`, Escape closes; `Ctrl+Space` opens. Below the field, the hint renders `NAME(param, param)` with the current parameter in `<strong>`, names from `data.completion.params.*`. Copy: `completion.label` "Suggestions" / "Vorschläge"; `completion.kinds.{function,field,measure,operator,keyword}` Function / Column / Measure / Operator / Value — Funktion / Spalte / Kennzahl / Operator / Wert; `completion.params.*` for each `FormulaParamName` (e.g. `digits` "decimal places" / "Nachkommastellen", `fallback` "fallback" / "Ersatzwert").

- [ ] **Step 1: Failing static tests**: `renders combobox semantics` (`role="combobox"`, `aria-autocomplete="list"`); `renders the argument hint in German` (value `"ROUND([Revenue], "`; before any selection the cursor is the end of the text, so the hint is for argument 1: function names stay as typed in formulas, parameter names are translated → contains `ROUND(Zahl, <strong>Nachkommastellen</strong>)`).
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/src/components/data/formula-input.test.tsx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; browser check: type `[Rev`, accept with Enter, type `ROUND(`, see hint.
- [ ] **Step 5: Commit** — `feat(web): formula completion with argument hints`

### Task 11: Model editor — calculated measures and measure filters

**Files:**

- Modify: `apps/web/src/components/data/model-editor.tsx`, `apps/web/src/messages/data/{en,de}.ts`
- Test: `apps/web/src/components/data/model-editor.test.tsx`

**Interfaces:**

- Consumes: `ExpressionEditor`, `resolveExpressionDraft`, `formulaMeasureFields`.

Changes: replace `formulaTexts` with `expressionDrafts` (see group note) in state, `savedState`, `current` and every reset (`persist`, `restore`); `build()` resolves `${id}:formula` drafts with target `"calculation"` over `formulaMeasureFields(definition, sourceMap, id)` (`sourceMap` = `new Map(sources.map((s) => [s.id, s]))`) and `${id}:filter` drafts with target `"condition"` over `fieldsFor(measure.datasetId)` into `aggregate.filter`. Formula measures render `ExpressionEditor` with `noun="measure"` instead of the textarea (help text `measureFormulaHelp` kept). Aggregate measures get, below `AggregateFields`, "Add a filter" (creates an edited empty condition draft) or, when `aggregate.filter`/a draft exists, an `ExpressionEditor` labelled "Only include rows where" plus "Remove filter" (sets `aggregate.filter` to `undefined`, deletes the draft). The preview's shared filter textarea (`filterText`) is not a stored definition and stays as is. Copy: `measureFilter` "Only include rows where" / "Nur Zeilen einbeziehen, bei denen"; `addMeasureFilter` "Add a filter" / "Filter hinzufügen"; `removeMeasureFilter` "Remove filter" / "Filter entfernen".

- [ ] **Step 1: Failing tests** (extend existing `render`/`card` helpers): `shows a calculated measure as a visual division` (`divide(field("income"), field("spend"))` → measure selects with "divided by"); `shows a measure filter as rows` (aggregate with `filter: eq(app,"x")` → "Only include rows where", "Condition 1"); `is not dirty when opened` (export `modelEditorState(name: string, definition: SemanticModelDefinition, drafts: Record<string, ExpressionDraft>): string` from `model-editor.tsx`, used for both `savedState` and `current`; assert `modelEditorState("M", def, {})` equals the state computed for a freshly opened editor and differs once a draft is added); German labels in `de`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/src/components/data/model-editor.test.tsx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test` → PASS; browser check: add "German revenue" with filter `Germany is True`, add "German share" = German revenue divided by Revenue, preview, reopen unchanged → no unsaved marker.
- [ ] **Step 5: Commit** — `feat(web): visual measure filters and calculated measures`

---

## Group G4 — End-to-end journey test (English and German)

**Issue title:** "11C: end-to-end browser test of the no-code journey (en, de)". **Depends on:** G2, G3, and the impact-before-publish PR (its publish confirmation is part of the journey). **Tasks:** 12–13.

The repository has no interactive browser tests today: component tests render static markup (`renderI18n`, vitest `environment: "node"`), and no Playwright/jsdom/testing-library dependency exists. Playwright is added because the architecture already names it (renderer, `docs/architecture.md`) and the gate needs a real browser against the real API.

### Task 12: Playwright harness and CI job

**Files:**

- Modify: `package.json` (devDependency `@playwright/test` at the newest release published at least 7 days earlier, exact version, no `^`; scripts `"e2e": "playwright test"`, and append `&& tsc -p e2e` to `typecheck`)
- Create: `playwright.config.ts`, `e2e/tsconfig.json`, `e2e/support/session.ts`, `e2e/support/labels.ts`, `e2e/smoke.spec.ts`
- Modify: `.github/workflows/ci.yml` (new job `e2e`), `CLAUDE.md` (definition of done: `pnpm e2e` for UI flows; list `e2e` among CI checks), `.gitignore` (`test-results/`, `playwright-report/`)

**Interfaces:**

- Produces:

```ts
// e2e/support/session.ts
export async function startWorkspace(
  page: Page,
  locale: "en" | "de",
): Promise<{ workspaceId: string }>; // sign-up via POST /api/auth/sign-up/email with accept-language, then POST /v1/workspaces
export async function seedReferenceTable(
  page: Page,
  workspaceId: string,
  table: {
    name: string;
    key: string;
    fields: DataField[];
    rows: Record<string, unknown>[];
  },
): Promise<string>; // POST /v1/workspaces/:id/data/manual/pages, body per manualDatasetPageInputSchema (one complete page)
// e2e/support/labels.ts
export function labels(locale: "en" | "de"): (typeof dataEn)["data"]; // imports dataEn/dataDe from apps/web/src/messages/data
```

Config: `testDir: "e2e"`, `testMatch: "**/*.spec.ts"` (vitest's include never matches `e2e/`), projects `en` (`locale: "en-US"`) and `de` (`locale: "de-DE"`), Chromium only, `baseURL: "http://localhost:3000"`, `webServer` = `[ { command: "node apps/server/dist/index.js", url: "http://localhost:3001/health/live" }, { command: "pnpm --filter @netrics/web start", url: "http://localhost:3000/healthz" } ]`, `reuseExistingServer: !process.env.CI` (locally reuses `pnpm dev`). CI job `e2e` (ubuntu-24.04, `permissions: contents: read`, Postgres 17 service with `POSTGRES_DB: netrics`, env from `.env.example` defaults with port 5432, `NETRICS_EXCHANGE_RATES=off`): checkout / pnpm / node 26 (same SHAs as `check`) → `pnpm install --frozen-lockfile` → `pnpm build` → `pnpm db:migrate` → `pnpm exec playwright install --with-deps chromium` → `pnpm e2e` → on failure upload `playwright-report/` with `actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2`. Locally, check `df -h /Volumes/Workspace` before installing the browser (only Chromium).

- [ ] **Step 1: Write `e2e/smoke.spec.ts`**: `opens the data page in the project's language` — `startWorkspace`, `page.goto(/workspaces/${id}/data)`, expect heading text from `labels(locale)` (German project sees the German title).
- [ ] **Step 2: Run** `pnpm e2e` with `pnpm dev` running → FAIL before the config exists, PASS after.
- [ ] **Step 3: Implement config, support files, CI job, docs.**
- [ ] **Step 4: Run** `pnpm typecheck && pnpm lint && pnpm e2e` → PASS (both projects).
- [ ] **Step 5: Commit** — `test(e2e): Playwright harness and CI job`. In the PR, ask the owner to add `e2e` to the required checks.

### Task 13: The 11C journey spec

**Files:**

- Create: `e2e/data-journey.spec.ts`, `e2e/fixtures/journey.ts`

**Interfaces:**

- Consumes: Task 12 helpers; UI from G2/G3; the impact-before-publish confirmation (accept it if shown).

Fixture data: "Sales EU" and "Sales US" (fields `day` date, `app` string, `country` string, `revenue` decimal; 4 rows each, one zero-revenue row each, countries DE/AT/US) seeded via `seedReferenceTable`; the mapping table "Apps" (`id` → `product`) is entered through the reference editor's paste box (TSV), so the mapping itself is created without code.

Journey (every locator `getByRole`/`getByLabel` with names from `labels(locale)`; the spec must not `fill` any formula textarea — assert `page.getByRole("combobox", { name: formulaLabel })` was never focused by checking it is not visible while in visual view):

1. Data → new preparation from "Sales EU"; add step "Append rows" with "Sales US", tick "Match columns before appending", accept suggestions, apply → preview shows 8 rows.
2. Add "Calculate a column" named "Germany": kind "True when", Country · is · `DE` → preview column `Germany` has `true` on DE rows.
3. Add "Filter rows": Revenue · is greater than · `0` (German project types `0`; additionally Day · is at least · date picker `2026-01-01`) → 6 rows.
4. Add "Merge columns" with "Apps", key `app` → `id`, "One match per source row" → preview shows `Product` filled for every row (the confirmed entity mapping; a duplicate key would stop with the cardinality error).
5. Reopen the "Germany" step and apply unchanged → no new history entry; switch it to Formula view and back → rows unchanged.
6. Publish (confirm impact dialog if present) → published notice.
7. New model on the published output; measure "Revenue" (sum of revenue); measure "German revenue" (sum, "Add a filter": Germany · is · True switch); measure "German share" ("Calculate from measures": German revenue · divided by · Revenue; wrap Round, 2 decimal places); preview → German share equals the fixture's expected value (`0.50` for the fixture); publish.
8. Formula view of "German share" shows `ROUND(DIVIDE([German revenue], [Revenue]), 2)`.

- [ ] **Step 1: Write the spec** as above, one `test("a customer builds and publishes without code")` per project.
- [ ] **Step 2: Run** `pnpm e2e --project=en` → PASS; `pnpm e2e --project=de` → PASS. Run three times (`--repeat-each=3`) to rule out timing flakes.
- [ ] **Step 3: Commit** — `test(e2e): 11C no-code journey in English and German`. PR links gate #442 and lists the journey in the description.

---

## Self-Review Notes (decisions recorded for executors)

- **"Derive a boolean field"** needs a calculation that is a condition; the spec's calculation subset omits it. Decision: calculation kind `boolean` (a visual condition as the computed value).
- **"Confirm an entity mapping"** in the generic engine is a validated many-to-one join to a reference table; the store-specific cross-store mapping needs real accounts and stays in the owner's acceptance run.
- **Operators on booleans/strings**: the checker accepts `lt/gt` on any non-json type; per spec the checker decides, so they are offered.
- **Group-step aggregate filters** and the model preview's shared filter remain formula text (outside the spec's "Where").
- **Formula printer change (Task 2)** only affects displayed text; stored ASTs never change unless the customer edits, and `TO_DATE(...)` parsing is untouched.
