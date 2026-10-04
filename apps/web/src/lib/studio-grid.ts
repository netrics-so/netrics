import {
  STUDIO_GRID,
  STUDIO_MIN_WIDGET_SIZE,
  STUDIO_SPACING,
  isInsideGrid,
  meetsMinimumSize,
  placementsOverlap,
  studioFrame,
  type StudioCanvas,
  type StudioPlacement,
  type WidgetType,
} from "@netrics/domain";

// Grid editing on the Studio canvas (ADR 0015, section 9: own pointer code,
// no library). Everything here is pure: pointer positions become cells,
// drags become snapped placements, keyboard steps become new placements.
// The canvas measures itself when a drag starts, so the same arithmetic
// holds at any canvas size, browser zoom or device pixel ratio.

/** The 12 × 8 grid in the pixels of a measured canvas. */
export interface GridMetrics {
  /** The grid's top-left corner, relative to the canvas. */
  left: number;
  top: number;
  cellWidth: number;
  cellHeight: number;
  gap: number;
}

/** The grid of a canvas `canvas` pixels large (any 16:9 size). */
export function gridMetrics(
  canvas: StudioCanvas,
  showHeader: boolean,
): GridMetrics {
  const { unit, grid } = studioFrame(canvas, showHeader);
  const gap = STUDIO_SPACING.gap * unit;
  return {
    left: grid.x,
    top: grid.y,
    cellWidth:
      (grid.width - gap * (STUDIO_GRID.columns - 1)) / STUDIO_GRID.columns,
    cellHeight: (grid.height - gap * (STUDIO_GRID.rows - 1)) / STUDIO_GRID.rows,
    gap,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/**
 * The cell under a point (relative to the canvas), clamped to the grid; a
 * point in a gap belongs to the cell before it.
 */
export function pointToCell(
  point: { x: number; y: number },
  metrics: GridMetrics,
): { column: number; row: number } {
  const column = Math.floor(
    (point.x - metrics.left) / (metrics.cellWidth + metrics.gap),
  );
  const row = Math.floor(
    (point.y - metrics.top) / (metrics.cellHeight + metrics.gap),
  );
  return {
    column: clamp(column, 0, STUDIO_GRID.columns - 1),
    row: clamp(row, 0, STUDIO_GRID.rows - 1),
  };
}

/** A pointer movement in pixels as a movement in (fractional) cells. */
export function pixelsToCells(
  delta: { x: number; y: number },
  metrics: GridMetrics,
): { dx: number; dy: number } {
  return {
    dx: delta.x / (metrics.cellWidth + metrics.gap),
    dy: delta.y / (metrics.cellHeight + metrics.gap),
  };
}

/** What a drag holds: the widget itself, or one of its edges or corners. */
export type DragHandle =
  "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const RESIZE_HANDLES: readonly Exclude<DragHandle, "move">[] = [
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
  "nw",
];

/**
 * Where a widget lands when its `handle` is dragged by `delta` cells:
 * snapped to whole cells and kept inside the grid. A move keeps the size; a
 * resize moves only the held edges and never goes below the type's minimum
 * size. Overlap is not resolved here (see `placementBlocker`): the canvas
 * shows it and the reducer refuses it.
 */
export function dragPlacement(
  start: StudioPlacement,
  handle: DragHandle,
  delta: { dx: number; dy: number },
  type: WidgetType,
): StudioPlacement {
  const { columns, rows } = STUDIO_GRID;
  if (handle === "move") {
    const w = Math.min(start.w, columns);
    const h = Math.min(start.h, rows);
    return {
      x: clamp(Math.round(start.x + delta.dx), 0, columns - w),
      y: clamp(Math.round(start.y + delta.dy), 0, rows - h),
      w,
      h,
    };
  }
  const minimum = STUDIO_MIN_WIDGET_SIZE[type];
  let left = start.x;
  let right = start.x + start.w;
  let top = start.y;
  let bottom = start.y + start.h;
  if (handle.includes("e")) {
    right = clamp(
      Math.round(right + delta.dx),
      Math.min(left + minimum.w, columns),
      columns,
    );
  }
  if (handle.includes("w")) {
    left = clamp(
      Math.round(left + delta.dx),
      0,
      Math.max(right - minimum.w, 0),
    );
  }
  if (handle.includes("s")) {
    bottom = clamp(
      Math.round(bottom + delta.dy),
      Math.min(top + minimum.h, rows),
      rows,
    );
  }
  if (handle.includes("n")) {
    top = clamp(Math.round(top + delta.dy), 0, Math.max(bottom - minimum.h, 0));
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

export type PlacementBlocker =
  | { kind: "outside" }
  | { kind: "tooSmall"; minimum: { w: number; h: number } }
  | { kind: "overlap"; index: number };

/**
 * Why a widget of `type` cannot take `placement` among `others` (the other
 * widgets of its slide), or null when it can: the server's rules (inside
 * the grid, minimum size, no overlap). `index` is the first widget in the way.
 */
export function placementBlocker(
  placement: StudioPlacement,
  type: WidgetType,
  others: readonly StudioPlacement[],
): PlacementBlocker | null {
  if (!isInsideGrid(placement)) {
    return { kind: "outside" };
  }
  if (!meetsMinimumSize(type, placement)) {
    return { kind: "tooSmall", minimum: STUDIO_MIN_WIDGET_SIZE[type] };
  }
  const index = others.findIndex((other) =>
    placementsOverlap(placement, other),
  );
  return index === -1 ? null : { kind: "overlap", index };
}

export function samePlacement(a: StudioPlacement, b: StudioPlacement) {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * A keyboard move by one cell in a direction (`dx`, `dy` of -1, 0 or 1):
 * the next free spot that way, jumping over widgets in the way, so every
 * free spot in a row or column is reachable without a pointer. Null at the
 * edge, or when nothing is free that way.
 */
export function nudgePlacement(
  placement: StudioPlacement,
  dx: number,
  dy: number,
  others: readonly StudioPlacement[],
): StudioPlacement | null {
  if (dx === 0 && dy === 0) {
    return null;
  }
  for (let step = 1; ; step++) {
    const candidate = {
      ...placement,
      x: placement.x + dx * step,
      y: placement.y + dy * step,
    };
    if (!isInsideGrid(candidate)) {
      return null;
    }
    if (!others.some((other) => placementsOverlap(candidate, other))) {
      return candidate;
    }
  }
}

/**
 * A keyboard resize by one cell (`dw`, `dh` of -1, 0 or 1), growing or
 * shrinking the right and bottom edges. Null when it would leave the grid
 * or go below the type's minimum; overlap is checked by the caller.
 */
export function resizePlacement(
  placement: StudioPlacement,
  dw: number,
  dh: number,
  type: WidgetType,
): StudioPlacement | null {
  const candidate = {
    ...placement,
    w: placement.w + dw,
    h: placement.h + dh,
  };
  if (!isInsideGrid(candidate)) {
    return null;
  }
  // Shrinking a widget that is already below its minimum stays refused;
  // growing it towards the minimum is allowed.
  const minimum = STUDIO_MIN_WIDGET_SIZE[type];
  if (
    (dw < 0 && candidate.w < minimum.w) ||
    (dh < 0 && candidate.h < minimum.h)
  ) {
    return null;
  }
  return candidate;
}
