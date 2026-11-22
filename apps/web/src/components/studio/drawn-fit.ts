"use client";
import { useLayoutEffect, useRef, useState } from "react";

// The last reporting day (#791, ADR 0025 section 8) is named only where
// that costs no part of the line a tile shows with the plain wording. The
// layout picks the wording from estimated glyph widths; the browser draws
// the real ones. These hooks check what was drawn and fall back.

/** Whether an element's text is drawn wider than its box, or on more lines. */
function overflows(element: HTMLElement): boolean {
  const range = document.createRange();
  range.selectNodeContents(element);
  const text = range.getBoundingClientRect();
  const box = element.getBoundingClientRect();
  return text.width > box.width + 0.5 || text.height > box.height * 1.5;
}

const widthOf = (element: HTMLElement) => element.getBoundingClientRect().width;

/**
 * For a line shown with the day named because the estimate says it fits:
 * true once the browser drew it cut (an ellipsis, a wrapped line), so the
 * caller shows the plain line of the same parts instead, which is what the
 * tile showed before. `named` is the named text, null when the plain one
 * is shown anyway; `elements` are the lines as drawn. Checked before paint,
 * again when the box changes width and when the fonts have loaded.
 */
export function useDrawnCut(
  named: string | null,
  elements: () => readonly (HTMLElement | null)[],
): boolean {
  const [cut, setCut] = useState<string | null>(null);
  const fallback = named !== null && cut === named;
  const get = useRef(elements);
  get.current = elements;
  useLayoutEffect(() => {
    if (named === null) return;
    const lines = get.current().filter((line) => line !== null);
    if (lines.length === 0) return;
    let alive = true;
    const check = () => {
      if (alive && !fallback && lines.some(overflows)) setCut(named);
    };
    check();
    let widths = lines.map(widthOf);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            const now = lines.map(widthOf);
            if (now.every((width, i) => Math.abs(width - widths[i]!) <= 0.5))
              return;
            widths = now;
            // A new width: try the named line again.
            if (fallback) setCut(null);
            else check();
          });
    for (const line of lines) observer?.observe(line);
    void document.fonts?.ready.then(check);
    return () => {
      alive = false;
      observer?.disconnect();
    };
  }, [named, fallback]);
  return fallback;
}

/** The parts of a line of parts on its first, visible line. */
function firstLineParts(line: HTMLElement): number {
  const parts = [...line.children] as HTMLElement[];
  const top = parts[0]?.offsetTop;
  return parts.filter((part) => part.offsetTop === top).length;
}

/**
 * For a line of parts that drops those that do not fit (a measure tile's
 * freshness line): whether to show it with the day named. `line` shows one
 * wording, `probe` (out of sight, given the line's width here) the other.
 * Named only when it shows as many parts as the plain wording does, as
 * drawn; false until measured, so a tile never shows fewer parts than
 * before. `enabled`: there is a named wording at all.
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
        ? [firstLineParts(drawn), firstLineParts(other)]
        : [firstLineParts(other), firstLineParts(drawn)];
      const next = namedParts > 0 && namedParts >= plainParts;
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
