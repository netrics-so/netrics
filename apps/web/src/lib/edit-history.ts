/**
 * Generic undo/redo state, shared by the preparation and model editors. It
 * follows the semantics of Studio (`studio-document.ts`): `past`/`future`
 * stacks, an edit key that coalesces consecutive edits, and a size limit.
 * All functions are pure and return a new history (or the same object when
 * nothing changes).
 */

/** Most undo steps kept; the oldest are dropped first. */
export const EDIT_HISTORY_LIMIT = 100;

export interface EditHistory<T> {
  past: T[];
  present: T;
  /** Redo stack: the next redo step is the last entry. */
  future: T[];
  /** Key of the last recorded edit; null after undo, redo, replace or start. */
  lastEditKey: string | null;
}

export function startHistory<T>(present: T): EditHistory<T> {
  return { past: [], present, future: [], lastEditKey: null };
}

/**
 * Sets a new present. The old one becomes an undo step unless `editKey` equals
 * the previous edit's key (typing in one field is one step). Always clears
 * `future`.
 */
export function recordEdit<T>(
  history: EditHistory<T>,
  next: T,
  editKey: string | null = null,
): EditHistory<T> {
  const coalesce = editKey !== null && editKey === history.lastEditKey;
  const past = coalesce
    ? history.past
    : [...history.past, history.present].slice(-EDIT_HISTORY_LIMIT);
  return { past, present: next, future: [], lastEditKey: editKey };
}

/** Steps back; unchanged when there is nothing to undo. */
export function undoEdit<T>(history: EditHistory<T>): EditHistory<T> {
  if (!history.past.length) return history;
  return {
    past: history.past.slice(0, -1),
    present: history.past[history.past.length - 1]!,
    future: [...history.future, history.present],
    lastEditKey: null,
  };
}

/** Steps forward; unchanged when there is nothing to redo. */
export function redoEdit<T>(history: EditHistory<T>): EditHistory<T> {
  if (!history.future.length) return history;
  return {
    past: [...history.past, history.present].slice(-EDIT_HISTORY_LIMIT),
    present: history.future[history.future.length - 1]!,
    future: history.future.slice(0, -1),
    lastEditKey: null,
  };
}

/** Replaces the present without an undo step (e.g. save normalisation). */
export function replacePresent<T>(
  history: EditHistory<T>,
  present: T,
): EditHistory<T> {
  return { ...history, present, lastEditKey: null };
}
