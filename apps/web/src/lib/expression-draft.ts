/**
 * Draft state of an expression editor (visual rows or formula text). The
 * stored expression stays the source of truth: an unedited draft resolves to
 * the very object it was opened from, and switching views never edits.
 */
import {
  DataProcessingError,
  emptyVisualModel,
  formatDataFormula,
  fromVisual,
  parseDataFormula,
  sameDataExpression,
  toVisual,
  visualModelComplete,
  visualProblem,
  type DataExpression,
  type DataField,
  type NotVisualReason,
  type VisualModel,
  type VisualTarget,
} from "@netrics/domain";

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

/** Visual rows when the builder can show the expression, else its formula. */
export function initialExpressionDraft(
  initial: DataExpression | undefined,
  target: VisualTarget,
  fields: readonly DataField[],
): ExpressionDraft {
  if (!initial)
    return { view: "visual", model: emptyVisualModel(target), edited: true };
  const visual = toVisual(initial, target);
  return visual.representable
    ? { view: "visual", model: visual.model, edited: false }
    : {
        view: "formula",
        text: formatDataFormula(initial, fields),
        edited: false,
        note: visual.reason,
      };
}

/**
 * The other view of the same expression. From visual, an incomplete model
 * throws `builder_incomplete`; from formula, text the builder cannot show
 * stays in formula view with the reason.
 */
export function switchExpressionView(
  draft: ExpressionDraft,
  target: VisualTarget,
  fields: readonly DataField[],
): ExpressionDraft {
  if (draft.view === "visual") {
    const text = formatDataFormula(fromVisual(draft.model), fields);
    return {
      view: "formula",
      text,
      edited: draft.edited,
      origin: { text, model: draft.model },
    };
  }
  if (draft.origin && draft.text === draft.origin.text)
    return { view: "visual", model: draft.origin.model, edited: draft.edited };
  const visual = toVisual(parseDataFormula(draft.text, fields), target);
  if (visual.representable)
    return { view: "visual", model: visual.model, edited: draft.edited };
  const { origin: _origin, ...rest } = draft;
  return { ...rest, note: visual.reason };
}

/**
 * The expression to save: `initial` itself when nothing was edited, else the
 * draft's expression (throws `DataProcessingError` when it does not check).
 */
export function resolveExpressionDraft(
  draft: ExpressionDraft | undefined,
  initial: DataExpression | undefined,
  target: VisualTarget,
  fields: readonly DataField[],
): DataExpression {
  const current = draft ?? initialExpressionDraft(initial, target, fields);
  if (initial && !current.edited) return initial;
  // Text typed back to the stored formula keeps the stored expression: some
  // literals (a typed NULL) print in a form that reads back differently.
  if (
    initial &&
    current.view === "formula" &&
    current.text === formatDataFormula(initial, fields)
  )
    return initial;
  // Edits undone by hand (a toggle on and off, a value typed back) keep it
  // too, even when it does not check any more (a column removed upstream).
  const same = (next: DataExpression) =>
    initial && sameDataExpression(next, initial) ? initial : next;
  if (current.view === "visual" && visualModelComplete(current.model)) {
    const next = same(fromVisual(current.model));
    if (next === initial) return next;
  }
  return same(editedExpression(current, target, fields));
}

function editedExpression(
  current: ExpressionDraft,
  target: VisualTarget,
  fields: readonly DataField[],
): DataExpression {
  if (current.view === "visual") {
    const problem = visualProblem(current.model, fields, target);
    if (problem) throw new DataProcessingError(problem.code, problem.fieldId);
    return fromVisual(current.model);
  }
  if (current.origin && current.text === current.origin.text)
    return fromVisual(current.origin.model);
  return parseDataFormula(current.text, fields);
}
