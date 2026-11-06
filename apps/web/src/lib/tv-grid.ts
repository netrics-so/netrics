/**
 * Grid for the TV layout (#52): every tile on one screen, no scrolling.
 * Picks the column count whose cells come closest to a slightly wide card
 * (1.2:1) on the screen's aspect ratio; an empty cell costs about as much
 * as a clearly misshapen tile.
 */
const TARGET_TILE_ASPECT = 1.2;
const EMPTY_CELL_COST = 0.5;

export function tvGrid(
  tiles: number,
  screenAspect = 16 / 9,
): { columns: number; rows: number } {
  if (tiles <= 1) {
    return { columns: 1, rows: 1 };
  }
  let best = { columns: 1, rows: tiles, score: Number.POSITIVE_INFINITY };
  for (let columns = 1; columns <= tiles; columns++) {
    const rows = Math.ceil(tiles / columns);
    const tileAspect = (screenAspect * rows) / columns;
    const empty = columns * rows - tiles;
    const score =
      Math.abs(Math.log(tileAspect / TARGET_TILE_ASPECT)) +
      EMPTY_CELL_COST * empty;
    if (score < best.score) {
      best = { columns, rows, score };
    }
  }
  return { columns: best.columns, rows: best.rows };
}
