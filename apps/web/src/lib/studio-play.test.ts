import { describe, expect, it } from "vitest";

import { playlist, stepIndex } from "./studio-play";

const slides = [
  { id: "a", enabled: true, durationSeconds: null },
  { id: "b", enabled: false, durationSeconds: 10 },
  { id: "c", enabled: true, durationSeconds: 45 },
];

describe("playlist", () => {
  it("plays enabled slides for their own or the default duration", () => {
    expect(
      playlist(slides, { autoAdvance: true, defaultSlideSeconds: 20 }).map(
        (item) => [item.slide.id, item.seconds],
      ),
    ).toEqual([
      ["a", 20],
      ["c", 45],
    ]);
  });

  it("shows only the first enabled slide without auto-advance", () => {
    expect(
      playlist(slides.slice(1), {
        autoAdvance: false,
        defaultSlideSeconds: 20,
      }).map((item) => item.slide.id),
    ).toEqual(["c"]);
  });

  it("is empty when every slide is disabled", () => {
    expect(
      playlist([slides[1]!], { autoAdvance: true, defaultSlideSeconds: 20 }),
    ).toEqual([]);
  });
});

describe("stepIndex", () => {
  it("wraps both ways", () => {
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(0, -1, 3)).toBe(2);
    expect(stepIndex(0, 1, 0)).toBe(0);
  });
});
