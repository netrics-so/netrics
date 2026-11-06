"use client";

import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type RefObject,
} from "react";

import {
  EnterClock,
  countUpText,
  enterMotionAllowed,
  rowRiseProgress,
} from "@/lib/enter-motion";

/**
 * The enter clock of the slide a widget is on; null where nothing enters
 * (the Studio canvas, theme previews, the scroll view, server renders).
 */
const SlideEnterContext = createContext<EnterClock | null>(null);

export const SlideEnterProvider = SlideEnterContext.Provider;

/**
 * A player slide's enter clock: every time the slide becomes the active
 * one (the first paint included) it runs the enter on `ref`'s element,
 * unless motion is reduced or the page is hidden; an inactive slide shows
 * its final state. Started in a layout effect, so frame 0 is on screen
 * before the browser paints the new slide.
 */
export function useSlideEnter(
  active: boolean,
  ref: RefObject<HTMLElement | null>,
): EnterClock {
  const [clock] = useState(() => new EnterClock());
  useLayoutEffect(() => {
    const element = ref.current;
    if (active && element && enterMotionAllowed()) {
      clock.start(element);
    } else {
      clock.finish();
    }
  }, [active, clock, ref]);
  useLayoutEffect(() => () => clock.finish(), [clock]);
  return clock;
}

/**
 * Lets the rows under `ref` (marked `data-rise`) rise into place while the
 * slide enters (ADR 0019 section 2): each row's eased progress as
 * `--rise-p`, which the CSS turns into a 14 unit rise and a fade. Without
 * the slide's clock (the Studio canvas, reduced motion) nothing is set and
 * the rows are at rest.
 */
export function useRowRise(ref: RefObject<HTMLElement | null>): void {
  const clock = useContext(SlideEnterContext);
  useLayoutEffect(() => {
    if (!clock) return;
    // The rows may arrive after the enter started (their data loads): the
    // element is looked up on every frame, so they join in mid-enter.
    return clock.subscribe((t) => {
      const element = ref.current;
      if (!element) return;
      element.querySelectorAll<HTMLElement>("[data-rise]").forEach((row) => {
        if (t >= 1) {
          row.style.removeProperty("--rise-p");
          return;
        }
        const index = Number(row.dataset.rise ?? 0);
        row.style.setProperty("--rise-p", rowRiseProgress(index, t).toFixed(4));
      });
    });
  }, [clock, ref]);
}

/**
 * Counts `ref`'s text up from zero while the slide enters (ADR 0018
 * section 6): `format` of the counted value on every frame, and exactly
 * `final` (the rendered text) at the end. The server and the first client
 * render have the final text; the DOM text is only rewritten during an
 * enter, so nothing counts without the slide's clock.
 */
export function useCountUp(
  ref: RefObject<HTMLElement | null>,
  value: number | null,
  format: ((value: number) => string) | null,
  final: string,
): void {
  const clock = useContext(SlideEnterContext);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (!clock || value === null || !format || !Number.isFinite(value)) {
      if (element.textContent !== final) element.textContent = final;
      return;
    }
    return clock.subscribe((t) => {
      const text = t >= 1 ? final : countUpText(value, t, format, final);
      if (element.textContent !== text) element.textContent = text;
    });
  }, [clock, ref, value, format, final]);
}
