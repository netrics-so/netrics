"use client";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  DashboardWidget,
  DashboardWidgetData,
  ItemsWidgetData,
} from "@netrics/contracts";
import type {
  DashboardDataFilter,
  DashboardFilterValue,
  SlideFilterScope,
} from "@netrics/domain";
import { previewDashboardMeasures } from "@/lib/dashboard-data-api";
const Context = createContext<{
  widgets: ReadonlyMap<string, DashboardWidgetData>;
  /** Latest-items widgets' data (#810); absent in older test doubles. */
  items?: ReadonlyMap<string, ItemsWidgetData>;
  loading: boolean;
} | null>(null);
export const useDashboardData = () => useContext(Context);

type MeasureWidget = Extract<DashboardWidget, { type: "measure" }>;
/** A measure widget as queried: with its slide's scope (#707). */
type MeasureQuery = Pick<MeasureWidget, "id" | "binding" | "options"> & {
  scope?: SlideFilterScope;
};
type ItemsWidget = Extract<DashboardWidget, { type: "items" }>;
/** A latest-items widget as queried (#810), with its slide's scope. */
type ItemsQuery = Pick<ItemsWidget, "id" | "binding" | "options"> & {
  scope?: SlideFilterScope;
};

/**
 * The latest-items widgets after a failed load (#810): with `keepLastGood`
 * each one's last items, else none, with the error.
 */
export function failedItems(
  widgets: readonly Pick<ItemsWidget, "id" | "binding">[],
  previous: ReadonlyMap<string, ItemsWidgetData> | undefined,
  keepLastGood: boolean,
): Map<string, ItemsWidgetData> {
  return new Map(
    widgets.map((widget) => {
      const last = keepLastGood ? previous?.get(widget.id) : undefined;
      return [
        widget.id,
        last && !last.error
          ? last
          : {
              widgetId: widget.id,
              status: "no_data",
              items: [],
              error: "data_storage_failed",
              exclusions: widget.binding.exclusions,
            },
      ];
    }),
  );
}

/**
 * One load of the dashboard's measure tiles: the tiles by id, and the
 * load's time reported to `onLoaded`; null when the request failed.
 */
export async function loadDashboardData(
  load: () => Promise<{ widgets: DashboardWidgetData[] }>,
  onLoaded: (at: number) => void,
  now: () => number = Date.now,
): Promise<Map<string, DashboardWidgetData> | null> {
  try {
    const response = await load();
    onLoaded(now());
    return new Map(response.widgets.map((widget) => [widget.widgetId, widget]));
  } catch {
    return null;
  }
}

/**
 * The tiles after a failed load: an error on each, or, with
 * `keepLastGood` (wall screens, #681), each tile's last good result marked
 * stale ("Last valid data"), as the kiosk keeps its payload.
 */
export function failedWidgets(
  widgets: readonly Pick<MeasureWidget, "id" | "binding">[],
  previous: ReadonlyMap<string, DashboardWidgetData> | undefined,
  keepLastGood: boolean,
): Map<string, DashboardWidgetData> {
  return new Map(
    widgets.map((widget) => {
      const last = keepLastGood ? previous?.get(widget.id) : undefined;
      return [
        widget.id,
        last?.result && !last.error
          ? { ...last, result: { ...last.result, stale: true } }
          : {
              widgetId: widget.id,
              metadata: null,
              result: null,
              error: "data_storage_failed",
              exclusions: widget.binding.exclusions,
            },
      ];
    }),
  );
}
export function DashboardDataProvider({
  workspaceId,
  slides,
  filters = [],
  values = {},
  onLoaded,
  keepLastGood = false,
  children,
}: {
  workspaceId: string;
  /** The slides whose measure widgets to load, each with its scope. */
  slides: readonly {
    scope?: SlideFilterScope;
    widgets: readonly DashboardWidget[];
  }[];
  filters?: DashboardDataFilter[];
  values?: Record<string, DashboardFilterValue>;
  /**
   * Called with the time of each successful load: a wall screen's offline
   * note says when its data last updated (#681).
   */
  onLoaded?: (at: number) => void;
  /**
   * A failed load keeps each tile's last good result, marked stale ("Last
   * valid data"), instead of an error on every tile: a wall screen that
   * lost its network keeps its numbers, as the kiosk does (#681). Editor
   * surfaces show the error.
   */
  keepLastGood?: boolean;
  children: ReactNode;
}) {
  const loaded = useRef(onLoaded);
  useEffect(() => {
    loaded.current = onLoaded;
  });
  const key = JSON.stringify({
    widgets: slides.flatMap((slide) =>
      slide.widgets.flatMap((widget): MeasureQuery[] =>
        widget.type === "measure"
          ? [
              {
                id: widget.id,
                binding: widget.binding,
                options: widget.options,
                ...(slide.scope && Object.keys(slide.scope).length
                  ? { scope: slide.scope }
                  : {}),
              },
            ]
          : [],
      ),
    ),
    items: slides.flatMap((slide) =>
      slide.widgets.flatMap((widget): ItemsQuery[] =>
        widget.type === "items"
          ? [
              {
                id: widget.id,
                binding: widget.binding,
                options: widget.options,
                ...(slide.scope && Object.keys(slide.scope).length
                  ? { scope: slide.scope }
                  : {}),
              },
            ]
          : [],
      ),
    ),
    filters,
    values,
  });
  const [state, setState] = useState<{
    key: string;
    widgets: Map<string, DashboardWidgetData>;
    items: Map<string, ItemsWidgetData>;
    loading: boolean;
  }>({ key, widgets: new Map(), items: new Map(), loading: true });
  useEffect(() => {
    let alive = true;
    const input = JSON.parse(key) as {
      widgets: MeasureQuery[];
      items: ItemsQuery[];
      filters: DashboardDataFilter[];
      values: Record<string, DashboardFilterValue>;
    };
    async function refresh() {
      if (!input.widgets.length && !input.items.length) {
        if (alive)
          setState({
            key,
            widgets: new Map(),
            items: new Map(),
            loading: false,
          });
        return;
      }
      if (alive)
        setState((state) => ({
          key,
          widgets: state.key === key ? state.widgets : new Map(),
          items: state.key === key ? state.items : new Map(),
          loading: true,
        }));
      let items = new Map<string, ItemsWidgetData>();
      const result = await loadDashboardData(
        async () => {
          const response = await previewDashboardMeasures(
            workspaceId,
            input.filters,
            input.values,
            input.widgets,
            input.items,
          );
          items = new Map(response.items.map((data) => [data.widgetId, data]));
          return response;
        },
        (at) => loaded.current?.(at),
      );
      if (!alive) return;
      if (result) {
        setState({ key, widgets: result, items, loading: false });
      } else {
        setState((state) => ({
          key,
          widgets: failedWidgets(
            input.widgets,
            state.key === key ? state.widgets : undefined,
            keepLastGood,
          ),
          items: failedItems(
            input.items,
            state.key === key ? state.items : undefined,
            keepLastGood,
          ),
          loading: false,
        }));
      }
    }
    const first = setTimeout(() => void refresh(), 100),
      interval = setInterval(() => void refresh(), 60000);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [workspaceId, key, keepLastGood]);
  return (
    <Context
      value={
        state.key === key
          ? state
          : { widgets: new Map(), items: new Map(), loading: true }
      }
    >
      {children}
    </Context>
  );
}
