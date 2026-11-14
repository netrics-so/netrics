import { describe, expect, it } from "vitest";
import {
  EDIT_HISTORY_LIMIT,
  recordEdit,
  redoEdit,
  replacePresent,
  startHistory,
  undoEdit,
} from "./edit-history";

describe("edit history", () => {
  it("undoes and redoes in order and clears redo on a new edit", () => {
    let h = recordEdit(recordEdit(startHistory(1), 2), 3);
    h = undoEdit(undoEdit(h));
    expect([h.present, h.future]).toEqual([1, [3, 2]]);
    h = redoEdit(h);
    expect(h.present).toBe(2);
    h = recordEdit(h, 9);
    expect([h.present, h.future, h.past]).toEqual([9, [], [1, 2]]);
  });
  it("coalesces consecutive edits with the same key into one undo step", () => {
    let h = startHistory("");
    for (const text of ["N", "Ne", "Net"])
      h = recordEdit(h, text, "measure:m1:name");
    h = recordEdit(h, "Net!", "measure:m2:name");
    expect(undoEdit(h).present).toBe("Net");
    expect(undoEdit(undoEdit(h)).present).toBe("");
  });
  it("is a no-op at either end and keeps at most 100 steps", () => {
    const h = startHistory(0);
    expect(undoEdit(h)).toBe(h);
    expect(redoEdit(h)).toBe(h);
    let long = h;
    for (let i = 1; i <= 150; i++) long = recordEdit(long, i);
    expect(long.past).toHaveLength(EDIT_HISTORY_LIMIT);
    expect(long.past[0]).toBe(50);
  });
  it("replaces the present without an undo step", () => {
    const h = replacePresent(recordEdit(startHistory(1), 2, "k"), 3);
    expect([h.past, h.present, h.lastEditKey]).toEqual([[1], 3, null]);
  });
  it("does not coalesce after undo", () => {
    let h = recordEdit(startHistory("a"), "ab", "k");
    h = undoEdit(h);
    h = recordEdit(h, "ac", "k");
    expect(h.past).toEqual(["a"]);
    expect(undoEdit(h).present).toBe("a");
  });
});
