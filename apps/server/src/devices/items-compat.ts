// Screens that predate a widget type would drop it, or fail on it: the
// latest-items widget (#810) for netrics TV builds up to 0.3.x and kiosks
// that do not ask with `?features=items`, and the state widget (#875) for
// clients that do not ask with `?features=state`. They get a text widget
// in its place that says to update netrics TV, at the same placement and
// with the widget's label (and, for items, none of the items' images).

import {
  itemsNeedNewerAppText,
  stateNeedNewerAppText,
  STUDIO_MIN_WIDGET_SIZE,
  type Locale,
} from "@netrics/domain";

type Json = Record<string, unknown>;

/** Every `imageId` the value references, at any depth. */
function collectImageIds(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectImageIds(entry, into);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "imageId" && typeof entry === "string") into.add(entry);
    else collectImageIds(entry, into);
  }
}

/**
 * A schema 2/3 payload with each widget of `type` replaced by a text
 * widget at the same placement saying `text` with the widget's label;
 * images referenced only by such widgets are removed from `images`; the
 * version gets `suffix`, so the two forms never share an ETag. The same
 * object when the payload has no such widget.
 */
function withoutWidgetType<P extends object>(
  payload: P,
  type: string,
  text: string,
  suffix: string,
): P {
  const slides = (payload as { slides?: unknown }).slides;
  if (!Array.isArray(slides)) return payload;
  let changed = false;
  const next = slides.map((slide: Json) => {
    if (!Array.isArray(slide.widgets)) return slide;
    const widgets = slide.widgets.map((widget: Json) => {
      if (widget.type !== type) return widget;
      changed = true;
      return {
        type: "text",
        id: widget.id,
        x: widget.x,
        y: widget.y,
        w: widget.w,
        h: widget.h,
        // Schema 3 names each widget's minimum size: the text's.
        ...(widget.min !== undefined
          ? { min: { ...STUDIO_MIN_WIDGET_SIZE.text } }
          : {}),
        label: widget.label ?? null,
        text,
        options: { size: "body", align: "center" },
      };
    });
    return { ...slide, widgets };
  });
  if (!changed) return payload;
  const rest = { ...payload, slides: next } as Json;
  const kept = new Set<string>();
  collectImageIds({ ...rest, images: undefined }, kept);
  const images = (payload as { images?: unknown }).images;
  const version = (payload as { version?: unknown }).version;
  return {
    ...rest,
    ...(Array.isArray(images)
      ? {
          images: images.filter((image: Json) => kept.has(image.id as string)),
        }
      : {}),
    ...(typeof version === "string" ? { version: `${version}${suffix}` } : {}),
  } as P;
}

/**
 * A schema 2/3 payload for clients without `items`: each items widget
 * becomes a text widget with `itemsNeedNewerApp` in the payload's locale;
 * the version gets the suffix "-noitems".
 */
export function withoutItems<P extends object>(payload: P, locale: Locale): P {
  return withoutWidgetType(
    payload,
    "items",
    itemsNeedNewerAppText(locale),
    "-noitems",
  );
}

/**
 * A schema 2/3 payload for clients without `state` (#875): each state
 * widget becomes a text widget with `stateNeedNewerApp` in the payload's
 * locale; the version gets the suffix "-nostate".
 */
export function withoutStates<P extends object>(payload: P, locale: Locale): P {
  return withoutWidgetType(
    payload,
    "state",
    stateNeedNewerAppText(locale),
    "-nostate",
  );
}
