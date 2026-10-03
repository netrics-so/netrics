import { describe, expect, it } from "vitest";

import type { StudioPlacement } from "./studio-layout.js";
import { slideLayoutProblem, type WidgetType } from "./studio.js";

const metric = (rect: StudioPlacement) => ({
  type: "metric" as WidgetType,
  ...rect,
});

describe("slideLayoutProblem", () => {
  it.each<
    [string, Array<StudioPlacement & { type: WidgetType }>, string | null]
  >([
    ["an empty slide", [], null],
    ["the whole grid", [metric({ x: 0, y: 0, w: 12, h: 8 })], null],
    [
      "two side by side",
      [metric({ x: 0, y: 0, w: 6, h: 8 }), metric({ x: 6, y: 0, w: 6, h: 8 })],
      null,
    ],
    [
      "past the right edge",
      [metric({ x: 10, y: 0, w: 3, h: 2 })],
      "widget_out_of_bounds",
    ],
    [
      "past the bottom",
      [metric({ x: 0, y: 7, w: 3, h: 2 })],
      "widget_out_of_bounds",
    ],
    [
      "a negative cell",
      [metric({ x: -1, y: 0, w: 3, h: 2 })],
      "widget_out_of_bounds",
    ],
    [
      "half a cell",
      [metric({ x: 0.5, y: 0, w: 3, h: 2 })],
      "widget_out_of_bounds",
    ],
    [
      "no width",
      [{ type: "text", x: 0, y: 0, w: 0, h: 1 }],
      "widget_out_of_bounds",
    ],
    [
      "a metric of 2 × 2",
      [metric({ x: 0, y: 0, w: 2, h: 2 })],
      "widget_too_small",
    ],
    [
      "a metric of 3 × 1",
      [metric({ x: 0, y: 0, w: 3, h: 1 })],
      "widget_too_small",
    ],
    [
      "a line of 4 × 2",
      [{ type: "line", x: 0, y: 0, w: 4, h: 2 }],
      "widget_too_small",
    ],
    [
      "a bar of 3 × 3",
      [{ type: "bar", x: 0, y: 0, w: 3, h: 3 }],
      "widget_too_small",
    ],
    [
      "a text of 1 × 1",
      [{ type: "text", x: 0, y: 0, w: 1, h: 1 }],
      "widget_too_small",
    ],
    ["a clock of 2 × 1", [{ type: "clock", x: 10, y: 7, w: 2, h: 1 }], null],
    [
      "one cell shared",
      [metric({ x: 0, y: 0, w: 3, h: 2 }), metric({ x: 2, y: 1, w: 3, h: 2 })],
      "widgets_overlap",
    ],
    [
      "one inside another",
      [
        metric({ x: 0, y: 0, w: 12, h: 8 }),
        { type: "clock", x: 4, y: 4, w: 2, h: 1 },
      ],
      "widgets_overlap",
    ],
    [
      "touching edges",
      [metric({ x: 0, y: 0, w: 3, h: 2 }), metric({ x: 3, y: 2, w: 3, h: 2 })],
      null,
    ],
  ])("%s", (_, widgets, problem) => {
    expect(slideLayoutProblem(widgets)).toBe(problem);
  });
});
