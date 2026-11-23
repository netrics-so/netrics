"use client";
import { useLayoutEffect, useRef, useState } from "react";

// The last reporting day (#791, ADR 0025 section 8) is named only where
// that costs no part of the line a tile shows with the plain wording. The
// layout picks the wording from estimated glyph widths; the browser draws
// the real ones. These hooks check what was drawn and fall back.

/** A drawn box, as `getBoundingClientRect` gives it. */
export interface DrawnBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Sub-pixel layout: an edge may sit half a pixel outside its line. A
 * LAYOUT pixel: the browser wraps a part and ends a text with an ellipsis
 * by its layout, before any transform.
 */
const EDGE = 0.5;

/**
 * Drawn pixels per layout pixel, across and down: 1 unless a transform
 * scales the element (Studio's device preview draws a slide at a fifth of
 * its size and less).
 */
export interface DrawnScale {
  x: number;
  y: number;
}

const UNSCALED: DrawnScale = { x: 1, y: 1 };

/** The scale an element is drawn at: its drawn box over its layout box. */
function drawnScale(element: HTMLElement): DrawnScale {
  const box = element.getBoundingClientRect();
  const { offsetWidth, offsetHeight } = element;
  return {
    x: offsetWidth > 0 && box.width > 0 ? box.width / offsetWidth : 1,
    y: offsetHeight > 0 && box.height > 0 ? box.height / offsetHeight : 1,
  };
}

/**
 * Whether a piece of a line (a part, or its text as laid out) is fully
 * visible: its box inside the line's clip box on all four sides. A piece
 * that runs past the right edge is cut (clipped, or ended by an
 * ellipsis); one wrapped onto a further line, or taller than the line, is
 * cut at the bottom. The one definition for every drawn check here.
 *
 * Both boxes are drawn rects (`getBoundingClientRect`) of elements under
 * the same transform; `scale` is what that transform draws a layout pixel
 * at, so the half pixel of tolerance is a layout one on every side. At a
 * fifth of the size, two layout pixels over are 0.4 drawn pixels and cut.
 */
export function fullyVisible(
  piece: DrawnBox,
  line: DrawnBox,
  scale: DrawnScale = UNSCALED,
): boolean {
  const x = EDGE * scale.x;
  const y = EDGE * scale.y;
  return (
    piece.left >= line.left - x &&
    piece.right <= line.right + x &&
    piece.top >= line.top - y &&
    piece.bottom <= line.bottom + y
  );
}

/**
 * Whether the named wording may replace the plain one, by which parts of
 * each are fully visible: the named line must show whole every part the
 * plain line shows whole, and its first part (the day) at all. A set, not
 * a count: showing as many parts is not enough when one of them is cut.
 */
export function namedKeepsEveryPart(
  named: readonly boolean[],
  plain: readonly boolean[],
): boolean {
  return (
    named[0] === true &&
    plain.every((whole, index) => !whole || named[index] === true)
  );
}

/** Which parts (children) of a line of parts are fully visible. */
function visibleParts(line: HTMLElement): boolean[] {
  const box = line.getBoundingClientRect();
  const scale = drawnScale(line);
  return [...line.children].map((part) =>
    fullyVisible(part.getBoundingClientRect(), box, scale),
  );
}

/**
 * The extent of a text as rendered, for `fullyVisible`, from the rects of
 * its runs (a `Range` over it): their union across, and down the middle
 * two thirds of their union.
 *
 * Why not all of it down: a run's rect is the font's own box, taller than
 * the text's ink and than a tight line. On an ordinary footer it reaches
 * about a pixel past the line's box above and below, for the named and
 * the plain wording alike, so the whole rect would call every footer cut.
 * The middle two thirds is the body of the text. One mechanism for both
 * ways a line is cut at the bottom: a line taller than its box (a browser
 * minimum font size in a tile that flex has shrunk), and a text wrapped
 * onto further lines, whose union is at least two lines high. Null
 * without text.
 */
export function textExtent(runs: readonly DrawnBox[]): DrawnBox | null {
  if (runs.length === 0) return null;
  const top = Math.min(...runs.map((run) => run.top));
  const bottom = Math.max(...runs.map((run) => run.bottom));
  const sixth = (bottom - top) / 6;
  return {
    left: Math.min(...runs.map((run) => run.left)),
    right: Math.max(...runs.map((run) => run.right)),
    top: top + sixth,
    bottom: bottom - sixth,
  };
}

/** Whether all of an element's text is fully visible in its box. */
function textVisible(element: HTMLElement): boolean {
  const range = document.createRange();
  range.selectNodeContents(element);
  const text = textExtent(
    [...range.getClientRects()].filter((run) => run.width > 0),
  );
  return (
    text === null ||
    fullyVisible(text, element.getBoundingClientRect(), drawnScale(element))
  );
}

/** Whether an element's text is drawn cut: past its box, or on more lines. */
const overflows = (element: HTMLElement) => !textVisible(element);

/**
 * How lines are drawn, as far as it decides whether a text fits: each
 * line's box and its font size. The font size is part of it on its own
 * account: a short tile's layout can hold a line's box while its font
 * grows, and the same box is then a different size to fit a text in.
 */
export function sizeKey(
  lines: readonly { width: number; height: number; fontSize: string }[],
): string {
  return lines
    .map(
      (line) =>
        `${line.width.toFixed(1)}x${line.height.toFixed(1)}@${line.fontSize}`,
    )
    .join("|");
}

function drawnSize(lines: readonly HTMLElement[]): string {
  return sizeKey(
    lines.map((line) => {
      const box = line.getBoundingClientRect();
      return {
        width: box.width,
        height: box.height,
        fontSize: getComputedStyle(line).fontSize,
      };
    }),
  );
}

/**
 * The named line was measured at a drawn size. Cut: the size is `seen`,
 * so the plain line shown next is not swapped back at it. Whole: nothing
 * is seen any more. The sizes guard one fallback cycle only, from a cut
 * to the next time the named line fits; a tile narrowed and widened again
 * and again gets its named line back every time.
 */
export function namedMeasured(
  seen: Set<string>,
  size: string,
  cut: boolean,
): void {
  if (cut) seen.add(size);
  else seen.clear();
}

/**
 * Whether to try the named line again at a drawn size, once per size
 * within a fallback cycle: the sizes at which it was found cut, or that
 * showing the plain line led to, are `seen`, and trying again there would
 * only measure the same. This is what makes measure → state → render →
 * measure settle: each size costs at most one more pass, also when
 * showing the other line changes the box.
 */
export function retryAtSize(seen: Set<string>, size: string): boolean {
  if (seen.has(size)) return false;
  seen.add(size);
  return true;
}

/**
 * For a line shown with the day named because the estimate says it fits:
 * true once the browser drew it cut (an ellipsis, a wrapped line), so the
 * caller shows the plain line of the same parts instead, which is what the
 * tile showed before. `named` is the named text, null when the plain one
 * is shown anyway; `elements` are the lines as drawn. Checked before paint
 * and whenever a line's box or font size changes (a resized tile, another
 * theme or font scale, the browser's default font size) or the fonts load.
 * `sentinel` is an element out of sight whose size follows the lines' font
 * (`.sw-font-sentinel`): a line's own box need not change when its font
 * does, and then only the sentinel tells.
 */
export function useDrawnCut(
  named: string | null,
  elements: () => readonly (HTMLElement | null)[],
  sentinel?: () => HTMLElement | null,
): boolean {
  const [cut, setCut] = useState<string | null>(null);
  const fallback = named !== null && cut === named;
  const get = useRef(elements);
  get.current = elements;
  const getSentinel = useRef(sentinel);
  getSentinel.current = sentinel;
  // The drawn sizes already decided for this text (`retryAtSize`).
  const seen = useRef<{ named: string | null; sizes: Set<string> }>({
    named: null,
    sizes: new Set(),
  });
  if (seen.current.named !== named) seen.current = { named, sizes: new Set() };
  useLayoutEffect(() => {
    if (named === null) return;
    const lines = get.current().filter((line) => line !== null);
    if (lines.length === 0) return;
    const sizes = seen.current.sizes;
    let alive = true;
    // With the named line drawn: found cut at this size, the plain one;
    // whole, the cycle is over and its sizes are forgotten.
    const measure = () => {
      if (!alive) return;
      const cut = lines.some(overflows);
      namedMeasured(sizes, drawnSize(lines), cut);
      if (cut) setCut(named);
    };
    // The box or the font size changed: with the plain line drawn, try
    // the named one again, once per size.
    const changed = () => {
      if (!alive) return;
      if (!fallback) measure();
      else if (retryAtSize(sizes, drawnSize(lines))) setCut(null);
    };
    if (fallback) sizes.add(drawnSize(lines));
    else measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(changed);
    for (const line of lines) observer?.observe(line);
    const watched = getSentinel.current?.();
    if (watched) observer?.observe(watched);
    // Loaded fonts change the widths, not the box: one more try.
    void document.fonts?.ready.then(() => {
      if (!alive) return;
      if (!fallback) measure();
      else if (retryAtSize(sizes, "fonts")) setCut(null);
    });
    return () => {
      alive = false;
      observer?.disconnect();
    };
  }, [named, fallback]);
  return fallback;
}

/**
 * For a line of parts that drops those that do not fit (a measure tile's
 * freshness line): whether to show it with the day named. `line` shows one
 * wording, `probe` (out of sight) the other. The stylesheet lays the probe
 * over the line in the same box, so both wordings have the same width by
 * layout: no width is measured and set, which a transform (Studio's scaled
 * device preview) would scale twice. Every rect compared here comes from
 * `getBoundingClientRect` on elements in that one box, so a transform
 * scales both sides of each comparison alike.
 * Named only when it shows whole every part the plain wording shows whole
 * (`namedKeepsEveryPart`), as drawn; false until measured, so a tile never
 * shows less than before. `enabled`: there is a named wording at all.
 */
export function useNamedParts(
  enabled: boolean,
  key: string,
): {
  named: boolean;
  line: React.RefObject<HTMLParagraphElement | null>;
  probe: React.RefObject<HTMLParagraphElement | null>;
} {
  const line = useRef<HTMLParagraphElement>(null);
  const probe = useRef<HTMLParagraphElement>(null);
  const [named, setNamed] = useState(false);
  const shown = enabled && named;
  useLayoutEffect(() => {
    const drawn = line.current;
    const other = probe.current;
    if (!enabled || !drawn || !other) return;
    let alive = true;
    const check = () => {
      if (!alive) return;
      const [namedParts, plainParts] = shown
        ? [visibleParts(drawn), visibleParts(other)]
        : [visibleParts(other), visibleParts(drawn)];
      const next = namedKeepsEveryPart(namedParts, plainParts);
      if (next !== shown) setNamed(next);
    };
    check();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(check);
    observer?.observe(drawn);
    // The probe's height is a line at the font in use: it changes with the
    // font also where the tile's layout holds the line's own box.
    observer?.observe(other);
    void document.fonts?.ready.then(check);
    return () => {
      alive = false;
      observer?.disconnect();
    };
  }, [enabled, shown, key]);
  return { named: shown, line, probe };
}
