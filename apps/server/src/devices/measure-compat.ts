// Screens that predate a total with its split (#784): netrics TV builds up
// to 0.3.2 draw a measure value view as its first row, so a linked
// product's downloads ("App Store 412 · Google Play 223") would read as the
// App Store's alone. A client that draws the split says so with
// `?features=measure_split`; every other client gets such widgets as a
// plain value: the total, ungrouped, with the least fresh source's
// freshness (which older clients show anyway).

/** The device payload features a client can ask for: a total with its
 * split (#784), the latest-items widget (#810) and the state widget (#875,
 * both in items-compat.ts). */
export const DEVICE_FEATURES = ["measure_split", "items", "state"] as const;
export type DeviceFeature = (typeof DEVICE_FEATURES)[number];

/** `?features=a,b` as the known features it names; unknown ones are ignored. */
export function deviceFeatures(raw: string | undefined): Set<DeviceFeature> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((feature) => feature.trim())
      .filter((feature): feature is DeviceFeature =>
        (DEVICE_FEATURES as readonly string[]).includes(feature),
      ),
  );
}

type Json = Record<string, unknown>;

/**
 * A slide payload (schema 2 or 3) with every grouped value view made a
 * plain value for clients without `measure_split`: no grouping, one row of
 * the total (none where a total makes no sense: screens show "—"), no
 * `totals`, no per-source freshness. Its version gets a suffix, so the
 * two forms never share an ETag. Unchanged (the same object) when the
 * payload has no such widget.
 */
export function withoutMeasureSplits<P extends object>(payload: P): P {
  const slides = (payload as { slides?: unknown }).slides;
  if (!Array.isArray(slides)) return payload;
  let changed = false;
  const next = slides.map((slide: Json) => {
    if (!Array.isArray(slide.widgets)) return slide;
    const widgets = slide.widgets.map((widget: Json) => {
      const options = widget.options as Json | undefined;
      const groupBy = widget.groupBy as unknown[] | undefined;
      if (
        widget.type !== "measure" ||
        options?.view !== "value" ||
        !groupBy?.length
      )
        return widget;
      changed = true;
      const data = { ...(widget.data as Json) };
      const measureId = (widget.measureIds as string[] | undefined)?.[0];
      const totals = data.totals as Json[] | undefined;
      const { totals: _totals, ...rest } = data;
      const result = data.result as Json | null | undefined;
      const freshness = data.freshness as Json | undefined;
      const { sources: _sources, ...leastFresh } = freshness ?? {};
      const rows =
        totals?.length === 1 && measureId
          ? [{ dimensions: {}, measures: { [measureId]: totals[0] } }]
          : [];
      return {
        ...widget,
        groupBy: [],
        data: {
          ...rest,
          ...(result
            ? {
                result: {
                  ...result,
                  groupBy: [],
                  rows,
                  totalRows: rows.length,
                },
              }
            : {}),
          ...(freshness ? { freshness: leastFresh } : {}),
        },
      };
    });
    return { ...slide, widgets };
  });
  if (!changed) return payload;
  const version = (payload as { version?: unknown }).version;
  return {
    ...payload,
    ...(typeof version === "string" ? { version: `${version}.v` } : {}),
    slides: next,
  };
}
