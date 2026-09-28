import { describe, expect, it } from "vitest";

import { tvGrid } from "./tv-grid";

describe("tvGrid", () => {
  it.each([
    [0, 1, 1],
    [1, 1, 1],
    [2, 2, 1],
    [3, 3, 1],
    [4, 2, 2],
    [6, 3, 2],
    [8, 4, 2],
    [9, 3, 3],
    [12, 4, 3],
    [24, 6, 4],
  ])("%i tiles → %i × %i", (tiles, columns, rows) => {
    expect(tvGrid(tiles)).toEqual({ columns, rows });
  });

  it("always fits every tile", () => {
    for (let tiles = 1; tiles <= 24; tiles++) {
      const { columns, rows } = tvGrid(tiles);
      expect(columns * rows).toBeGreaterThanOrEqual(tiles);
      // Never a whole empty row.
      expect(columns * (rows - 1)).toBeLessThan(tiles);
    }
  });
});
