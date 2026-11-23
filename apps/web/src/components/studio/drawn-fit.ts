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

/** Sub-pixel layout: an edge may sit half a pixel outside its line. */
const EDGE = 0.5;

/**
 * Whether a piece of a line (a part, or its text as laid out) is fully
 * visible: its box inside the line's clip box on all four sides. A piece
 * that runs past the right edge is cut (clipped, or ended by an
 * ellipsis); one wrapped onto a further line, or taller than the line, is
 * cut at the bottom. The one definition for every drawn check here.
 */
export function fullyVisible(piece: DrawnBox, line: DrawnBox): boolean {
  return (
    piece.left >= line.left - EDGE &&
    piece.right <= line.right + EDGE &&
    piece.top >= line.top - EDGE &&
    piece.bottom <= line.bottom + EDGE
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
  return [...line.children].map((part) =>
    fullyVisible(part.getBoundingClientRect(), box),
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
  return text === null || fullyVisible(text, element.getBoundingClientRect());
}

/** Whether an element's text is drawn cut: past its box, or on more lines. */
const overflows = (element: HTMLElement) => !textVisible(element);

const widthOf = (element: HTMLElement) => element.getBoundingClientRect().width;

/**
 * How a line is drawn, as far as it decides whether a text fits: its box
 * (a change of font size changes the line box's height) and its font size.
 */
function drawnSize(lines: readonly HTMLElement[]): string {
  return lines
    .map((line) => {
      const box = line.getBoundingClientRect();
      return `${box.width.toFixed(1)}x${box.height.toFixed(1)}@${getComputedStyle(line).fontSize}`;
    })
    .join("|");
}

/**
 * Whether to try the named line again at a drawn size, once per size: the
 * sizes at which it was found cut, or that showing the plain line led to,
 * are `seen`, and trying again there would only measure the same. This is
 * what makes measure → state → render → measure settle: each size costs
 * at most one more pass, also when showing the other line changes the box.
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
 */
export function useDrawnCut(
  named: string | null,
  elements: () => readonly (HTMLElement | null)[],
): boolean {
  const [cut, setCut] = useState<string | null>(null);
  const fallback = named !== null && cut === named;
  const get = useRef(elements);
  get.current = elements;
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
    // With the named line drawn: found cut at this size, the plain one.
    const measure = () => {
      if (!alive || !lines.some(overflows)) return;
      sizes.add(drawnSize(lines));
      setCut(named);
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
 * wording, `probe` (out of sight, given the line's width here) the other.
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
      other.style.width = `${widthOf(drawn)}px`;
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
    void document.fonts?.ready.then(check);
    return () => {
      alive = false;
      observer?.disconnect();
    };
  }, [enabled, shown, key]);
  return { named: shown, line, probe };
}
