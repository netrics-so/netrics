import { describe, expect, it } from "vitest";

import { retryAtSize } from "./drawn-fit";

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
