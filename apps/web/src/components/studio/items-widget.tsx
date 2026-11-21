"use client";

import { useEffect, useRef, useState } from "react";

import type {
  DashboardWidget,
  ItemsWidgetData,
  ItemsWidgetOptions,
} from "@netrics/contracts";
import {
  formatDataDate,
  itemsWidgetLabel,
  STUDIO_TEXT_MINIMUMS,
} from "@netrics/domain";

import { useLocale, useT } from "@/lib/i18n/client";
import { relativeTimeIn } from "@/lib/relative-time";
import {
  LINE_HEIGHT,
  STACK_GAP,
  contentBox,
  labelLayout,
  typeScaleFor,
  u,
  type ScreenPlacement,
} from "@/lib/studio-render";
import { imageContentUrl, type StudioEnv } from "@/lib/studio-widgets";
import { useViewerTimeZone } from "@/lib/viewer-time-zone";

import { useNow } from "./clock-widget";
import { useDashboardData } from "./dashboard-data-provider";
import { WidgetLabel, WidgetNotice } from "./widget-parts";
import { previewDashboardMeasures } from "@/lib/dashboard-data-api";

// The latest-items widget (#810): the newest records of a model with their
// images, as a grid (the newest first, as many as fit, never more than
// `count`) or one at a time. Images come only from netrics: the Studio and
// the scroll view load the workspace's image URL, the kiosk its blob URL.
// An item without an image shows a themed tile, never a broken image.

export type ItemsWidget = Extract<DashboardWidget, { type: "items" }>;

export interface ItemsWidgetItemView {
  title: string | null;
  subtitle: string | null;
  time: string | null;
  image: { src: string; width: number; height: number } | null;
}

/** The smallest tile of a grid in units: a readable title over an image. */
export const ITEMS_TILE_MIN_WIDTH = 240;
/** The smallest image of a tile in units; a grid adds no row below it. */
export const ITEMS_IMAGE_MIN_HEIGHT = 96;
const ITEMS_GAP = 16;

export interface ItemsGridLayout {
  columns: number;
  rows: number;
  /** Items shown: at most columns × rows and `count`. */
  shown: number;
}

/**
 * How many items a grid shows in a content box (units): columns of at least
 * `ITEMS_TILE_MIN_WIDTH`, rows of an image of at least
 * `ITEMS_IMAGE_MIN_HEIGHT` over the text lines, never more than `count`
 * nor the items there are. Always at least one.
 */
export function itemsGridLayout(input: {
  width: number;
  height: number;
  textHeight: number;
  count: number;
  items: number;
}): ItemsGridLayout {
  const wanted = Math.max(1, Math.min(input.count, input.items));
  const fitColumns = Math.max(
    1,
    Math.floor((input.width + ITEMS_GAP) / (ITEMS_TILE_MIN_WIDTH + ITEMS_GAP)),
  );
  const tile = ITEMS_IMAGE_MIN_HEIGHT + input.textHeight;
  const fitRows = Math.max(
    1,
    Math.floor((input.height + ITEMS_GAP) / (tile + ITEMS_GAP)),
  );
  const columns = Math.min(fitColumns, wanted);
  const rows = Math.min(fitRows, Math.ceil(wanted / columns));
  return { columns, rows, shown: Math.min(wanted, columns * rows) };
}

/** An item's time as shown: a date as the date, a timestamp relative. */
export function itemTime(
  time: string | null,
  locale: string,
  timeZone: string,
  now: number,
): string | null {
  if (!time) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(time))
    return formatDataDate(time, "date", locale, timeZone);
  return relativeTimeIn(time, locale, now, "short") ?? time;
}

/** Whether the element is on screen and the page visible. */
function useOnScreen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const element = ref.current;
    let intersecting = true;
    const update = () =>
      setVisible(
        intersecting &&
          (typeof document === "undefined" ||
            document.visibilityState !== "hidden"),
      );
    const observer =
      typeof IntersectionObserver !== "undefined" && element
        ? new IntersectionObserver((entries) => {
            intersecting = entries.some((entry) => entry.isIntersecting);
            update();
          })
        : null;
    if (observer && element) observer.observe(element);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, [ref]);
  return visible;
}

/**
 * Advances a rotation every `seconds`: calls `onIndex` with the next item's
 * index, wrapping after `length`. Nothing with fewer than two items. The
 * returned function stops it.
 */
export function startRotation(
  length: number,
  seconds: number,
  onIndex: (advance: (index: number) => number) => void,
): () => void {
  if (length < 2) return () => undefined;
  const timer = setInterval(
    () => onIndex((index) => (index + 1) % length),
    seconds * 1000,
  );
  return () => clearInterval(timer);
}

/** The item shown when rotating: advances every `seconds` while visible,
 * never while the slide or page is hidden. */
export function useRotation(
  length: number,
  seconds: number,
  active: boolean,
): number {
  const [index, setIndex] = useState(0);
  useEffect(
    () => (active ? startRotation(length, seconds, setIndex) : undefined),
    [active, length, seconds],
  );
  return length ? index % length : 0;
}

function ItemTile({
  item,
  options,
  sizes,
  timeText,
  noImage,
  imageAlt,
}: {
  item: ItemsWidgetItemView;
  options: ItemsWidgetOptions;
  sizes: { body: number; cell: number };
  timeText: string | null;
  noImage: string;
  imageAlt: string;
}) {
  return (
    <li className="sw-items-tile">
      {item.image ? (
        <img
          className="sw-items-image"
          src={item.image.src}
          alt={item.title ?? imageAlt}
          width={item.image.width}
          height={item.image.height}
          style={{ objectFit: options.imageFit }}
          loading="lazy"
        />
      ) : (
        <div
          className="sw-items-image sw-items-noimage"
          role="img"
          aria-label={noImage}
        />
      )}
      {item.title ? (
        <p
          className="sw-items-title"
          title={item.title}
          style={{ fontSize: u(sizes.body), lineHeight: LINE_HEIGHT }}
        >
          {item.title}
        </p>
      ) : null}
      {item.subtitle ? (
        <p
          className="sw-muted sw-items-subtitle"
          title={item.subtitle}
          style={{ fontSize: u(sizes.cell), lineHeight: LINE_HEIGHT }}
        >
          {item.subtitle}
        </p>
      ) : null}
      {options.showTime && timeText ? (
        <p
          className="sw-muted sw-items-time"
          style={{ fontSize: u(sizes.cell), lineHeight: LINE_HEIGHT }}
          suppressHydrationWarning
        >
          {timeText}
        </p>
      ) : null}
    </li>
  );
}

export function ItemsWidgetView(props: {
  label: string;
  items: readonly ItemsWidgetItemView[];
  options: ItemsWidgetOptions;
  status: "ok" | "no_data";
  placement: ScreenPlacement;
  showHeader: boolean;
  fontScale: number;
  audience?: "editor" | "viewer";
  timeZone?: string;
  /** The query's error code (editor surfaces name it). */
  error?: string | null;
  loading?: boolean;
}) {
  const t = useT("screen.items");
  const locale = useLocale();
  const viewerZone = useViewerTimeZone();
  const timeZone = props.timeZone ?? viewerZone;
  const now = useNow().getTime();
  const ref = useRef<HTMLElement>(null);
  const visible = useOnScreen(ref);
  const box = contentBox(props.placement, props.showHeader);
  const scale = typeScaleFor(
    "items",
    props.placement,
    props.fontScale,
    props.showHeader,
  );
  const sizes = {
    body: scale.body ?? STUDIO_TEXT_MINIMUMS.body,
    cell: scale.cell ?? STUDIO_TEXT_MINIMUMS.cell,
  };
  const label = labelLayout(props.label, box.width, scale);
  const textHeight =
    sizes.body * LINE_HEIGHT +
    (props.items.some((item) => item.subtitle) ? sizes.cell * LINE_HEIGHT : 0) +
    (props.options.showTime ? sizes.cell * LINE_HEIGHT : 0);
  const grid = itemsGridLayout({
    width: box.width,
    height: box.height - label.height - STACK_GAP,
    textHeight,
    count: props.options.count,
    items: props.items.length,
  });
  const rotating = props.options.layout === "rotate";
  const index = useRotation(
    rotating ? Math.min(props.items.length, props.options.count) : 0,
    props.options.rotateSeconds,
    visible,
  );
  const shown = rotating
    ? props.items.slice(index, index + 1)
    : props.items.slice(0, grid.shown);
  const tile = (item: ItemsWidgetItemView, key: number) => (
    <ItemTile
      key={key}
      item={item}
      options={props.options}
      sizes={sizes}
      timeText={itemTime(item.time, locale, timeZone, now)}
      noImage={t("noImage")}
      imageAlt={t("image")}
    />
  );
  return (
    <article
      ref={ref}
      className={`sw sw-items${rotating ? " sw-items-rotate" : ""}`}
      aria-busy={props.loading ?? false}
    >
      <WidgetLabel layout={label} />
      {shown.length ? (
        <ul
          className="sw-items-list"
          style={
            rotating
              ? undefined
              : {
                  gridTemplateColumns: `repeat(${grid.columns}, minmax(0, 1fr))`,
                  gridTemplateRows: `repeat(${grid.rows}, minmax(0, 1fr))`,
                  gap: u(ITEMS_GAP),
                }
          }
          aria-live={rotating ? "off" : undefined}
        >
          {rotating
            ? tile(shown[0]!, index)
            : shown.map((item, at) => tile(item, at))}
        </ul>
      ) : (
        <p
          className="sw-placeholder sw-items-empty"
          style={{ fontSize: u(sizes.body) }}
        >
          {props.loading ? "…" : t("empty")}
        </p>
      )}
      {props.error && props.audience !== "viewer" ? (
        <WidgetNotice size={sizes.cell}>{t("unavailable")}</WidgetNotice>
      ) : null}
    </article>
  );
}

/** Data items with their images as the Studio and scroll view load them. */
export function workspaceItemViews(
  workspaceId: string,
  data: ItemsWidgetData | null | undefined,
): ItemsWidgetItemView[] {
  return (data?.items ?? []).map((item) => ({
    title: item.title,
    subtitle: item.subtitle,
    time: item.time,
    image: item.image
      ? {
          src: imageContentUrl(workspaceId, item.image),
          width: item.image.width,
          height: item.image.height,
        }
      : null,
  }));
}

/** An items widget's data for signed-in pages: the dashboard's batch, or
 * its own preview where there is none (the Studio's single widget). */
export function useItemsData(
  widget: ItemsWidget,
  env: StudioEnv,
): { data: ItemsWidgetData | null; loading: boolean } {
  const batch = useDashboardData();
  const [data, setData] = useState<ItemsWidgetData | null>(null),
    [loading, setLoading] = useState(true);
  const key = JSON.stringify({
    id: widget.id,
    binding: widget.binding,
    options: widget.options,
    filters: env.dataFilters ?? [],
    values: env.filterValues ?? {},
  });
  const batched = batch?.items !== undefined;
  useEffect(() => {
    if (batched) return;
    let alive = true;
    const input = JSON.parse(key) as {
      id: string;
      binding: ItemsWidget["binding"];
      options: ItemsWidget["options"];
      filters: NonNullable<StudioEnv["dataFilters"]>;
      values: NonNullable<StudioEnv["filterValues"]>;
    };
    async function refresh() {
      setLoading(true);
      try {
        const response = await previewDashboardMeasures(
          env.workspaceId,
          input.filters,
          input.values,
          [],
          [{ id: input.id, binding: input.binding, options: input.options }],
        );
        if (alive) setData(response.items[0] ?? null);
      } catch {
        if (alive)
          setData({
            widgetId: input.id,
            status: "no_data",
            items: [],
            error: "data_storage_failed",
            exclusions: input.binding.exclusions,
          });
      } finally {
        if (alive) setLoading(false);
      }
    }
    setData(null);
    void refresh();
    const timer = setInterval(() => void refresh(), 60000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [env.workspaceId, key, batched]);
  return batched
    ? {
        data: batch!.items!.get(widget.id) ?? null,
        loading: batch!.loading,
      }
    : { data, loading };
}

/** A latest-items widget with its own data, for signed-in pages. */
export function LiveItemsWidget({
  widget,
  env,
}: {
  widget: ItemsWidget &
    Partial<Pick<ScreenPlacement, "unitBox" | "unitPx" | "format">>;
  env: StudioEnv;
}) {
  const locale = useLocale();
  const { data, loading } = useItemsData(widget, env);
  return (
    <ItemsWidgetView
      label={itemsWidgetLabel(widget.title, locale)}
      items={workspaceItemViews(env.workspaceId, data)}
      options={widget.options}
      status={data?.status ?? "no_data"}
      placement={widget}
      showHeader={env.showHeader}
      fontScale={env.fontScale}
      audience={env.audience ?? "editor"}
      error={data?.error ?? null}
      loading={loading}
    />
  );
}
