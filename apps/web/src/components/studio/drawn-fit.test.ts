import { describe, expect, it } from "vitest";

import {
  fullyVisible,
  namedKeepsEveryPart,
  retryAtSize,
  textExtent,
  type DrawnBox,
} from "./drawn-fit";

// `useDrawnCut` (#791): the named line is measured as drawn; cut, the
// plain line shows instead, and the named one is tried again when the box
// or the font size changes. Measure → state → render → measure must
// settle. The model below is the hook's loop with a box whose size depends
// on which line it shows (the worst case: every swap changes the size).

/** Runs the loop until nothing changes; the passes it took. */
function settle(input: {
  /** The drawn size with the named and with the plain line. */
  size: (line: "named" | "plain") => string;
  /** Whether the named line is cut at that size. */
  cut: (size: string) => boolean;
  seen?: Set<string>;
  start?: "named" | "plain";
}): { passes: number; shows: "named" | "plain"; seen: Set<string> } {
  const seen = input.seen ?? new Set<string>();
  let shows = input.start ?? "named";
  let passes = 0;
  for (;;) {
    passes += 1;
    if (passes > 50) throw new Error("does not settle");
    const size = input.size(shows);
    if (shows === "named") {
      if (!input.cut(size)) break;
      seen.add(size);
      shows = "plain";
      continue;
    }
    // The plain line is drawn: its size is noted, and a change of size
    // (the observer's callback) tries the named line once.
    if (!retryAtSize(seen, size)) break;
    shows = "named";
  }
  return { passes, shows, seen };
}

describe("the named line's drawn check settles (#791)", () => {
  it("a line that fits is measured once", () => {
    expect(
      settle({ size: () => "300x31@24px", cut: () => false }),
    ).toMatchObject({ passes: 1, shows: "named" });
  });

  it("a line that is cut falls back, and a box that changes with the line costs one more try", () => {
    const stable = settle({ size: () => "300x31@24px", cut: () => true });
    expect(stable).toMatchObject({ shows: "plain" });
    expect(stable.passes).toBeLessThanOrEqual(3);
    // Every swap changes the box: still bounded, and it ends on the plain
    // line.
    const swapping = settle({
      size: (line) => (line === "named" ? "310x31@24px" : "300x31@24px"),
      cut: () => true,
    });
    expect(swapping).toMatchObject({ shows: "plain" });
    expect(swapping.passes).toBeLessThanOrEqual(4);
  });

  it("a larger font is measured again, a size already decided is not", () => {
    const seen = new Set<string>();
    // Font scale 1: fits.
    expect(
      settle({ size: () => "300x31@24px", cut: () => false, seen }).shows,
    ).toBe("named");
    // Font scale 1.3: the box grows with the font, and the line is cut.
    const large = settle({
      size: () => "300x41@31.2px",
      cut: (size) => size.endsWith("@31.2px"),
      seen,
    });
    expect(large).toMatchObject({ shows: "plain" });
    expect(large.passes).toBeLessThanOrEqual(3);
    // Back to scale 1 with the plain line drawn: a new size, one try, and
    // the named line is back.
    const back = settle({
      size: () => "300x31@24px",
      cut: (size) => size.endsWith("@31.2px"),
      seen,
      start: "plain",
    });
    expect(back).toMatchObject({ shows: "named", passes: 2 });
    // The same large size again: decided already, no further pass.
    expect(
      settle({
        size: () => "300x41@31.2px",
        cut: () => true,
        seen,
        start: "plain",
      }),
    ).toMatchObject({ shows: "plain", passes: 1 });
  });
});

// A part counts only when it is fully visible (#791): its box inside the
// line's clip box on all four sides. The named wording replaces the plain
// one only when it shows whole every part the plain one shows whole.
describe("fully visible parts (#791)", () => {
  /** A 180 px line, 24 px high, at (100, 50). */
  const line: DrawnBox = { left: 100, right: 280, top: 50, bottom: 74 };
  /** Parts laid out as a wrapping row: side by side, then the next line. */
  const row = (widths: number[], height = 24): DrawnBox[] => {
    const boxes: DrawnBox[] = [];
    let left = line.left;
    let top = line.top;
    for (const width of widths) {
      if (left > line.left && left + width > line.right) {
        left = line.left;
        top += height;
      }
      boxes.push({ left, right: left + width, top, bottom: top + height });
      left += width;
    }
    return boxes;
  };
  const visible = (widths: number[], height = 24) =>
    row(widths, height).map((part) => fullyVisible(part, line));

  it("a part inside the line is visible, with half a pixel of tolerance on every side", () => {
    expect(fullyVisible(line, line)).toBe(true);
    expect(fullyVisible({ ...line, right: 280.4 }, line)).toBe(true);
    expect(fullyVisible({ ...line, left: 99.6 }, line)).toBe(true);
    expect(fullyVisible({ ...line, top: 49.6 }, line)).toBe(true);
    expect(fullyVisible({ ...line, bottom: 74.4 }, line)).toBe(true);
    expect(fullyVisible({ ...line, right: 281 }, line)).toBe(false);
    expect(fullyVisible({ ...line, left: 99 }, line)).toBe(false);
    expect(fullyVisible({ ...line, top: 49 }, line)).toBe(false);
    expect(fullyVisible({ ...line, bottom: 75 }, line)).toBe(false);
  });

  it("a part on a further line is not, however short", () => {
    expect(
      fullyVisible({ left: 100, right: 140, top: 74, bottom: 98 }, line),
    ).toBe(false);
  });

  it("a part taller than the line is cut at the bottom, though it starts on it", () => {
    // A 33.8 px date in a 15.8 px line (a minimum font size in a box
    // sized for the font that was set): not whole, whatever its width.
    const short: DrawnBox = { left: 100, right: 280, top: 50, bottom: 65.8 };
    expect(
      fullyVisible({ left: 100, right: 220, top: 50, bottom: 83.8 }, short),
    ).toBe(false);
    // Neither wording is whole there: the plain line stays.
    expect(namedKeepsEveryPart([false, false], [false, false])).toBe(false);
  });

  // Text lines (a footer, a several-source form): the rects of the
  // rendered runs, and `fullyVisible` on their extent.
  const textIn = (runs: DrawnBox[], box: DrawnBox) =>
    fullyVisible(textExtent(runs)!, box);

  it("an ordinary footer is whole, though the font's box reaches past its line", () => {
    // As measured in a tile at font scale 1.3: the run 20 px high in a
    // 17.5 px line, a pixel past it above and 1.5 px below, for the named
    // and the plain wording alike.
    const box: DrawnBox = {
      left: 306.4,
      right: 588.5,
      top: 736.8,
      bottom: 754.3,
    };
    expect(
      textIn([{ left: 306.4, right: 506.3, top: 735.8, bottom: 755.8 }], box),
    ).toBe(true);
    // The same line too wide for its box (an ellipsis): cut.
    expect(
      textIn([{ left: 306.4, right: 600, top: 735.8, bottom: 755.8 }], box),
    ).toBe(false);
  });

  it("a footer that fits across but whose box is shorter than its text is cut", () => {
    // A wide, short metric tile with a 26 px minimum font size: the text
    // is 34 px high and fits its 915 px line, but flex has shrunk the
    // line's box to 11 px, and to nothing.
    const run: DrawnBox = {
      left: 306.4,
      right: 1054.7,
      top: 555.9,
      bottom: 589.9,
    };
    const shrunk: DrawnBox = {
      left: 306.4,
      right: 1221.6,
      top: 558.9,
      bottom: 569.9,
    };
    const gone: DrawnBox = { ...shrunk, bottom: 558.9 };
    expect(textIn([run], shrunk)).toBe(false);
    expect(textIn([run], gone)).toBe(false);
    // In a box of its line's height it is whole.
    expect(textIn([run], { ...shrunk, top: 557.9, bottom: 587.8 })).toBe(true);
  });

  it("a several-source line wrapped onto a hidden second line is cut", () => {
    // Two runs, one per line, in a box that shows one.
    const first: DrawnBox = { left: 100, right: 270, top: 49, bottom: 75 };
    const second: DrawnBox = { left: 100, right: 180, top: 73, bottom: 99 };
    expect(textIn([first, second], line)).toBe(false);
    // On one line and inside the box: whole.
    expect(textIn([first], line)).toBe(true);
    // On one line but wider (an ellipsis): cut.
    expect(textIn([{ ...first, right: 300 }], line)).toBe(false);
    expect(textExtent([])).toBeNull();
  });

  it("the reported tile: the plain day fits, the named day is wider than the line", () => {
    // "Bis 30. Sept." 120 px, "Letzter Berichtstag: 30. Sept." 235 px, each
    // followed by the fetch (150 px), in a 180 px line. Both wordings have
    // one part on the first line; only the plain one's is whole.
    const plain = visible([120, 150]);
    const named = visible([235, 150]);
    expect(plain).toEqual([true, false]);
    expect(named).toEqual([false, false]);
    expect(namedKeepsEveryPart(named, plain)).toBe(false);
  });

  it("the same parts whole: the day is named", () => {
    expect(namedKeepsEveryPart(visible([170, 150]), visible([120, 150]))).toBe(
      true,
    );
    expect(namedKeepsEveryPart(visible([90, 80]), visible([60, 80]))).toBe(
      true,
    );
  });

  it("is a set, not a count", () => {
    // As many parts whole, but not the ones the plain line shows.
    expect(namedKeepsEveryPart([true, false, true], [true, true, false])).toBe(
      false,
    );
    // More is fine; fewer is not.
    expect(namedKeepsEveryPart([true, true, true], [true, true, false])).toBe(
      true,
    );
    expect(namedKeepsEveryPart([true, false], [true, true])).toBe(false);
    // The named day itself must be whole, even where the plain one is cut.
    expect(namedKeepsEveryPart([false, false], [false, false])).toBe(false);
    expect(namedKeepsEveryPart([], [])).toBe(false);
  });
});
