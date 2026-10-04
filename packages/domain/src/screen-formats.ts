/**
 * Screen formats beyond the geometry (ADR 0017, sections 3–5): the auto
 * reflow of a slide from its primary format into any other, the reading
 * order, custom layouts and how they stay in sync with the primary, the
 * default display mode and the scroll view layout.
 *
 * The format table, `formatFor`, `sizeClassFor`, `screenFrame` and
 * `placementRect` live in studio-layout.ts with the rest of the geometry.
 *
 * Written once here and ported to Swift (apps/tvos/NetricsKit). Both test
 * suites run the same vectors (packages/domain/test-vectors/
 * screen-formats.json, `pnpm vectors:formats`), which are normative: keep
 * every function pure, integer-only where it places cells, and its steps in
 * the same order on both sides. Ties are broken by input position, never by
 * comparing ids.
 */
import {
  SCREEN_FORMATS,
  STUDIO_MIN_WIDGET_SIZE,
  isInsideFormatGrid,
  placementsOverlap,
  type ScreenFormat,
  type ScreenSizeClass,
  type StudioPlacement,
  type StudioWidgetType,
} from "./studio-layout.js";

/** A widget of a slide: its id, type and placement in some format. */
export interface LayoutWidget extends StudioPlacement {
  id: string;
  type: StudioWidgetType;
  /**
   * The type's minimum size as a schema 3 payload carries it (ADR 0019
   * section 2): a screen that does not know the type lays it out with this
   * one. Absent: the type's own `STUDIO_MIN_WIDGET_SIZE`.
   */
  min?: { w: number; h: number } | null;
}

/** A widget's placement in a format, by id. */
export interface LayoutPlacement extends StudioPlacement {
  id: string;
}

/** A widget's placement in a custom layout of a format. */
export interface CustomPlacement extends LayoutPlacement {
  /** 0-based page. */
  page: number;
  /** Hidden in this format: an explicit choice, listed in the Studio. */
  hidden: boolean;
  /** Placed automatically after a primary change: "to review". */
  autoPlaced: boolean;
}

/** A slide's stored layout in one non-primary format. */
export interface CustomLayout {
  /** 1 to `CUSTOM_LAYOUT_MAX_PAGES`. */
  pages: number;
  placements: CustomPlacement[];
}

/** A custom layout has at most this many pages. */
export const CUSTOM_LAYOUT_MAX_PAGES = 8;

/** `round(v) = floor(v + 0.5)`, as the Swift port rounds. */
function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

/** A grid edge (column) of `from` scaled to `to`, rounded. */
function scaleEdge(edge: number, from: number, to: number): number {
  return roundHalfUp((edge * to) / from);
}

function minimumOf(widget: {
  type: StudioWidgetType;
  min?: { w: number; h: number } | null;
}): { w: number; h: number } {
  return widget.min ?? STUDIO_MIN_WIDGET_SIZE[widget.type];
}

// ---------------------------------------------------------------------------
// Bands, stacks and reading order (section 3, steps 1–3)

interface Indexed<T> {
  item: T;
  index: number;
}

interface Stack<T> {
  left: number;
  right: number;
  /** Members top to bottom, by (y, x). */
  members: Array<Indexed<T>>;
}

function byRowThenColumn<T extends StudioPlacement>(
  a: Indexed<T>,
  b: Indexed<T>,
): number {
  return a.item.y - b.item.y || a.item.x - b.item.x || a.index - b.index;
}

function byColumnThenRow<T extends StudioPlacement>(
  a: Indexed<T>,
  b: Indexed<T>,
): number {
  return a.item.x - b.item.x || a.item.y - b.item.y || a.index - b.index;
}

/**
 * The slide's bands (top to bottom) of stacks (left to right). A band is a
 * maximal run, by (y, x), in which each next widget starts above the band's
 * bottom; a stack a maximal run, by (x, y), in which each next widget starts
 * left of the stack's right edge.
 */
function bandsAndStacks<T extends StudioPlacement>(
  items: readonly T[],
): Array<Array<Stack<T>>> {
  const sorted = items
    .map((item, index) => ({ item, index }))
    .sort(byRowThenColumn);
  const bands: Array<Array<Indexed<T>>> = [];
  let bottom = 0;
  for (const entry of sorted) {
    const band = bands[bands.length - 1];
    if (band && entry.item.y < bottom) {
      band.push(entry);
      bottom = Math.max(bottom, entry.item.y + entry.item.h);
    } else {
      bands.push([entry]);
      bottom = entry.item.y + entry.item.h;
    }
  }
  return bands.map((band) => {
    const stacks: Array<Stack<T>> = [];
    for (const entry of [...band].sort(byColumnThenRow)) {
      const stack = stacks[stacks.length - 1];
      if (stack && entry.item.x < stack.right) {
        stack.members.push(entry);
        stack.right = Math.max(stack.right, entry.item.x + entry.item.w);
      } else {
        stacks.push({
          left: entry.item.x,
          right: entry.item.x + entry.item.w,
          members: [entry],
        });
      }
    }
    for (const stack of stacks) {
      stack.members.sort(byRowThenColumn);
    }
    return stacks;
  });
}

/**
 * Widgets in reading order: band by band, stack by stack, top to bottom
 * within a stack. Scroll view, the Studio's keyboard order in non-primary
 * formats and screen readers use it. Returns a new array.
 */
export function studioReadingOrder<T extends StudioPlacement>(
  widgets: readonly T[],
): T[] {
  return bandsAndStacks(widgets).flatMap((stacks) =>
    stacks.flatMap((stack) => stack.members.map((member) => member.item)),
  );
}

// ---------------------------------------------------------------------------
// Reflow (section 3, steps 4–8)

interface Block {
  /** Scaled left edge in the target grid. */
  left: number;
  width: number;
  /** Members top to bottom with their heights in rows. */
  members: Array<{ id: string; h: number }>;
}

interface Shelf {
  height: number;
  blocks: Array<{ x: number; block: Block }>;
}

function blockHeight(block: Block): number {
  return block.members.reduce((sum, member) => sum + member.h, 0);
}

/**
 * A stack's size in the target (step 4): rounded scaled edges, at least the
 * largest minimum width of its widgets, at most the grid; heights keep their
 * rows (at least the minimum, at most the grid). A stack taller than the
 * grid is split between widgets into consecutive stacks.
 */
function stackBlocks(
  stack: Stack<LayoutWidget>,
  from: ScreenFormat,
  to: ScreenFormat,
): Block[] {
  const source = SCREEN_FORMATS[from];
  const target = SCREEN_FORMATS[to];
  const left = scaleEdge(stack.left, source.columns, target.columns);
  const right = scaleEdge(stack.right, source.columns, target.columns);
  let width = right - left;
  for (const member of stack.members) {
    width = Math.max(width, minimumOf(member.item).w);
  }
  width = Math.min(width, target.columns);
  const blocks: Block[] = [];
  let current: Block | null = null;
  let used = 0;
  for (const member of stack.members) {
    const h = Math.min(
      Math.max(member.item.h, minimumOf(member.item).h),
      target.rows,
    );
    if (current === null || used + h > target.rows) {
      current = { left, width, members: [] };
      blocks.push(current);
      used = 0;
    }
    current.members.push({ id: member.item.id, h });
    used += h;
  }
  return blocks;
}

/** Greedy shelves: as many blocks per shelf as fit, in order. */
function greedyGroups(blocks: readonly Block[], columns: number): Block[][] {
  const groups: Block[][] = [];
  let used = 0;
  for (const block of blocks) {
    const group = groups[groups.length - 1];
    if (group && used + block.width <= columns) {
      group.push(block);
      used += block.width;
    } else {
      groups.push([block]);
      used = block.width;
    }
  }
  return groups;
}

/**
 * A band's shelves (step 5). A band that fits on one shelf keeps its scaled
 * positions: each block at its scaled left edge, moved right past the
 * previous block and left so that it and the blocks after it end inside the
 * grid. Otherwise the band wraps over the greedy number of shelves, the
 * blocks spread as evenly as possible by count (earlier shelves take the
 * extra one; greedy when the even split does not fit), and each shelf is
 * justified: spare columns go one at a time to its blocks, left to right.
 */
function bandShelves(blocks: readonly Block[], columns: number): Shelf[] {
  const total = blocks.reduce((sum, block) => sum + block.width, 0);
  if (total <= columns) {
    let end = 0;
    let rest = total;
    const placed: Shelf["blocks"] = [];
    for (const block of blocks) {
      const x = Math.min(Math.max(block.left, end), columns - rest);
      placed.push({ x, block });
      end = x + block.width;
      rest -= block.width;
    }
    return [shelfOf(placed)];
  }
  const greedy = greedyGroups(blocks, columns);
  const count = greedy.length;
  const base = Math.floor(blocks.length / count);
  const extra = blocks.length % count;
  const even: Block[][] = [];
  let at = 0;
  for (let shelf = 0; shelf < count; shelf++) {
    const size = base + (shelf < extra ? 1 : 0);
    even.push(blocks.slice(at, at + size));
    at += size;
  }
  const fits = even.every(
    (group) => group.reduce((sum, block) => sum + block.width, 0) <= columns,
  );
  return (fits ? even : greedy).map((group) => {
    const used = group.reduce((sum, block) => sum + block.width, 0);
    const spare = columns - used;
    const widths = group.map(
      (block, i) =>
        block.width +
        Math.floor(spare / group.length) +
        (i < spare % group.length ? 1 : 0),
    );
    let x = 0;
    const placed: Shelf["blocks"] = group.map((block, i) => {
      const entry = { x, block: { ...block, width: widths[i]! } };
      x += widths[i]!;
      return entry;
    });
    return shelfOf(placed);
  });
}

function shelfOf(blocks: Shelf["blocks"]): Shelf {
  return {
    height: blocks.reduce(
      (max, entry) => Math.max(max, blockHeight(entry.block)),
      0,
    ),
    blocks,
  };
}

/**
 * The auto layout of a slide in format `to`, from its widgets placed in the
 * primary format `from` (ADR 0017, section 3): one or more pages, each a
 * list of placements in reading order. Every widget is placed exactly once,
 * at least its minimum size, inside the grid, without overlap; overflow
 * becomes continuation pages, never a smaller or dropped widget. When `to`
 * is `from` the result is the primary layout as one page. A slide without
 * widgets is one empty page.
 */
export function reflowSlide(
  widgets: readonly LayoutWidget[],
  from: ScreenFormat,
  to: ScreenFormat,
): LayoutPlacement[][] {
  if (from === to) {
    return [
      studioReadingOrder(widgets).map(({ id, x, y, w, h }) => ({
        id,
        x,
        y,
        w,
        h,
      })),
    ];
  }
  const target = SCREEN_FORMATS[to];
  // Steps 1–5: bands of stacks, sized, laid out on shelves.
  const shelves = bandsAndStacks(widgets).flatMap((stacks) =>
    bandShelves(
      stacks.flatMap((stack) => stackBlocks(stack, from, to)),
      target.columns,
    ),
  );
  // Step 7: shelves top to bottom, a new page when one does not fit.
  const pages: Shelf[][] = [];
  let used = 0;
  for (const shelf of shelves) {
    const page = pages[pages.length - 1];
    if (page && used + shelf.height <= target.rows) {
      page.push(shelf);
      used += shelf.height;
    } else {
      pages.push([shelf]);
      used = shelf.height;
    }
  }
  if (pages.length === 0) return [[]];
  return pages.map((page) => placePage(page, target.rows));
}

/**
 * Steps 6 and 8 for one page: spare rows go to the shelves one at a time,
 * top to bottom, repeating, each growing by at most half its height; what
 * is left centres the page (offset rounded down). Within a shelf every
 * stack is stretched to the shelf height, the extra rows going to its last
 * widget.
 */
function placePage(page: readonly Shelf[], rows: number): LayoutPlacement[] {
  const heights = page.map((shelf) => shelf.height);
  const limits = page.map((shelf) => Math.floor(shelf.height / 2));
  const grown = page.map(() => 0);
  let spare = rows - heights.reduce((sum, h) => sum + h, 0);
  let growing = true;
  while (spare > 0 && growing) {
    growing = false;
    for (let i = 0; i < page.length && spare > 0; i++) {
      if (grown[i]! < limits[i]!) {
        grown[i]! += 1;
        spare -= 1;
        growing = true;
      }
    }
  }
  let y = Math.floor(spare / 2);
  const placements: LayoutPlacement[] = [];
  page.forEach((shelf, i) => {
    const height = heights[i]! + grown[i]!;
    for (const { x, block } of shelf.blocks) {
      let top = y;
      const last = block.members.length - 1;
      block.members.forEach((member, m) => {
        const h = m === last ? y + height - top : member.h;
        placements.push({ id: member.id, x, y: top, w: block.width, h });
        top += h;
      });
    }
    y += height;
  });
  return placements;
}

// ---------------------------------------------------------------------------
// Layout of a slide in a format

/**
 * The pages a screen of `format` shows for a slide: the primary layout, the
 * custom layout when there is one (hidden widgets left out), else the auto
 * reflow. Pages with nothing visible are kept, so page numbers stay those of
 * the layout.
 */
export function slideLayoutFor(input: {
  widgets: readonly LayoutWidget[];
  primaryFormat: ScreenFormat;
  format: ScreenFormat;
  custom?: CustomLayout | null;
}): LayoutPlacement[][] {
  const { widgets, primaryFormat, format, custom } = input;
  if (format === primaryFormat || !custom) {
    return reflowSlide(widgets, primaryFormat, format);
  }
  const pages: LayoutPlacement[][] = Array.from(
    { length: Math.max(1, custom.pages) },
    () => [],
  );
  for (const placement of custom.placements) {
    if (placement.hidden) continue;
    pages[placement.page]?.push({
      id: placement.id,
      x: placement.x,
      y: placement.y,
      w: placement.w,
      h: placement.h,
    });
  }
  return pages.map((page) => studioReadingOrder(page));
}

// ---------------------------------------------------------------------------
// Custom layouts (section 4)

export type CustomLayoutProblemCode =
  /** `pages` is not a whole number from 1 to 8. */
  | "invalid_page_count"
  /** A placement's page is not one of the layout's pages. */
  | "page_out_of_range"
  /** A placement is outside the format's grid. */
  | "widget_out_of_bounds"
  /** A placement is below its widget type's minimum size. */
  | "widget_too_small"
  /** Two visible placements on one page overlap. */
  | "widgets_overlap"
  /** A widget of the slide has no placement (neither placed nor hidden). */
  | "widget_missing"
  /** A widget has more than one placement. */
  | "widget_duplicated"
  /** A placement names a widget the slide does not have. */
  | "unknown_widget";

export interface CustomLayoutProblem {
  code: CustomLayoutProblemCode;
  /** The widget concerned (the later one for an overlap). */
  widgetId: string | null;
}

/**
 * Why a custom layout is not valid for the slide's widgets in `format`, in
 * a stable order (empty when valid): pages from 1 to 8, every widget placed
 * exactly once or hidden, visible placements inside the grid, at least
 * their minimum size and not overlapping on their page. Hidden placements
 * are only checked for their page; their cells are kept so that showing the
 * widget again restores them.
 *
 * `widget_missing` and `unknown_widget` describe a layout that predates a
 * primary change; `completeCustomLayout` resolves both.
 */
export function validateCustomLayout(
  custom: CustomLayout,
  widgets: readonly LayoutWidget[],
  format: ScreenFormat,
): CustomLayoutProblem[] {
  const problems: CustomLayoutProblem[] = [];
  const pagesValid =
    Number.isInteger(custom.pages) &&
    custom.pages >= 1 &&
    custom.pages <= CUSTOM_LAYOUT_MAX_PAGES;
  if (!pagesValid) {
    problems.push({ code: "invalid_page_count", widgetId: null });
  }
  const byId = new Map(widgets.map((widget) => [widget.id, widget]));
  const seen = new Set<string>();
  const visible: CustomPlacement[] = [];
  for (const placement of custom.placements) {
    const widget = byId.get(placement.id);
    if (widget === undefined) {
      problems.push({ code: "unknown_widget", widgetId: placement.id });
      continue;
    }
    if (seen.has(placement.id)) {
      problems.push({ code: "widget_duplicated", widgetId: placement.id });
      continue;
    }
    seen.add(placement.id);
    if (
      !Number.isInteger(placement.page) ||
      placement.page < 0 ||
      placement.page >= (pagesValid ? custom.pages : CUSTOM_LAYOUT_MAX_PAGES)
    ) {
      problems.push({ code: "page_out_of_range", widgetId: placement.id });
      continue;
    }
    if (placement.hidden) continue;
    if (!isInsideFormatGrid(placement, format)) {
      problems.push({ code: "widget_out_of_bounds", widgetId: placement.id });
      continue;
    }
    const minimum = minimumOf(widget);
    if (placement.w < minimum.w || placement.h < minimum.h) {
      problems.push({ code: "widget_too_small", widgetId: placement.id });
      continue;
    }
    if (
      visible.some(
        (other) =>
          other.page === placement.page && placementsOverlap(other, placement),
      )
    ) {
      problems.push({ code: "widgets_overlap", widgetId: placement.id });
      continue;
    }
    visible.push(placement);
  }
  for (const widget of widgets) {
    if (!seen.has(widget.id)) {
      problems.push({ code: "widget_missing", widgetId: widget.id });
    }
  }
  return problems;
}

/** The first free spot of this size on a page, row by row, or null. */
function freeSpot(
  occupied: readonly StudioPlacement[],
  w: number,
  h: number,
  format: ScreenFormat,
): { x: number; y: number } | null {
  const { columns, rows } = SCREEN_FORMATS[format];
  for (let y = 0; y + h <= rows; y++) {
    for (let x = 0; x + w <= columns; x++) {
      const spot = { x, y, w, h };
      if (!occupied.some((other) => placementsOverlap(other, spot))) {
        return { x, y };
      }
    }
  }
  return null;
}

/**
 * A custom layout brought in line with the primary (ADR 0017, section 4),
 * as the server runs it on every save:
 *
 * - Placements of widgets the slide no longer has are removed; the hole
 *   stays. Duplicates keep their first placement.
 * - Placements the user made stay as they are (moves and resizes in the
 *   primary change nothing), hidden ones included.
 * - A visible placement that is no longer valid (below its type's minimum
 *   after a type change, outside the grid or its pages, or overlapping one
 *   kept before it in reading order) is re-placed as if added. A hidden
 *   widget on a page that no longer exists stays hidden, on page 1.
 * - A widget without a placement (added to the primary or moved to this
 *   slide) is placed automatically, in reading order: at the first free
 *   spot of its auto-reflowed size, else of its minimum size, on the page
 *   of its reading-order neighbour (the previous visible widget, else the
 *   next, else page 1), else at the top of a new last page. With all 8
 *   pages in use it takes the first free spot of its minimum size on any
 *   page, and failing that it is hidden; either way it is flagged.
 *
 * Re-placed and added widgets are flagged `autoPlaced`; other flags are
 * kept. The result lists placements in the primary's reading order.
 */
export function completeCustomLayout(
  custom: CustomLayout,
  primary: { format: ScreenFormat; widgets: readonly LayoutWidget[] },
  format: ScreenFormat,
): CustomLayout {
  const order = studioReadingOrder(primary.widgets);
  const byId = new Map<string, CustomPlacement>();
  for (const placement of custom.placements) {
    if (!byId.has(placement.id)) byId.set(placement.id, placement);
  }
  let pages = Number.isInteger(custom.pages)
    ? Math.min(Math.max(custom.pages, 1), CUSTOM_LAYOUT_MAX_PAGES)
    : 1;

  // Keep what is still valid, in reading order.
  const kept = new Map<string, CustomPlacement>();
  for (const widget of order) {
    const placement = byId.get(widget.id);
    if (!placement) continue;
    const pageValid =
      Number.isInteger(placement.page) &&
      placement.page >= 0 &&
      placement.page < pages;
    if (placement.hidden) {
      // Hidden stays hidden; a page that no longer exists becomes the first.
      kept.set(widget.id, {
        ...placement,
        page: pageValid ? placement.page : 0,
      });
      continue;
    }
    const minimum = minimumOf(widget);
    const valid =
      pageValid &&
      isInsideFormatGrid(placement, format) &&
      placement.w >= minimum.w &&
      placement.h >= minimum.h &&
      ![...kept.values()].some(
        (other) =>
          !other.hidden &&
          other.page === placement.page &&
          placementsOverlap(other, placement),
      );
    if (valid) kept.set(widget.id, { ...placement });
  }

  // Place the rest, in reading order.
  const auto = new Map<string, StudioPlacement>();
  for (const page of reflowSlide(primary.widgets, primary.format, format)) {
    for (const placement of page) auto.set(placement.id, placement);
  }
  const occupiedOn = (page: number) =>
    [...kept.values()].filter(
      (placement) => !placement.hidden && placement.page === page,
    );
  order.forEach((widget, index) => {
    if (kept.has(widget.id)) return;
    const reflowed = auto.get(widget.id)!;
    const minimum = minimumOf(widget);
    const { columns, rows } = SCREEN_FORMATS[format];
    const preferred = {
      w: Math.min(Math.max(reflowed.w, minimum.w), columns),
      h: Math.min(Math.max(reflowed.h, minimum.h), rows),
    };
    const sizes = [
      preferred,
      ...(preferred.w !== minimum.w || preferred.h !== minimum.h
        ? [minimum]
        : []),
    ];
    const neighbour =
      order
        .slice(0, index)
        .reverse()
        .map((other) => kept.get(other.id))
        .find((placement) => placement && !placement.hidden) ??
      order
        .slice(index + 1)
        .map((other) => kept.get(other.id))
        .find((placement) => placement && !placement.hidden);
    const page = neighbour ? neighbour.page : 0;
    const place = (on: number, size: { w: number; h: number }) => {
      const spot = freeSpot(occupiedOn(on), size.w, size.h, format);
      if (!spot) return false;
      kept.set(widget.id, {
        id: widget.id,
        page: on,
        ...spot,
        ...size,
        hidden: false,
        autoPlaced: true,
      });
      return true;
    };
    if (sizes.some((size) => place(page, size))) return;
    if (pages < CUSTOM_LAYOUT_MAX_PAGES) {
      pages += 1;
      if (place(pages - 1, sizes[0]!)) return;
    }
    for (let on = 0; on < pages; on++) {
      if (place(on, minimum)) return;
    }
    kept.set(widget.id, {
      id: widget.id,
      page: 0,
      x: 0,
      y: 0,
      w: minimum.w,
      h: minimum.h,
      hidden: true,
      autoPlaced: true,
    });
  });

  return {
    pages,
    placements: order.map((widget) => kept.get(widget.id)!),
  };
}

// ---------------------------------------------------------------------------
// Display modes (section 5)

export type DisplayMode = "scroll" | "screen";

export const DISPLAY_MODES: readonly DisplayMode[] = ["screen", "scroll"];

export function isDisplayMode(value: unknown): value is DisplayMode {
  return value === "screen" || value === "scroll";
}

/**
 * The display mode a screen starts in: an Apple TV is always screen view; a
 * paired kiosk follows its device setting (screen view by default); a
 * signed-in browser uses scroll view on compact and regular screens with a
 * coarse primary pointer (phones, tablets), else screen view.
 */
export function defaultDisplayMode(screen: {
  kind: "tvos" | "kiosk" | "browser";
  sizeClass: ScreenSizeClass;
  coarsePointer: boolean;
  deviceMode?: DisplayMode | null;
}): DisplayMode {
  switch (screen.kind) {
    case "tvos":
      return "screen";
    case "kiosk":
      return screen.deviceMode ?? "screen";
    case "browser":
      return screen.sizeClass !== "large" && screen.coarsePointer
        ? "scroll"
        : "screen";
  }
}

// ---------------------------------------------------------------------------
// Scroll view layout (section 5)

/** Scroll view content is at most this wide (CSS px), centred. */
export const SCROLL_MAX_CONTENT_WIDTH = 1200;

/** A widget card's height rule in scroll view. */
export type ScrollItemHeight =
  /** Fits its content (metrics, text, clocks). */
  | "content"
  /** 16:9 of its width, at least `SCROLL_CHART_MIN_HEIGHT`. */
  | "chart"
  /** Keeps the image's aspect, at most half the viewport height. */
  | "image";

export const SCROLL_CHART_MIN_HEIGHT = 200;

export interface ScrollItem {
  id: string;
  type: StudioWidgetType;
  /** 0-based row of the flow. */
  row: number;
  /** 0-based first column. */
  column: number;
  /** Columns spanned: 1 or all. */
  span: number;
  height: ScrollItemHeight;
}

export interface ScrollLayout {
  columns: number;
  /** The content width: the viewport width, at most 1200. */
  contentWidth: number;
  items: ScrollItem[];
}

/** Scroll view columns: 1 below 600 px, 2 below 1024, else 3. */
export function scrollColumns(width: number): number {
  if (!(width >= 600)) return 1;
  return width < 1024 ? 2 : 3;
}

/**
 * One slide's section in scroll view, for a viewport `width` CSS px wide:
 * every widget (clocks included), in the primary layout's reading order,
 * flowing over the columns without reordering. Line and bar charts, and
 * text, image and table widgets at least 6 columns wide in the primary
 * (ADR 0019 section 2), span the row (after a half-filled row, which keeps
 * its gap); everything else takes one column. A table's height fits all
 * its `limit` rows.
 */
export function scrollLayout(
  widgets: readonly LayoutWidget[],
  width: number,
): ScrollLayout {
  const columns = scrollColumns(width);
  const items: ScrollItem[] = [];
  let row = 0;
  let column = 0;
  for (const widget of studioReadingOrder(widgets)) {
    const full =
      widget.type === "line" ||
      widget.type === "bar" ||
      ((widget.type === "text" ||
        widget.type === "image" ||
        widget.type === "table") &&
        widget.w >= 6);
    const span = full ? columns : 1;
    if (column > 0 && column + span > columns) {
      row += 1;
      column = 0;
    }
    items.push({
      id: widget.id,
      type: widget.type,
      row,
      column,
      span,
      height:
        widget.type === "line" || widget.type === "bar"
          ? "chart"
          : widget.type === "image"
            ? "image"
            : "content",
    });
    column += span;
    if (column >= columns) {
      row += 1;
      column = 0;
    }
  }
  return {
    columns,
    contentWidth: Math.max(0, Math.min(width, SCROLL_MAX_CONTENT_WIDTH)),
    items,
  };
}

/** The module as one object, alongside `studioLayout`. */
export const screenLayout = {
  studioReadingOrder,
  reflowSlide,
  slideLayoutFor,
  validateCustomLayout,
  completeCustomLayout,
  defaultDisplayMode,
  scrollColumns,
  scrollLayout,
} as const;
