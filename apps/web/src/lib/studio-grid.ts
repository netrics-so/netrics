import {
  SCREEN_FORMATS,
  STUDIO_MIN_WIDGET_SIZE,
  STUDIO_SPACING,
  isInsideFormatGrid,
  meetsMinimumSize,
  placementsOverlap,
  screenFrame,
  studioFrame,
  type ScreenFormat,
  type StudioCanvas,
  type StudioPlacement,
  type WidgetType,
} from "@netrics/domain";

// Grid editing on the Studio canvas (ADR 0015, section 9: own pointer code,
// no library). Everything here is pure: pointer positions become cells,
// drags become snapped placements, keyboard steps become new placements.
// The canvas measures itself when a drag starts, so the same arithmetic
// holds at any canvas size, browser zoom or device pixel ratio. Every
// function works on the grid of a screen format (ADR 0017): the primary's,
// or a custom layout's (#284); `16x9` (12 × 8) by default.

/** Columns and rows of a format's grid. */
function gridOf(format: ScreenFormat): { columns: number; rows: number } {
  const { columns, rows } = SCREEN_FORMATS[format];
  return { columns, rows };
}

/** A format's grid in the pixels of a measured canvas. */
export interface GridMetrics {
  /** The grid's top-left corner, relative to the canvas. */
  left: number;
  top: number;
  cellWidth: number;
  cellHeight: number;
  gap: number;
}

/**
 * The grid of a canvas `canvas` pixels large: any 16:9 size for `16x9`,
 * else the format's grid over the canvas as screen view places it.
 */
export function gridMetrics(
  canvas: StudioCanvas,
  showHeader: boolean,
  format: ScreenFormat = "16x9",
): GridMetrics {
  const { columns, rows } = gridOf(format);
  const { unit, grid } =
    format === "16x9"
      ? studioFrame(canvas, showHeader)
      : screenFrame(canvas, format, showHeader);
  const gap = STUDIO_SPACING.gap * unit;
  return {
    left: grid.x,
    top: grid.y,
    cellWidth: (grid.width - gap * (columns - 1)) / columns,
    cellHeight: (grid.height - gap * (rows - 1)) / rows,
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
  format: ScreenFormat = "16x9",
): { column: number; row: number } {
  const { columns, rows } = gridOf(format);
  const column = Math.floor(
    (point.x - metrics.left) / (metrics.cellWidth + metrics.gap),
  );
  const row = Math.floor(
    (point.y - metrics.top) / (metrics.cellHeight + metrics.gap),
  );
  return {
    column: clamp(column, 0, columns - 1),
    row: clamp(row, 0, rows - 1),
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
  format: ScreenFormat = "16x9",
): StudioPlacement {
  const { columns, rows } = gridOf(format);
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
  format: ScreenFormat = "16x9",
): PlacementBlocker | null {
  if (!isInsideFormatGrid(placement, format)) {
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
  format: ScreenFormat = "16x9",
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
    if (!isInsideFormatGrid(candidate, format)) {
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
  format: ScreenFormat = "16x9",
): StudioPlacement | null {
  const candidate = {
    ...placement,
    w: placement.w + dw,
    h: placement.h + dh,
  };
  if (!isInsideFormatGrid(candidate, format)) {
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

// ---------------------------------------------------------------------------
// Free spots (#241: duplicate, paste, drop from the add menu)

/**
 * The free spot closest to `target` (by the distance of the top-left
 * corners in widget widths and heights, ties in reading order) for a widget of `type`: at the target's
 * size, else at the type's minimum size. Null when the slide has no room.
 */
export function nearestFreePlacement(
  target: StudioPlacement,
  type: WidgetType,
  others: readonly StudioPlacement[],
  format: ScreenFormat = "16x9",
): StudioPlacement | null {
  const { columns, rows } = gridOf(format);
  const minimum = STUDIO_MIN_WIDGET_SIZE[type];
  const sizes = [
    {
      w: Math.min(Math.max(target.w, minimum.w), columns),
      h: Math.min(Math.max(target.h, minimum.h), rows),
    },
    minimum,
  ];
  for (const size of sizes) {
    let best: StudioPlacement | null = null;
    let bestDistance = Infinity;
    for (let y = 0; y + size.h <= rows; y++) {
      for (let x = 0; x + size.w <= columns; x++) {
        const candidate = { x, y, ...size };
        if (others.some((other) => placementsOverlap(candidate, other))) {
          continue;
        }
        // In widget sizes, so "next to it" beats "below it" for a wide
        // widget; ties keep reading order.
        const distance =
          ((x - target.x) / size.w) ** 2 + ((y - target.y) / size.h) ** 2;
        if (distance < bestDistance) {
          best = candidate;
          bestDistance = distance;
        }
      }
    }
    if (best) {
      return best;
    }
  }
  return null;
}

/**
 * Where a new widget dropped at `point` (relative to the canvas) goes: a
 * widget of `size` centred on the point, snapped to cells and kept inside
 * the grid; at the type's minimum size when its usual size would overlap.
 * `blocked` when neither fits there (the drop is refused).
 */
export function dropPlacement(
  point: { x: number; y: number },
  metrics: GridMetrics,
  type: WidgetType,
  size: { w: number; h: number },
  others: readonly StudioPlacement[],
  format: ScreenFormat = "16x9",
): { placement: StudioPlacement; blocked: boolean } {
  const { columns, rows } = gridOf(format);
  const column = (point.x - metrics.left) / (metrics.cellWidth + metrics.gap);
  const row = (point.y - metrics.top) / (metrics.cellHeight + metrics.gap);
  const around = (w: number, h: number): StudioPlacement => ({
    x: clamp(Math.round(column - w / 2), 0, columns - w),
    y: clamp(Math.round(row - h / 2), 0, rows - h),
    w,
    h,
  });
  const minimum = STUDIO_MIN_WIDGET_SIZE[type];
  const usual = around(Math.min(size.w, columns), Math.min(size.h, rows));
  if (!placementBlocker(usual, type, others, format)) {
    return { placement: usual, blocked: false };
  }
  const small = around(minimum.w, minimum.h);
  if (!placementBlocker(small, type, others, format)) {
    return { placement: small, blocked: false };
  }
  return { placement: usual, blocked: true };
}
