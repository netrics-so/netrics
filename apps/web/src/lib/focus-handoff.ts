/**
 * Whether the keyboard focus is on `region` or inside it right now.
 *
 * The one rule for moving focus by script (#854): an update that removes or
 * replaces a control may hand the focus on only when that control still
 * HAS it, that is, when it would otherwise fall to the page. Ask this just
 * before the update is applied, and move the focus after it only on a yes.
 * Someone who tabbed elsewhere while a request ran keeps their place.
 */
export function holdsFocus(region: Element | null | undefined): boolean {
  if (!region || typeof document === "undefined") return false;
  const active = document.activeElement;
  return active !== null && region.contains(active);
}
