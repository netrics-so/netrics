import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

// Keeping the keyboard focus when an update takes it away (#854).
//
// One rule: the focus is moved by script only when an update removed or
// disabled the element that HAD it, so that it fell to the page. Then it
// goes to what took that element's place. Someone who moved the focus
// elsewhere keeps their place, and so does a focus the update left alone.
//
// One mechanism, without timing assumptions: where the focus is is learned
// from the browser's own focus and blur events, never sampled around an
// update, and
// every change of the region is looked at when it has happened, whoever
// made it (a click here, an answer from the server, a refresh of the page).

/** What a region's keeper remembers: the element in it that has the focus. */
export interface FocusMemory<Zone> {
  /** The focused element while the focus is inside the region, else null. */
  last: Element | null;
  /** What `zoneOf` said about it when it got the focus. */
  zone: Zone | undefined;
}

export function emptyFocusMemory<Zone>(): FocusMemory<Zone> {
  return { last: null, zone: undefined };
}

/**
 * A focus event anywhere in the document: an element of the region is
 * remembered (with its zone, asked while it is still in place), one
 * outside it means the user has left and nothing is owed.
 */
export function focusMoved<Zone>(
  memory: FocusMemory<Zone>,
  target: Element | null,
  region: Element | null | undefined,
  zoneOf?: (element: Element) => Zone,
): void {
  if (target && region?.contains(target)) {
    memory.last = target;
    memory.zone = zoneOf?.(target);
  } else {
    memory.last = null;
    memory.zone = undefined;
  }
}

/**
 * The remembered element lost the focus. If it is still in place and
 * usable, the user took the focus away (a click on text of the page gives
 * it to nothing, with no focus event to follow), and nothing is owed. A
 * blur of an element that is gone or disabled is the update's doing, and
 * is kept for `focusWasTaken`; so is one that moves within the region,
 * which the focus event that follows records.
 */
export function focusLeft<Zone>(
  memory: FocusMemory<Zone>,
  target: Element | null,
  related: Element | null,
  region: Element | null | undefined,
): void {
  const { last } = memory;
  if (!last || target !== last) return;
  if (!last.isConnected || last.matches(":disabled")) return;
  if (related && region?.contains(related)) return;
  memory.last = null;
  memory.zone = undefined;
}

/**
 * Whether an update took the focus away: the remembered element is gone
 * from the page or disabled, and the focus is on nothing (the page itself,
 * or still nominally on that element, as right after it was disabled).
 * A remembered element that is still there and usable is no loss, whatever
 * has the focus: the user clicked on the page, or the window is elsewhere.
 */
export function focusWasTaken<Zone>(
  memory: FocusMemory<Zone>,
  active: Element | null,
  body: Element | null,
): boolean {
  const { last } = memory;
  if (!last) return false;
  const gone = !last.isConnected || last.matches(":disabled");
  return gone && (active === null || active === body || active === last);
}

/**
 * Keeps the focus inside `region` (an element that stays mounted with the
 * component) when an update removes or disables the focused element in
 * it: the focus then goes to `target(zone)`, looked up after the update;
 * `zone` is what `zoneOf` said about the lost element when it was focused
 * (where in the region it was). No target, or one that cannot take the
 * focus, leaves it where it is. Each loss is handled once.
 */
export function useFocusKeeper<Zone = undefined>(
  region: RefObject<Element | null>,
  target: (zone: Zone | undefined) => HTMLElement | null | undefined,
  zoneOf?: (element: Element) => Zone,
): void {
  const memory = useRef<FocusMemory<Zone>>(emptyFocusMemory());
  const latest = useRef({ target, zoneOf });
  // In the commit itself: the region's changes are looked at right after
  // it (a microtask), with this update's `target`, not the one before.
  useLayoutEffect(() => {
    latest.current = { target, zoneOf };
  });
  const check = useRef(() => {
    const state = memory.current;
    if (!focusWasTaken(state, document.activeElement, document.body)) return;
    const zone = state.zone;
    memory.current = emptyFocusMemory();
    latest.current.target(zone)?.focus();
  });
  useEffect(() => {
    const element = region.current;
    if (!element) return;
    const onFocusIn = (event: FocusEvent) =>
      focusMoved(
        memory.current,
        event.target instanceof Element ? event.target : null,
        element,
        latest.current.zoneOf,
      );
    // Judged once the event's cause has finished, not in the event: a
    // browser may send the blur of an element that is being removed while
    // it is still in the page, and only afterwards is it gone.
    const onFocusOut = (event: FocusEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const related =
        event.relatedTarget instanceof Element ? event.relatedTarget : null;
      queueMicrotask(() => {
        if (document.activeElement === target) return;
        focusLeft(memory.current, target, related, element);
      });
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    // Already inside when the keeper starts.
    if (document.activeElement && element.contains(document.activeElement))
      focusMoved(
        memory.current,
        document.activeElement,
        element,
        latest.current.zoneOf,
      );
    // Every change of the region, also one this component did not render.
    const observer = new MutationObserver(() => check.current());
    observer.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled"],
    });
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      observer.disconnect();
    };
  }, [region]);
  // And after each of its own updates.
  useLayoutEffect(() => check.current());
}
